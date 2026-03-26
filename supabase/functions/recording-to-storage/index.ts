import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decodeGsmWav, createPcmWav } from "../_shared/gsm-decode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 10;
const SUPABASE_URL = "https://rzvuzdwhvahwqqhzmuli.supabase.co";

/**
 * Convert any WAV (PCM, GSM, μ-law, A-law) to browser-playable PCM WAV.
 * If already PCM, returns the original buffer unchanged.
 */
function toPlayableWav(wavBuffer: ArrayBuffer): { data: Uint8Array; contentType: string; ext: string } {
  const view = new DataView(wavBuffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") {
    throw new Error(`Not a WAV file (header: ${riff})`);
  }

  const audioFormat = view.getUint16(20, true);

  // GSM 6.10 (format 0x0031 = 49) → decode to PCM WAV
  if (audioFormat === 0x0031) {
    const { sampleRate, samples } = decodeGsmWav(wavBuffer);
    return { data: createPcmWav(samples, sampleRate), contentType: "audio/wav", ext: "wav" };
  }

  // PCM (format 1) — already playable, pass through
  if (audioFormat === 1) {
    return { data: new Uint8Array(wavBuffer), contentType: "audio/wav", ext: "wav" };
  }

  // μ-law (7) or A-law (6) → decode to PCM WAV
  if (audioFormat === 6 || audioFormat === 7) {
    const numChannels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    let dataOffset = 12;
    while (dataOffset < view.byteLength - 8) {
      const id = String.fromCharCode(view.getUint8(dataOffset), view.getUint8(dataOffset+1), view.getUint8(dataOffset+2), view.getUint8(dataOffset+3));
      const sz = view.getUint32(dataOffset + 4, true);
      if (id === "data") { dataOffset += 8; break; }
      dataOffset += 8 + sz;
    }
    const numSamples = Math.floor((wavBuffer.byteLength - dataOffset) / numChannels);
    const samples = new Int16Array(numSamples);
    const decode = audioFormat === 7 ? ulawDecode : alawDecode;
    for (let i = 0; i < numSamples; i++) {
      samples[i] = decode(view.getUint8(dataOffset + i));
    }
    return { data: createPcmWav(samples, sampleRate), contentType: "audio/wav", ext: "wav" };
  }

  throw new Error(`Unsupported WAV format: fmt=${audioFormat}`);
}

function ulawDecode(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exp;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function alawDecode(a: number): number {
  a ^= 0x55;
  const sign = a & 0x80;
  const exp = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  const sample = exp === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exp - 1);
  return sign ? sample : -sample;
}

/**
 * Generate a Google Drive access token from a service account key.
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
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: serviceAccountKey.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const unsignedToken = `${b64url(header)}.${b64url(claims)}`;

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN") || null;

    // Load Google service account key for downloading from GDrive
    const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!saKeyRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    const saKey = JSON.parse(saKeyRaw);

    // ── Phase 1: Convert recordings with gdrive_file_id but no storage_url ──
    const { data: needConversion, error: convError } = await supabase
      .from("call_recordings")
      .select("id, gdrive_file_id, call_duration_seconds, hubspot_call_id, agent_id")
      .eq("backup_status", "uploaded")
      .not("gdrive_file_id", "is", null)
      .is("storage_url", null)
      .order("call_start", { ascending: false })
      .limit(BATCH_SIZE);

    if (convError) throw new Error(`Query failed: ${convError.message}`);

    let converted = 0;
    let convFailed = 0;
    const convErrors: Array<{ id: string; error: string }> = [];

    if (needConversion && needConversion.length > 0) {
      console.log(`Converting ${needConversion.length} recordings (GDrive WAV → MP3)...`);
      const googleToken = await getGoogleAccessToken(saKey);

      for (const rec of needConversion) {
        try {
          // Download WAV from Google Drive
          const dlRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${rec.gdrive_file_id}?alt=media&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${googleToken}` } }
          );

          if (!dlRes.ok) {
            const errBody = await dlRes.text().catch(() => "");
            const msg = `GDrive download failed (${dlRes.status}): ${errBody.substring(0, 200)}`;
            console.error(`  ${rec.id}: ${msg}`);
            convErrors.push({ id: rec.id, error: msg });
            convFailed++;
            continue;
          }

          const wavBuffer = await dlRes.arrayBuffer();
          if (wavBuffer.byteLength < 1024) {
            const msg = `File too small (${wavBuffer.byteLength} bytes)`;
            console.error(`  ${rec.id}: ${msg}`);
            convErrors.push({ id: rec.id, error: msg });
            convFailed++;
            continue;
          }

          // Convert to browser-playable WAV (PCM passthrough, or GSM/μ-law/A-law → PCM)
          const { data: audioData, contentType, ext } = toPlayableWav(wavBuffer);
          console.log(`  ${rec.id}: ${wavBuffer.byteLength} → ${audioData.byteLength} ${ext}`);

          // Upload to Supabase Storage
          const storagePath = `${rec.gdrive_file_id}.${ext}`;
          const uploadRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/call-recordings/${storagePath}`,
            {
              method: "POST",
              headers: {
                apikey: Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "",
                Authorization: `Bearer ${Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""}`,
                "Content-Type": contentType,
                "x-upsert": "true",
              },
              body: audioData,
            }
          );

          if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            const msg = `Storage upload failed (${uploadRes.status}): ${errText.substring(0, 200)}`;
            console.error(`  ${rec.id}: ${msg}`);
            convErrors.push({ id: rec.id, error: msg });
            convFailed++;
            continue;
          }

          const storageUrl = `${SUPABASE_URL}/storage/v1/object/public/call-recordings/${storagePath}`;

          await supabase
            .from("call_recordings")
            .update({ storage_url: storageUrl })
            .eq("id", rec.id);

          console.log(`  ${rec.id}: Done → ${storageUrl}`);
          converted++;
        } catch (err) {
          console.error(`  ${rec.id}: Error: ${err.message}`);
          convErrors.push({ id: rec.id, error: err.message });
          convFailed++;
        }
      }
    }

    // ── Phase 2: Sync storage_url to HubSpot for recordings not yet synced ──
    let hsSynced = 0;
    let hsFailed = 0;

    if (hubspotAccessToken) {
      const { data: pending, error: fetchError } = await supabase
        .from("call_recordings")
        .select("id, hubspot_call_id, agent_id, storage_url")
        .eq("backup_status", "uploaded")
        .not("storage_url", "is", null)
        .not("hubspot_call_id", "is", null)
        .is("hubspot_updated_at", null)
        .order("call_start", { ascending: false })
        .limit(BATCH_SIZE);

      if (fetchError) throw new Error(`HubSpot query failed: ${fetchError.message}`);

      if (pending && pending.length > 0) {
        console.log(`Syncing ${pending.length} recordings to HubSpot...`);

        for (const rec of pending) {
          try {
            let hubspotOwnerId: string | null = null;
            if (rec.agent_id) {
              const { data: agentMap } = await supabase
                .from("agent_mappings")
                .select("hubspot_owner_id")
                .eq("ringcx_agent_id", rec.agent_id)
                .maybeSingle();
              hubspotOwnerId = agentMap?.hubspot_owner_id || null;
            }

            const hsProperties: Record<string, string> = {
              hs_call_recording_url: rec.storage_url,
            };
            if (hubspotOwnerId) {
              hsProperties.hubspot_owner_id = hubspotOwnerId;
            }

            const hsRes = await fetch(
              `https://api.hubapi.com/crm/v3/objects/calls/${rec.hubspot_call_id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${hubspotAccessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ properties: hsProperties }),
              }
            );

            if (hsRes.ok) {
              await supabase
                .from("call_recordings")
                .update({ hubspot_updated_at: new Date().toISOString() })
                .eq("id", rec.id);
              hsSynced++;
            } else {
              const errText = await hsRes.text();
              console.error(`  ${rec.hubspot_call_id} HubSpot failed: ${errText.substring(0, 200)}`);
              hsFailed++;
            }
          } catch (err) {
            console.error(`  ${rec.id} error: ${err.message}`);
            hsFailed++;
          }
        }
      }
    } else {
      console.warn("HUBSPOT_ACCESS_TOKEN not set — skipping HubSpot sync");
    }

    const message = [
      converted > 0 ? `${converted} converted` : null,
      convFailed > 0 ? `${convFailed} conversion failures` : null,
      hsSynced > 0 ? `${hsSynced} synced to HubSpot` : null,
      hsFailed > 0 ? `${hsFailed} HubSpot failures` : null,
    ].filter(Boolean).join(", ") || "Nothing to process";

    console.log(`Done: ${message}`);

    return new Response(
      JSON.stringify({ success: true, converted, convFailed, hsSynced, hsFailed, message, errors: convErrors.slice(0, 5) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
