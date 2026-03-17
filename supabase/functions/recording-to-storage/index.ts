import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const gdriveFileId = body.gdrive_file_id;
    const recordingId = body.recording_id;

    if (!gdriveFileId) throw new Error("gdrive_file_id required");

    // Init clients
    const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!saKeyRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    const saKey = JSON.parse(saKeyRaw);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // 1. Get Google access token
    const googleToken = await getGoogleAccessToken(saKey);

    // 2. Download file from Google Drive
    console.log(`Downloading ${gdriveFileId} from Google Drive...`);
    const driveResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${gdriveFileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    );

    if (!driveResponse.ok) {
      const err = await driveResponse.text();
      throw new Error(`Drive download failed (${driveResponse.status}): ${err}`);
    }

    const wavData = await driveResponse.arrayBuffer();
    const wavSize = wavData.byteLength;
    console.log(`Downloaded WAV: ${(wavSize / 1024).toFixed(1)} KB`);

    // 3. Upload WAV to Supabase Storage
    const storagePath = `${gdriveFileId}.wav`;
    const { error: uploadError } = await supabase.storage
      .from("call-recordings")
      .upload(storagePath, wavData, {
        contentType: "audio/wav",
        upsert: true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    // 4. Get public URL
    const { data: urlData } = supabase.storage
      .from("call-recordings")
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;
    console.log(`Uploaded to Supabase Storage: ${publicUrl}`);

    // 5. Update call_recordings if recording_id provided
    if (recordingId) {
      await supabase
        .from("call_recordings")
        .update({ storage_url: publicUrl })
        .eq("id", recordingId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        gdriveFileId,
        storagePath,
        publicUrl,
        wavSizeBytes: wavSize,
        wavSizeKB: Math.round(wavSize / 1024),
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
