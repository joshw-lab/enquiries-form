import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRingCentralAccessToken } from "../_shared/ringcx-lead-loader-base.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Max recordings to process per invocation (avoid timeout)
const BATCH_SIZE = 10;

// Max retry attempts before marking as failed
const MAX_ATTEMPTS = 3;

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
      .order("call_start", { ascending: true })
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

    // Get Google Drive access token (reuse for entire batch)
    const googleAccessToken = await getGoogleAccessToken(serviceAccountKey);

    // Get RingCX access token for downloading recordings (requires auth)
    const { token: ringcxToken, error: ringcxAuthError } =
      await getRingCentralAccessToken(supabaseClient);
    if (!ringcxToken) {
      throw new Error(`RingCX auth failed: ${ringcxAuthError}`);
    }

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const results: Array<{ call_id: string; status: string; error?: string }> = [];

    for (const recording of pendingRecordings) {
      try {
        console.log(`\n📼 Processing: ${recording.call_id}`);

        // Mark as downloading
        await supabaseClient
          .from("call_recordings")
          .update({
            backup_status: "downloading",
            backup_attempts: (recording.backup_attempts || 0) + 1,
          })
          .eq("id", recording.id);

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

        // Download the WAV from RingCX (requires authenticated session)
        console.log(`  Downloading from RingCX...`);
        const downloadResponse = await fetch(recording.ringcx_recording_url, {
          headers: {
            Authorization: `Bearer ${ringcxToken}`,
          },
        });

        if (!downloadResponse.ok) {
          throw new Error(`Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`);
        }

        // Verify we got audio, not an HTML login page
        const contentType = downloadResponse.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          throw new Error("RingCX returned HTML instead of audio — auth may have expired");
        }

        const audioData = await downloadResponse.arrayBuffer();
        const fileSizeMB = (audioData.byteLength / 1024 / 1024).toFixed(2);
        console.log(`  Downloaded ${fileSizeMB} MB (${contentType})`);

        // Build filename
        const fileName = buildFileName(recording);
        console.log(`  Target: ${fileName}`);

        // Upload to Google Drive (flat — all files in root folder)
        console.log(`  Uploading to Google Drive...`);
        const uploadResult = await uploadToGoogleDrive(
          googleAccessToken,
          audioData,
          fileName,
          driveFolderId
        );

        console.log(`  ✅ Uploaded: ${uploadResult.webViewLink}`);

        // Set file-level permission: anyone with the link can view
        const permResponse = await fetch(
          `https://www.googleapis.com/drive/v3/files/${uploadResult.fileId}/permissions?supportsAllDrives=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${googleAccessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              role: "reader",
              type: "anyone",
            }),
          }
        );
        if (!permResponse.ok) {
          const permErr = await permResponse.text();
          console.error(`  ⚠️ Failed to set public permission (non-fatal): ${permErr}`);
        } else {
          console.log(`  🔓 File set to "anyone with link can view"`);
        }

        // Update record with success
        await supabaseClient
          .from("call_recordings")
          .update({
            backup_status: "uploaded",
            gdrive_file_id: uploadResult.fileId,
            gdrive_file_url: uploadResult.webViewLink,
            gdrive_file_name: fileName,
            backed_up_at: new Date().toISOString(),
          })
          .eq("id", recording.id);

        // Update HubSpot call recording URL with streaming proxy (supports Range/206 for native player)
        if (recording.hubspot_call_id && hubspotAccessToken) {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const streamingUrl = `${supabaseUrl}/functions/v1/recording-stream?id=${uploadResult.fileId}`;
          try {
            const hsResponse = await fetch(
              `https://api.hubapi.com/crm/v3/objects/calls/${recording.hubspot_call_id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${hubspotAccessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  properties: {
                    hs_call_recording_url: streamingUrl,
                  },
                }),
              }
            );
            if (hsResponse.ok) {
              console.log(`  📞 HubSpot call ${recording.hubspot_call_id} recording URL updated`);
            } else {
              const hsErr = await hsResponse.text();
              console.error(`  ⚠️ HubSpot update failed (non-fatal): ${hsErr}`);
            }
          } catch (hsError) {
            console.error(`  ⚠️ HubSpot update error (non-fatal): ${hsError.message}`);
          }
        }

        results.push({ call_id: recording.call_id, status: "uploaded" });
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
