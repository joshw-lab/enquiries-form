import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

/**
 * Audio streaming proxy for call recordings stored in Google Drive.
 *
 * HubSpot's native call player requires HTTP Range request support (206 Partial Content).
 * Google Drive's /uc?export=download URLs don't support Range requests properly —
 * they return HTML redirects or full 200 responses.
 *
 * This function:
 *   1. Looks up the recording by gdrive_file_id from the call_recordings table
 *   2. Uses the Google Drive API (with service account auth) to stream the file
 *   3. Supports Range requests so HubSpot's player can seek/scrub
 *
 * Usage: GET /recording-stream?id={gdrive_file_id}
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
    const url = new URL(req.url);
    const fileId = url.searchParams.get("id");

    if (!fileId) {
      return new Response(
        JSON.stringify({ error: "Missing id parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate that this file ID exists in our call_recordings table
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: recording, error: dbError } = await supabaseClient
      .from("call_recordings")
      .select("gdrive_file_id, gdrive_file_name")
      .eq("gdrive_file_id", fileId)
      .eq("backup_status", "uploaded")
      .single();

    if (dbError || !recording) {
      return new Response(
        JSON.stringify({ error: "Recording not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Google access token
    const serviceAccountKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!serviceAccountKeyRaw) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
    }
    const serviceAccountKey = JSON.parse(serviceAccountKeyRaw);
    const accessToken = await getGoogleAccessToken(serviceAccountKey);

    // First, get file metadata to know the total size
    const metaResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!metaResponse.ok) {
      const err = await metaResponse.text();
      throw new Error(`Drive metadata failed: ${err}`);
    }

    const meta = await metaResponse.json();
    const totalSize = parseInt(meta.size, 10);
    const mimeType = meta.mimeType || "audio/wav";

    // Check for Range header
    const rangeHeader = req.headers.get("range");

    if (rangeHeader) {
      // Parse range: "bytes=0-1023" or "bytes=0-"
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        return new Response("Invalid Range", {
          status: 416,
          headers: {
            ...corsHeaders,
            "Content-Range": `bytes */${totalSize}`,
          },
        });
      }

      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: {
            ...corsHeaders,
            "Content-Range": `bytes */${totalSize}`,
          },
        });
      }

      // Fetch the range from Google Drive
      const driveResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Range: `bytes=${start}-${end}`,
          },
        }
      );

      const contentLength = end - start + 1;

      return new Response(driveResponse.body, {
        status: 206,
        headers: {
          ...corsHeaders,
          "Content-Type": mimeType,
          "Content-Length": contentLength.toString(),
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } else {
      // No range — return full file with Accept-Ranges header
      const driveResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      return new Response(driveResponse.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": mimeType,
          "Content-Length": totalSize.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  } catch (error) {
    console.error("Recording stream error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
