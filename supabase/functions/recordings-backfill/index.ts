import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Google Drive access token via service account JWT flow.
 * Uses 'drive' scope (full) so we can list files we didn't create.
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
 * List files in a Google Drive folder (paginated).
 */
async function listDriveFiles(
  accessToken: string,
  folderId: string,
  pageSize = 1000,
  pageToken?: string,
  isSharedDrive = false
): Promise<{
  files: Array<{ id: string; name: string; createdTime: string; mimeType?: string }>;
  nextPageToken?: string;
}> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: "nextPageToken, files(id, name, createdTime, size, mimeType)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  if (isSharedDrive) {
    // For shared drives: use corpora=drive + driveId
    params.set("corpora", "drive");
    params.set("driveId", folderId);
    params.set("q", "trashed = false");
  } else {
    params.set("q", `'${folderId}' in parents and trashed = false`);
    params.set("orderBy", "createdTime desc");
  }

  if (pageToken) params.set("pageToken", pageToken);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Drive list failed (${response.status}): ${err}`);
  }

  return response.json();
}

/**
 * List ALL files in a folder (handles pagination).
 */
async function listAllDriveFiles(
  accessToken: string,
  folderId: string,
  isSharedDrive = false
): Promise<Array<{ id: string; name: string; createdTime: string; size?: string; mimeType?: string }>> {
  const allFiles: Array<{ id: string; name: string; createdTime: string; size?: string; mimeType?: string }> = [];
  let pageToken: string | undefined;

  do {
    const result = await listDriveFiles(accessToken, folderId, 1000, pageToken, isSharedDrive);
    allFiles.push(...result.files);
    pageToken = result.nextPageToken;
    console.log(`Listed ${allFiles.length} files so far...`);
  } while (pageToken);

  return allFiles;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "explore";

    // Load secrets
    const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!saKeyRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    const saKey = JSON.parse(saKeyRaw);

    const folderId =
      body.folder_id || Deno.env.get("GDRIVE_RECORDINGS_FOLDER_ID");
    if (!folderId) throw new Error("No folder ID available");

    const googleToken = await getGoogleAccessToken(saKey);

    // ─── EXPLORE MODE ──────────────────────────────────────────
    if (mode === "explore") {
      // Try as regular folder first
      let result;
      let listMode = "folder";
      try {
        result = await listDriveFiles(googleToken, folderId, 50, undefined, false);
      } catch {
        result = { files: [], nextPageToken: undefined };
      }

      // If empty, try as shared drive
      let sharedDriveResult = null;
      if (result.files.length === 0) {
        try {
          sharedDriveResult = await listDriveFiles(googleToken, folderId, 50, undefined, true);
          if (sharedDriveResult.files.length > 0) {
            result = sharedDriveResult;
            listMode = "shared_drive";
          }
        } catch (e) {
          sharedDriveResult = { error: e.message, files: [] };
        }
      }

      // Also try the VM folder if it's different
      const vmFolderId = "1D5NJWE9bG7CfxW9D3jEU5cyIF0eFhCX-";
      let vmResult = null;
      if (folderId !== vmFolderId) {
        try {
          vmResult = await listDriveFiles(googleToken, vmFolderId, 50);
        } catch (e) {
          vmResult = { error: e.message, files: [] };
        }
      }

      return new Response(
        JSON.stringify({
          mode: "explore",
          listMode,
          saEmail: saKey.client_email,
          sharedDriveAttempt: sharedDriveResult ? {
            fileCount: sharedDriveResult.files?.length || 0,
            error: sharedDriveResult.error || null,
          } : null,
          primaryFolder: {
            id: folderId,
            fileCount: result.files.length,
            hasMore: !!result.nextPageToken,
            files: result.files,
          },
          vmFolder: vmResult
            ? {
                id: vmFolderId,
                fileCount: vmResult.files?.length || 0,
                hasMore: !!vmResult.nextPageToken,
                files: vmResult.files || [],
                error: vmResult.error || null,
              }
            : { note: "Same as primary folder" },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── BACKFILL MODE ─────────────────────────────────────────
    // Matches GDrive files (uploaded by GCE VM SFTP) to call_recordings rows.
    //
    // GDrive filename format from RingCX SFTP:
    //   {First}_{Last}_{HubSpotContactID}_{Disposition}_{Last--First}_{MM}_{DD}_{HH}_{MM}.wav
    //   e.g. Matthew_Jamieson_184364994875_Not-interested_Jamieson--Matthew_03_15_23_50.wav
    //   Null variant: ____null--null_03_17_00_05.wav
    //
    // call_recordings.call_id format: 202603152350491370000110704652
    //   Chars 4-11 = MMDDHHMM in RingCX server time (US Eastern)
    //   This matches the filename's last 4 underscore-separated segments.
    //
    // Match key: hubspot_contact_id + MMDDHHMM from call_id
    if (mode === "backfill") {
      const dryRun = body.dry_run === true;
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
      );

      // 1. List all GDrive files
      console.log("Listing all files from Google Drive...");
      const allFiles = await listAllDriveFiles(googleToken, folderId);
      console.log(`Total files in Drive: ${allFiles.length}`);

      // 2. Fetch ALL pending call_recordings (with hubspot_contact_id)
      console.log("Fetching pending call_recordings...");
      const allRecordings: Array<{
        id: string;
        call_id: string;
        hubspot_contact_id: string | null;
        disposition: string;
      }> = [];

      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("call_recordings")
          .select("id, call_id, hubspot_contact_id, disposition")
          .eq("backup_status", "pending")
          .range(from, from + pageSize - 1);

        if (error) throw new Error(`DB query failed: ${error.message}`);
        if (!data || data.length === 0) break;
        allRecordings.push(...data);
        from += pageSize;
        if (data.length < pageSize) break;
      }

      console.log(`Total pending recordings: ${allRecordings.length}`);

      // 3. Build recording index: contactId_MMDDHHMM → recording
      //    Also: MMDDHHMM → [recordings] for null-contact files
      const recByContactTime = new Map<string, typeof allRecordings[0]>();
      const recByTimeOnly = new Map<string, typeof allRecordings>();

      for (const rec of allRecordings) {
        if (rec.call_id.length >= 12) {
          const timeKey = rec.call_id.substring(4, 12); // MMDDHHMM

          if (rec.hubspot_contact_id) {
            const key = `${rec.hubspot_contact_id}_${timeKey}`;
            recByContactTime.set(key, rec);
          }

          // Also index by time only (for null-contact files)
          const existing = recByTimeOnly.get(timeKey) || [];
          existing.push(rec);
          recByTimeOnly.set(timeKey, existing);
        }
      }

      console.log(`Index: ${recByContactTime.size} contact+time keys, ${recByTimeOnly.size} time-only keys`);

      // 4. Parse each GDrive filename and match
      let matched = 0;
      let matchedByTime = 0;
      let unmatched = 0;
      let skippedFolders = 0;
      const unmatchedFiles: string[] = [];
      const updates: Array<{ id: string; gdrive_file_id: string; gdrive_file_name: string }> = [];

      for (const file of allFiles) {
        // Skip folders
        if (file.mimeType === "application/vnd.google-apps.folder") {
          skippedFolders++;
          continue;
        }

        // Parse filename: split by _ and extract last 4 segments as MM DD HH MM
        const nameNoExt = file.name.replace(/\.\w+$/, "");
        const parts = nameNoExt.split("_");

        if (parts.length < 5) {
          if (unmatchedFiles.length < 10) unmatchedFiles.push(`PARSE_FAIL: ${file.name}`);
          unmatched++;
          continue;
        }

        // Last 4 parts: MM, DD, HH, MM
        const mm = parts[parts.length - 4];
        const dd = parts[parts.length - 3];
        const hh = parts[parts.length - 2];
        const mn = parts[parts.length - 1];
        const timeKey = `${mm}${dd}${hh}${mn}`; // e.g. "03152350"

        // Contact ID is the 3rd segment (index 2) — may be empty for null files
        const contactId = parts[2] || "";

        let rec: typeof allRecordings[0] | undefined;

        // Strategy 1: contact_id + time (most reliable)
        if (contactId && contactId !== "null") {
          const key = `${contactId}_${timeKey}`;
          rec = recByContactTime.get(key);

          // If not found, try ±1 minute (call_id seconds may push to next minute)
          if (!rec) {
            const mnNum = parseInt(mn, 10);
            for (const delta of [-1, 1]) {
              const adjMn = String(mnNum + delta).padStart(2, "0");
              const adjKey = `${contactId}_${mm}${dd}${hh}${adjMn}`;
              rec = recByContactTime.get(adjKey);
              if (rec) break;
            }
          }
        }

        // Strategy 2: time-only match for null-contact files (only if unique)
        if (!rec && (!contactId || contactId === "null" || contactId === "")) {
          const candidates = recByTimeOnly.get(timeKey);
          if (candidates && candidates.length === 1) {
            rec = candidates[0];
            matchedByTime++;
          }
        }

        if (rec) {
          updates.push({
            id: rec.id,
            gdrive_file_id: file.id,
            gdrive_file_name: file.name,
          });
          matched++;
        } else {
          unmatched++;
          if (unmatchedFiles.length < 20) {
            unmatchedFiles.push(`${file.name} (contactId=${contactId}, timeKey=${timeKey})`);
          }
        }
      }

      console.log(`Matched: ${matched} (${matchedByTime} by time-only), Unmatched: ${unmatched}`);

      // 5. Batch update matched recordings
      let updated = 0;
      let updateErrors = 0;

      if (!dryRun) {
        for (let i = 0; i < updates.length; i += 50) {
          const batch = updates.slice(i, i + 50);
          const promises = batch.map((u) =>
            supabase
              .from("call_recordings")
              .update({
                backup_status: "uploaded",
                gdrive_file_id: u.gdrive_file_id,
                gdrive_file_url: `https://drive.google.com/file/d/${u.gdrive_file_id}/view`,
                gdrive_file_name: u.gdrive_file_name,
                backed_up_at: new Date().toISOString(),
              })
              .eq("id", u.id)
          );

          const results = await Promise.all(promises);
          for (const r of results) {
            if (r.error) {
              updateErrors++;
              console.error(`Update error: ${r.error.message}`);
            } else {
              updated++;
            }
          }

          if ((i + 50) % 500 === 0) {
            console.log(`Updated ${updated} of ${updates.length}...`);
          }
        }
      }

      return new Response(
        JSON.stringify({
          mode: "backfill",
          dryRun,
          driveFiles: allFiles.length,
          skippedFolders,
          pendingRecordings: allRecordings.length,
          matched,
          matchedByTime,
          unmatched,
          updated,
          updateErrors,
          unmatchedFiles,
          sampleMatches: updates.slice(0, 5).map((u) => ({
            recordingId: u.id,
            gdriveFileId: u.gdrive_file_id,
            filename: u.gdrive_file_name,
          })),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown mode: ${mode}. Use 'explore' or 'backfill'.` }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      }
    );
  } catch (error) {
    console.error("Backfill error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});

