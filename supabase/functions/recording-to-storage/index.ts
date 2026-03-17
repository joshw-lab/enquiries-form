import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Max recordings to process per batch invocation
const BATCH_SIZE = 10;

/**
 * Google Drive access token via service account JWT flow.
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
    scope: "https://www.googleapis.com/auth/drive",
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

/**
 * Process a single recording: GDrive → Supabase Storage → update DB + HubSpot.
 */
async function processRecording(
  rec: { id: string; gdrive_file_id: string; hubspot_call_id: string | null },
  googleToken: string,
  supabase: ReturnType<typeof createClient>,
  hubspotAccessToken: string | null,
): Promise<{ id: string; status: string; error?: string; sizeKB?: number }> {
  try {
    // Download from Google Drive
    const driveResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${rec.gdrive_file_id}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    );

    if (!driveResponse.ok) {
      const err = await driveResponse.text();
      throw new Error(`Drive download failed (${driveResponse.status}): ${err.substring(0, 200)}`);
    }

    const wavData = await driveResponse.arrayBuffer();
    const sizeKB = Math.round(wavData.byteLength / 1024);

    // Upload to Supabase Storage
    const storagePath = `${rec.gdrive_file_id}.wav`;
    const { error: uploadError } = await supabase.storage
      .from("call-recordings")
      .upload(storagePath, wavData, {
        contentType: "audio/wav",
        upsert: true,
      });

    if (uploadError) throw new Error(`Storage upload: ${uploadError.message}`);

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("call-recordings")
      .getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // Update call_recordings
    await supabase
      .from("call_recordings")
      .update({ storage_url: publicUrl })
      .eq("id", rec.id);

    // Update HubSpot
    if (rec.hubspot_call_id && hubspotAccessToken) {
      try {
        const hsRes = await fetch(
          `https://api.hubapi.com/crm/v3/objects/calls/${rec.hubspot_call_id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${hubspotAccessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              properties: { hs_call_recording_url: publicUrl },
            }),
          }
        );
        if (!hsRes.ok) {
          console.error(`HubSpot update failed for ${rec.hubspot_call_id}: ${await hsRes.text()}`);
        }
      } catch (e) {
        console.error(`HubSpot error: ${e.message}`);
      }
    }

    return { id: rec.id, status: "uploaded", sizeKB };
  } catch (err) {
    return { id: rec.id, status: "failed", error: err.message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // Init clients
    const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!saKeyRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    const saKey = JSON.parse(saKeyRaw);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const googleToken = await getGoogleAccessToken(saKey);
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN") || null;

    // ── Single mode: process one specific recording ──
    if (body.gdrive_file_id) {
      const result = await processRecording(
        {
          id: body.recording_id || "",
          gdrive_file_id: body.gdrive_file_id,
          hubspot_call_id: body.hubspot_call_id || null,
        },
        googleToken,
        supabase,
        hubspotAccessToken,
      );

      return new Response(
        JSON.stringify({ success: result.status === "uploaded", ...result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Batch mode: find recordings with gdrive_file_id but no storage_url ──
    const { data: pending, error: fetchError } = await supabase
      .from("call_recordings")
      .select("id, gdrive_file_id, hubspot_call_id")
      .eq("backup_status", "uploaded")
      .not("gdrive_file_id", "is", null)
      .is("storage_url", null)
      .order("call_start", { ascending: false })
      .limit(BATCH_SIZE);

    if (fetchError) throw new Error(`Query failed: ${fetchError.message}`);

    if (!pending || pending.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No recordings to process", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${pending.length} recordings...`);

    let succeeded = 0;
    let failed = 0;
    let totalSizeKB = 0;
    const results: Array<{ id: string; status: string; error?: string; sizeKB?: number }> = [];

    for (const rec of pending) {
      const result = await processRecording(rec, googleToken, supabase, hubspotAccessToken);
      results.push(result);
      if (result.status === "uploaded") {
        succeeded++;
        totalSizeKB += result.sizeKB || 0;
      } else {
        failed++;
      }
    }

    console.log(`Done: ${succeeded} uploaded (${totalSizeKB} KB), ${failed} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: pending.length,
        succeeded,
        failed,
        totalSizeKB,
        results,
      }),
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
