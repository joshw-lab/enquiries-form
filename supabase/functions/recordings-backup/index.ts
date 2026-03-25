import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import lamejs from "https://esm.sh/lamejs@1.2.1";
import { getRingCentralAccessToken } from "../_shared/ringcx-lead-loader-base.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Max recordings to process per invocation (avoid timeout)
const BATCH_SIZE = 25;

// Dispositions where no meaningful conversation occurred — skip recording backup
const SKIP_DISPOSITIONS = new Set([
  "No Answer",
  "No-Answer",
  "Busy",
  "Dead Air",
  "Dead-Air",
  "Hang Up",
  "Hang-Up",
  "Machine",
  "Answering Machine",
  "Answering-Machine",
  "Left Voicemail",
]);

// Max retry attempts before marking as failed
const MAX_ATTEMPTS = 3;

// Max call duration (seconds) for inline MP3 conversion in Edge Function.
// Longer calls are left for the VM pipeline.
const INLINE_CONVERT_MAX_SECONDS = 300; // 5 minutes

/**
 * Convert WAV (ArrayBuffer) to MP3 using lamejs.
 * Handles mono/stereo, various sample rates from RingCX WAV files.
 * Returns MP3 as Uint8Array.
 */
function wavToMp3(wavBuffer: ArrayBuffer): Uint8Array {
  const view = new DataView(wavBuffer);

  // Parse WAV header
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find data chunk (skip past header — data starts after "data" + size)
  let dataOffset = 12; // skip RIFF header
  while (dataOffset < view.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(dataOffset),
      view.getUint8(dataOffset + 1),
      view.getUint8(dataOffset + 2),
      view.getUint8(dataOffset + 3)
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === "data") {
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  // Read PCM samples as Int16
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((wavBuffer.byteLength - dataOffset) / (bytesPerSample * numChannels));

  // Extract samples per channel
  const left = new Int16Array(numSamples);
  const right = numChannels > 1 ? new Int16Array(numSamples) : null;

  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * numChannels * bytesPerSample;
    if (bitsPerSample === 16) {
      left[i] = view.getInt16(offset, true);
      if (right) right[i] = view.getInt16(offset + 2, true);
    } else if (bitsPerSample === 8) {
      // 8-bit WAV is unsigned, convert to signed 16-bit
      left[i] = (view.getUint8(offset) - 128) << 8;
      if (right) right[i] = (view.getUint8(offset + 1) - 128) << 8;
    }
  }

  // Encode to MP3 (32kbps for phone-quality audio)
  const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 32);
  const mp3Chunks: Uint8Array[] = [];
  const blockSize = 1152;

  for (let i = 0; i < numSamples; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    let mp3buf: Int8Array;
    if (numChannels === 1) {
      mp3buf = mp3Encoder.encodeBuffer(leftChunk);
    } else {
      const rightChunk = right!.subarray(i, i + blockSize);
      mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
    }
    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf.buffer, mp3buf.byteOffset, mp3buf.byteLength));
    }
  }

  // Flush remaining
  const flushBuf = mp3Encoder.flush();
  if (flushBuf.length > 0) {
    mp3Chunks.push(new Uint8Array(flushBuf.buffer, flushBuf.byteOffset, flushBuf.byteLength));
  }

  // Concatenate all chunks
  const totalLength = mp3Chunks.reduce((sum, c) => sum + c.length, 0);
  const mp3Data = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    mp3Data.set(chunk, offset);
    offset += chunk.length;
  }

  return mp3Data;
}

/**
 * Generate a Google Drive access token from a service account key.
 * Uses JWT assertion flow (no external libraries needed).
 */
async function getGoogleAccessToken(serviceAccountKey: {
  client_email: string;
  private_key: string;
  token_uri: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccountKey.client_email,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: serviceAccountKey.token_uri,
    iat: now,
    exp: now + 3600,
  };

  // Base64url encode
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const unsignedToken = `${b64url(header)}.${b64url(claims)}`;

  // Import the private key and sign
  const pemContents = serviceAccountKey.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${unsignedToken}.${signatureB64}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch(serviceAccountKey.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

/**
 * Upload a file to Google Drive using resumable upload.
 * Returns the file ID and web view link.
 */
async function uploadToGoogleDrive(
  accessToken: string,
  fileData: ArrayBuffer,
  fileName: string,
  folderId: string,
  mimeType = "audio/wav"
): Promise<{ fileId: string; webViewLink: string }> {
  // Step 1: Initiate resumable upload with metadata
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType,
  };

  const initResponse = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": fileData.byteLength.toString(),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initResponse.ok) {
    const err = await initResponse.text();
    throw new Error(`Drive upload init failed: ${err}`);
  }

  const uploadUri = initResponse.headers.get("Location");
  if (!uploadUri) throw new Error("No upload URI returned from Drive");

  // Step 2: Upload the file data
  const uploadResponse = await fetch(uploadUri, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": fileData.byteLength.toString(),
    },
    body: fileData,
  });

  if (!uploadResponse.ok) {
    const err = await uploadResponse.text();
    throw new Error(`Drive file upload failed: ${err}`);
  }

  const fileResult = await uploadResponse.json();
  return {
    fileId: fileResult.id,
    webViewLink: fileResult.webViewLink || `https://drive.google.com/file/d/${fileResult.id}/view`,
  };
}

/**
 * Clean up agent name for use in filenames.
 * If the name looks like an email, extract and title-case the local part.
 */
function cleanAgentName(name: string): string {
  if (!name) return "Unknown";

  // If it looks like an email, extract the local part
  if (name.includes("@")) {
    let local = name.split("@")[0];
    // Strip +suffix (e.g. josh.w+12345 -> josh.w)
    local = local.replace(/\+.*$/, "");
    // Split on . or _ and title-case each part
    return local
      .split(/[._]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join("-");
  }

  return name;
}

/**
 * Build file name from recording metadata.
 * Format: YYYY-MM-DD_HHMM_AgentName_Disposition_Phone.wav
 */
function buildFileName(recording: {
  call_start: string;
  agent_name: string;
  disposition: string;
  phone_number: string;
  call_id: string;
}): string {
  const date = new Date(recording.call_start);
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeStr = date.toISOString().slice(11, 16).replace(":", ""); // HHMM

  // Sanitize parts for filename safety
  const sanitize = (s: string) =>
    (s || "Unknown")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .trim();

  const agent = sanitize(cleanAgentName(recording.agent_name));
  const disposition = sanitize(recording.disposition);
  const phone = (recording.phone_number || "").replace(/[^0-9+]/g, "");

  return `${dateStr}_${timeStr}_${agent}_${disposition}_${phone}.wav`;
}

// Main handler
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Load Google service account key from secret
    const serviceAccountKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!serviceAccountKeyRaw) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY secret not configured");
    }
    const serviceAccountKey = JSON.parse(serviceAccountKeyRaw);

    // Google Drive root folder ID from secret
    const driveFolderId = Deno.env.get("GDRIVE_RECORDINGS_FOLDER_ID");
    if (!driveFolderId) {
      throw new Error("GDRIVE_RECORDINGS_FOLDER_ID secret not configured");
    }

    // HubSpot access token (optional — used to update call recording URL)
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotAccessToken) {
      console.warn("HUBSPOT_ACCESS_TOKEN not set — HubSpot recording URLs won't be updated");
    }

    // Fetch pending recordings that need backup
    const { data: pendingRecordings, error: fetchError } = await supabaseClient
      .from("call_recordings")
      .select("*")
      .eq("backup_status", "pending")
      .lt("backup_attempts", MAX_ATTEMPTS)
      .order("call_start", { ascending: false })
      .limit(BATCH_SIZE);

    if (fetchError) {
      throw new Error(`Failed to fetch pending recordings: ${fetchError.message}`);
    }

    if (!pendingRecordings || pendingRecordings.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No pending recordings to process", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${pendingRecordings.length} pending recordings...`);

    // This function now only handles disposition triage.
    // Recording downloads come via SFTP → GDrive → VM pipeline.
    // The recordings-backfill function matches GDrive files to call_recordings rows.

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const results: Array<{ call_id: string; status: string; error?: string }> = [];

    for (const recording of pendingRecordings) {
      try {
        console.log(`\n📼 Processing: ${recording.call_id}`);

        // Skip non-conversation dispositions (No Answer, Busy, etc.)
        if (recording.disposition && SKIP_DISPOSITIONS.has(recording.disposition)) {
          console.log(`  Skipping "${recording.disposition}" — no conversation`);
          await supabaseClient
            .from("call_recordings")
            .update({ backup_status: "no_recording" })
            .eq("id", recording.id);
          results.push({ call_id: recording.call_id, status: "no_recording" });
          processed++;
          continue;
        }

        if (!recording.ringcx_recording_url) {
          console.log(`  No recording URL — marking as no_recording`);
          await supabaseClient
            .from("call_recordings")
            .update({ backup_status: "no_recording" })
            .eq("id", recording.id);
          results.push({ call_id: recording.call_id, status: "no_recording" });
          processed++;
          continue;
        }

        // Recording has a URL and a meaningful disposition — mark as awaiting_gdrive.
        // The SFTP pipeline delivers WAV files to GDrive, and recordings-backfill
        // matches them to this row (setting gdrive_file_id and backup_status=uploaded).
        console.log(`  Awaiting GDrive match (disposition: ${recording.disposition}, ${recording.call_duration_seconds}s)`);
        await supabaseClient
          .from("call_recordings")
          .update({ backup_status: "awaiting_gdrive" })
          .eq("id", recording.id);

        // HubSpot sync is handled by the recording-to-storage function
        // after the VM converts WAV→MP3 and sets storage_url.

        results.push({
          call_id: recording.call_id,
          status: convertedInline ? "uploaded+mp3+synced" : "uploaded",
        });
        succeeded++;
      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
        const attempts = (recording.backup_attempts || 0) + 1;
        await supabaseClient
          .from("call_recordings")
          .update({
            backup_status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            backup_error: err.message,
          })
          .eq("id", recording.id);

        results.push({ call_id: recording.call_id, status: "failed", error: err.message });
        failed++;
      }

      processed++;
    }

    console.log(`\n📊 Batch complete: ${succeeded} uploaded, ${failed} failed, ${processed} total`);

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        succeeded,
        failed,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Recordings backup error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
