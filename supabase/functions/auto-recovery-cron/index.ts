import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getRingCentralAccessToken,
  corsHeaders,
} from "../_shared/ringcx-lead-loader-base.ts";

/**
 * Auto-Recovery Cron
 *
 * Runs every 30 minutes via pg_cron.
 *
 * Detects form submissions with no matching webhook (same gap detection as
 * disposition-reconciliation) and backfills HubSpot call engagements using
 * the RC Call Log API.
 *
 * Flow:
 * 1. Determine target date (today AEST, or override via request body)
 * 2. Detect gaps: form submissions with no matching webhook log
 * 3. For each gap (max 25 per run):
 *    a. Idempotency check via recovery_runs table
 *    b. Get phone number from form data or HubSpot API
 *    c. Search RC Call Log API (strip +61 prefix — API quirk)
 *    d. If call found: create HubSpot call engagement with recording
 *    e. Insert result into recovery_runs
 * 4. Send Google Chat summary notification
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const RC_API_BASE = "https://platform.ringcentral.com/restapi/v1.0";
const MAX_GAPS_PER_RUN = 25;
const RC_API_DELAY_MS = 1000; // 1s between RC API calls to avoid 429s

// Known test contact IDs — same as disposition-reconciliation
const TEST_CONTACT_IDS = new Set([
  "42694751",       // Matt Jamieson Test
  "17461201",       // Josh77 Williams (test contact)
  "184364994875",   // Matt Jamieson - RC Test
  "42743401",       // Sam Test-Mike
  "56245751",       // Hubspot Testing
  "44169201",       // Matt Jamieson (test)
  "185015538276",   // Craig Purser - RingCX Test
]);

// 24-hour match window for webhook ↔ form submission pairing
const MATCH_WINDOW_MS = 86400 * 1000;

// GUID source of truth: /hubspot call disposition IDs.csv
const DISPOSITION_MAP: Record<string, string> = {
  // Connected
  "connected": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
  // Booked Test
  "booked_test": "f72848b8-6063-4591-9832-a4e4604864f5",
  "booked": "f72848b8-6063-4591-9832-a4e4604864f5",
  "book_water_test": "f72848b8-6063-4591-9832-a4e4604864f5",
  "booked_water_test": "f72848b8-6063-4591-9832-a4e4604864f5",
  // Booked Test - Single Leg
  "booked_test_single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",
  "booked_single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",
  "single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",
  // No answer
  "no_answer": "73a0d17f-1163-4015-bdd5-ec830791da20",
  "noanswer": "73a0d17f-1163-4015-bdd5-ec830791da20",
  "na": "73a0d17f-1163-4015-bdd5-ec830791da20",
  "no_response": "73a0d17f-1163-4015-bdd5-ec830791da20",
  // Wrong number
  "wrong_number": "17b47fee-58de-441e-a44c-c6300d46f273",
  "wrongnumber": "17b47fee-58de-441e-a44c-c6300d46f273",
  "wrong": "17b47fee-58de-441e-a44c-c6300d46f273",
  "invalid_number": "17b47fee-58de-441e-a44c-c6300d46f273",
  // Not interested
  "not_interested": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",
  "not_intrested": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",
  "ni": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",
  // Busy
  "busy": "9d9162e7-6cf3-4944-bf63-4dff82258764",
  // Left live message
  "left_live_message": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",
  "live_message": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",
  // Left voicemail
  "voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
  "left_voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
  "leftvoicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
  "vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",
  "left_vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",
  // Unable to Service
  "unable_to_service": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",
  "cannot_service": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",
  "out_of_area": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",
  // Other Departments
  "other_departments": "c5067c48-aaf1-4f67-9c56-6a749b666817",
  "other_department": "c5067c48-aaf1-4f67-9c56-6a749b666817",
  "transfer": "c5067c48-aaf1-4f67-9c56-6a749b666817",
  // Needs Call Back
  "needs_call_back": "4aa8b662-f76e-4557-8a24-ffae50519382",
  "call_back": "4aa8b662-f76e-4557-8a24-ffae50519382",
  "callback": "4aa8b662-f76e-4557-8a24-ffae50519382",
  // RO Only
  "ro_only": "ba63d1f1-e3ef-400a-a3c0-c6e1f1a5d6a4",
  "ro": "ba63d1f1-e3ef-400a-a3c0-c6e1f1a5d6a4",
  // New Build
  "new_build": "21467e3f-24c5-4b82-9e37-e918d77d2c48",
  "newbuild": "21467e3f-24c5-4b82-9e37-e918d77d2c48",
  // Water Source
  "water_source": "a8a9584b-366a-4a68-a185-21ce4181d78c",
  "watersource": "a8a9584b-366a-4a68-a185-21ce4181d78c",
  // Phone Pitch - CHF
  "phone_pitch_chf": "6c20cc50-781f-4543-a773-d4698f649bcf",
  "phone_pitch": "6c20cc50-781f-4543-a773-d4698f649bcf",
  "phonepitch": "6c20cc50-781f-4543-a773-d4698f649bcf",
  // Wants Follow Up
  "wants_follow_up": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",
  "follow_up": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",
  "followup": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",
  // Internal - Closed Deal
  "internal_closed_deal": "def5ec8d-b566-413c-b558-e4a39884ab8b",
  "closed_deal": "def5ec8d-b566-413c-b558-e4a39884ab8b",
  // Internal - Deposit Taken
  "internal_deposit_taken": "5f7f3f43-e0d0-4c03-ba44-09894047c474",
  "deposit_taken": "5f7f3f43-e0d0-4c03-ba44-09894047c474",
  "deposit": "5f7f3f43-e0d0-4c03-ba44-09894047c474",
  // Not Qualified
  "not_qualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",
  "notqualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",
  "nq": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",
  // Do Not Call
  "do_not_call": "df11c246-3ff0-45da-b77b-35baaf3e7238",
  "donotcall": "df11c246-3ff0-45da-b77b-35baaf3e7238",
  "dnc": "df11c246-3ff0-45da-b77b-35baaf3e7238",
  "do_not_register": "df11c246-3ff0-45da-b77b-35baaf3e7238",
  // Hangup
  "hangup": "1bbfa758-eef2-4475-8717-2cebb16270db",
  "hang_up": "1bbfa758-eef2-4475-8717-2cebb16270db",
  "hung_up": "1bbfa758-eef2-4475-8717-2cebb16270db",
};

/**
 * Map disposition string to HubSpot GUID — returns null if unmapped
 */
function mapDisposition(disposition: string): string | null {
  const normalized = disposition.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  return DISPOSITION_MAP[normalized] || null;
}

/**
 * Generate multiple search-friendly phone formats from a raw number.
 * RC Call Log API quirk: +61 prefix returns 0 results, but partial
 * digit strings work. We try multiple formats to maximize match rate.
 *
 * E.g. "+61 447 409 358" → ["447409358", "0447409358", "61447409358"]
 */
function getPhoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const variants = new Set<string>();

  if (digits.length >= 9) {
    // Last 9 digits (most reliable for AU mobiles: 4XXXXXXXX)
    variants.add(digits.slice(-9));
    // 10 digits with leading 0 (04XXXXXXXX / 03XXXXXXXX)
    variants.add("0" + digits.slice(-9));
    // Full digits without + (61447409358)
    if (digits.length > 9) {
      variants.add(digits);
    }
  } else if (digits.length > 0) {
    variants.add(digits);
  }

  return [...variants];
}

/**
 * Get today's date in AEST timezone as YYYY-MM-DD
 */
function getTodayAEST(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now); // Returns YYYY-MM-DD
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch all phone numbers from HubSpot contact API (phone + mobilephone)
 */
async function getPhonesFromHubSpot(
  contactId: string,
  accessToken: string
): Promise<string[]> {
  try {
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=phone,mobilephone,firstname,lastname`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    const phones: string[] = [];
    if (data.properties?.phone) phones.push(data.properties.phone);
    if (data.properties?.mobilephone) phones.push(data.properties.mobilephone);
    return phones;
  } catch {
    return [];
  }
}

/**
 * Search RC Call Log by phone number for a date range.
 * Tries multiple phone variants and both directions.
 * Returns the best matching call record (longest duration).
 */
async function searchCallLog(
  rcToken: string,
  phoneVariants: string[],
  dateFrom: string,
  dateTo: string
): Promise<{
  callId: string;
  sessionId: string;
  startTime: string;
  duration: number;
  direction: string;
  result: string;
  toPhone: string;
  fromPhone: string;
  fromName: string;
  recordingId: string | null;
  recordingContentUri: string | null;
} | null> {
  // Try each phone variant × each direction until we find a match
  for (const phoneVariant of phoneVariants) {
    for (const direction of ["Outbound", "Inbound"]) {
      const params = new URLSearchParams({
        dateFrom: `${dateFrom}T00:00:00Z`,
        dateTo: `${dateTo}T23:59:59Z`,
        phoneNumber: phoneVariant,
        direction,
        view: "Detailed",
        perPage: "10",
      });

      const url = `${RC_API_BASE}/account/~/call-log?${params.toString()}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${rcToken}` },
      });

      if (!response.ok) {
        console.error(`RC Call Log API error (${response.status}) for ${phoneVariant}/${direction}: ${await response.text()}`);
        continue;
      }

      const data = await response.json();
      const records = data.records || [];

      if (records.length > 0) {
        // Pick the longest call (most likely the actual disposition call)
        const best = records.reduce((a: any, b: any) =>
          (b.duration || 0) > (a.duration || 0) ? b : a
        );

        const recording = best.recording || null;
        console.log(`  📞 Match found with variant "${phoneVariant}" (${direction}): ${records.length} records, best: ${best.duration}s`);
        return {
          callId: best.id || "",
          sessionId: best.sessionId || "",
          startTime: best.startTime || "",
          duration: best.duration || 0,
          direction: best.direction || direction,
          result: best.result || "",
          toPhone: best.to?.phoneNumber || "",
          fromPhone: best.from?.phoneNumber || "",
          fromName: best.from?.name || "",
          recordingId: recording?.id?.toString() || null,
          recordingContentUri: recording?.contentUri || null,
        };
      }
    }
  }

  return null;
}

/**
 * Create a HubSpot call engagement and associate to contact
 */
async function createHubSpotCall(
  contactId: string,
  contactName: string,
  disposition: string,
  callRecord: {
    startTime: string;
    duration: number;
    direction: string;
    toPhone: string;
    fromPhone: string;
    fromName: string;
    recordingContentUri: string | null;
  },
  hubspotToken: string
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    // Map disposition to HubSpot GUID
    const dispositionGuid = mapDisposition(disposition);

    // Format disposition label for title
    const dispositionLabel = disposition
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase());

    const directionLabel = callRecord.direction === "Outbound" ? "Outbound" : "Inbound";

    // Format duration display
    const durationMins = Math.floor(callRecord.duration / 60);
    const durationSecs = callRecord.duration % 60;
    const durationDisplay = durationMins > 0
      ? `${durationMins}m ${durationSecs}s`
      : `${durationSecs}s`;

    // Build call body
    const callBodyParts = [
      `${directionLabel} call - ${contactName}`,
      `<b>Duration:</b> ${durationDisplay} | <b>Disposition:</b> ${dispositionLabel}`,
      `<b>Agent:</b> ${callRecord.fromName || "Unknown"}`,
      "",
      "<i>(Auto-Recovered by nightly cron — webhook was missed)</i>",
    ];

    const callPayload: Record<string, any> = {
      properties: {
        hs_timestamp: new Date(callRecord.startTime).getTime(),
        hs_activity_type: "Verification & Test Appointment Booking",
        hs_call_title: `${directionLabel} Call - ${dispositionLabel} (Auto-Recovered)`,
        hs_call_body: callBodyParts.join("<br>"),
        hs_call_direction: callRecord.direction === "Outbound" ? "OUTBOUND" : "INBOUND",
        hs_call_duration: callRecord.duration * 1000, // ms
        hs_call_status: "COMPLETED",
        ...(dispositionGuid && { hs_call_disposition: dispositionGuid }),
        ...(callRecord.recordingContentUri && {
          hs_call_recording_url: callRecord.recordingContentUri,
        }),
        hs_call_from_number: callRecord.fromPhone,
        hs_call_to_number: callRecord.toPhone,
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 194, // Call to Contact
            },
          ],
        },
      ],
    };

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hubspotToken}`,
      },
      body: JSON.stringify(callPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HubSpot ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: true, callId: data.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Update HubSpot contact n0_ringcx_call_notes property
 */
async function updateContactCallNotesFlag(
  contactId: string,
  hubspotToken: string
): Promise<void> {
  try {
    await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${hubspotToken}`,
        },
        body: JSON.stringify({
          properties: { n0_ringcx_call_notes: "Yes" },
        }),
      }
    );
  } catch (error) {
    console.error(`Failed to update call notes flag for ${contactId}:`, error);
  }
}

/**
 * Send Google Chat summary notification
 */
async function notifyGChat(
  summary: {
    date: string;
    total_gaps: number;
    recovered: number;
    no_match: number;
    already_recovered: number;
    failed: number;
    skipped: number;
  }
): Promise<void> {
  const webhookUrl = Deno.env.get("GOOGLE_CHAT_WEBHOOK_URL");
  if (!webhookUrl) {
    console.warn("GOOGLE_CHAT_WEBHOOK_URL not configured — skipping notification");
    return;
  }

  const emoji = summary.recovered > 0 ? "🔄" : "✅";
  const message = {
    text:
      `${emoji} *Auto-Recovery Cron Summary — ${summary.date}*\n\n` +
      `• Gaps detected: *${summary.total_gaps}*\n` +
      `• Recovered: *${summary.recovered}*\n` +
      `• No RC call found: *${summary.no_match}*\n` +
      `• Already recovered: *${summary.already_recovered}*\n` +
      `• Failed: *${summary.failed}*\n` +
      `• Skipped (no phone): *${summary.skipped}*`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (error) {
    console.error("Failed to send Google Chat notification:", error);
  }
}

// ─── Main Handler ────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Determine target date: override from body or today AEST
    let targetDate: string;
    try {
      const body = await req.json();
      targetDate = body?.date || getTodayAEST();
    } catch {
      targetDate = getTodayAEST();
    }

    console.log(`🔄 Auto-Recovery Cron starting for date: ${targetDate}`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const hubspotToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotToken) {
      throw new Error("HUBSPOT_ACCESS_TOKEN not configured");
    }

    // ── Step 1: Detect Gaps ──────────────────────────────────────────
    // Same logic as disposition-reconciliation: form submissions with no matching webhook

    const { data: formSubmissions, error: formError } = await supabase
      .from("hubspot_form_submissions")
      .select("id, disposition, created_at, submitted_by, contact")
      .gte("created_at", `${targetDate}T00:00:00Z`)
      .lte("created_at", `${targetDate}T23:59:59Z`)
      .order("created_at", { ascending: false });

    if (formError) {
      throw new Error(`Failed to fetch form submissions: ${formError.message}`);
    }

    const { data: webhookLogs, error: webhookError } = await supabase
      .from("ringcx_webhook_logs")
      .select("call_id, contact_id, status, created_at")
      .gte("created_at", `${targetDate}T00:00:00Z`)
      .lte("created_at", `${targetDate}T23:59:59Z`);

    if (webhookError) {
      throw new Error(`Failed to fetch webhook logs: ${webhookError.message}`);
    }

    // Build contact_id -> webhook timestamps map
    const webhookContactMap = new Map<string, number[]>();
    for (const log of webhookLogs || []) {
      const cid = log.contact_id;
      if (!cid) continue;
      if (!webhookContactMap.has(cid)) {
        webhookContactMap.set(cid, []);
      }
      webhookContactMap.get(cid)!.push(new Date(log.created_at).getTime());
    }

    // Find gaps
    interface Gap {
      formId: string;
      contactId: string;
      contactName: string;
      disposition: string;
      phone: string;
      formSubmittedAt: string;
    }

    const gaps: Gap[] = [];

    for (const form of formSubmissions || []) {
      const contactId = form.submitted_by?.contact_id || "";
      if (!contactId) continue;

      // Skip test contacts
      if (TEST_CONTACT_IDS.has(contactId)) continue;

      // Skip corrupted IDs (scientific notation)
      if (/[eE]/.test(contactId) || contactId.includes(" ")) continue;

      const formTime = new Date(form.created_at).getTime();
      const webhookTimestamps = webhookContactMap.get(contactId);

      let hasMatch = false;
      if (webhookTimestamps) {
        hasMatch = webhookTimestamps.some(
          (wt) => Math.abs(formTime - wt) < MATCH_WINDOW_MS
        );
      }

      if (!hasMatch) {
        const contactName = form.contact?.name || "Unknown";
        const disposition = form.disposition || "unknown";
        const phone = form.contact?.phone || form.submitted_by?.phone || "";

        gaps.push({
          formId: form.id,
          contactId,
          contactName,
          disposition,
          phone,
          formSubmittedAt: form.created_at,
        });
      }
    }

    console.log(`📊 Gap detection: ${formSubmissions?.length || 0} form submissions, ${webhookLogs?.length || 0} webhook logs, ${gaps.length} gaps`);

    // Cap at MAX_GAPS_PER_RUN to avoid edge function timeout (150s)
    const gapsToProcess = gaps.slice(0, MAX_GAPS_PER_RUN);
    if (gaps.length > MAX_GAPS_PER_RUN) {
      console.warn(`⚠️ Capped at ${MAX_GAPS_PER_RUN} gaps (${gaps.length} total). Remaining will be processed next run.`);
    }

    // ── Step 2: Get RC token for Call Log API ────────────────────────
    const { token: rcToken, error: authError } = await getRingCentralAccessToken(supabase, true);
    if (!rcToken) {
      throw new Error(`RC auth failed: ${authError}`);
    }

    // ── Step 3: Process each gap ─────────────────────────────────────
    const results = {
      recovered: 0,
      no_match: 0,
      already_recovered: 0,
      failed: 0,
      skipped: 0,
    };

    const recoveryDetails: Array<{
      contactId: string;
      contactName: string;
      status: string;
      hubspotCallId?: string;
      error?: string;
    }> = [];

    for (const gap of gapsToProcess) {
      console.log(`\n── Processing: ${gap.contactName} (${gap.contactId}) — ${gap.disposition}`);

      try {
        // Idempotency check
        const { data: existing } = await supabase
          .from("recovery_runs")
          .select("id, status")
          .eq("run_date", targetDate)
          .eq("contact_id", gap.contactId)
          .maybeSingle();

        if (existing) {
          console.log(`  ⏩ Already processed: ${existing.status}`);
          results.already_recovered++;
          recoveryDetails.push({
            contactId: gap.contactId,
            contactName: gap.contactName,
            status: "already_recovered",
          });
          continue;
        }

        // Collect all phone numbers — from form data + HubSpot API (phone + mobilephone)
        const allPhones: string[] = [];
        if (gap.phone) allPhones.push(gap.phone);

        // Always fetch from HubSpot to get mobilephone too
        const hsPhones = await getPhonesFromHubSpot(gap.contactId, hubspotToken);
        for (const p of hsPhones) {
          if (!allPhones.includes(p)) allPhones.push(p);
        }

        if (allPhones.length === 0) {
          console.log("  ⏩ No phone number available — skipping");
          results.skipped++;

          await supabase.from("recovery_runs").insert({
            run_date: targetDate,
            contact_id: gap.contactId,
            contact_name: gap.contactName,
            form_submission_id: gap.formId,
            disposition: gap.disposition,
            status: "skipped",
            error_message: "No phone number available",
          });

          recoveryDetails.push({
            contactId: gap.contactId,
            contactName: gap.contactName,
            status: "skipped",
            error: "No phone number",
          });
          continue;
        }

        // Build all phone variants from all numbers (9-digit, 10-digit, full)
        const allVariants = new Set<string>();
        for (const phone of allPhones) {
          for (const v of getPhoneVariants(phone)) {
            allVariants.add(v);
          }
        }
        const phoneVariants = [...allVariants];
        console.log(`  📞 Phones: ${allPhones.join(", ")} → variants: ${phoneVariants.join(", ")}`);

        if (phoneVariants.length === 0 || phoneVariants[0].length < 8) {
          console.log("  ⏩ Phone too short — skipping");
          results.skipped++;

          await supabase.from("recovery_runs").insert({
            run_date: targetDate,
            contact_id: gap.contactId,
            contact_name: gap.contactName,
            form_submission_id: gap.formId,
            disposition: gap.disposition,
            status: "skipped",
            error_message: `Phone too short: ${allPhones.join(", ")}`,
          });

          recoveryDetails.push({
            contactId: gap.contactId,
            contactName: gap.contactName,
            status: "skipped",
            error: `Phone too short`,
          });
          continue;
        }

        // Rate limit — wait before RC API calls
        await sleep(RC_API_DELAY_MS);

        // Search RC Call Log with all phone variants
        const callRecord = await searchCallLog(rcToken, phoneVariants, targetDate, targetDate);

        if (!callRecord) {
          console.log(`  ❌ No matching call in RC Call Log (tried ${phoneVariants.length} variants × 2 directions)`);
          results.no_match++;

          await supabase.from("recovery_runs").insert({
            run_date: targetDate,
            contact_id: gap.contactId,
            contact_name: gap.contactName,
            form_submission_id: gap.formId,
            disposition: gap.disposition,
            status: "no_match",
            details: { phones: allPhones, variants: phoneVariants },
          });

          recoveryDetails.push({
            contactId: gap.contactId,
            contactName: gap.contactName,
            status: "no_match",
          });
          continue;
        }

        console.log(`  ✅ Found RC call: ${callRecord.callId} (${callRecord.direction}, ${callRecord.duration}s, recording: ${!!callRecord.recordingContentUri})`);

        // Create HubSpot call engagement
        const hsResult = await createHubSpotCall(
          gap.contactId,
          gap.contactName,
          gap.disposition,
          callRecord,
          hubspotToken
        );

        if (!hsResult.success) {
          console.error(`  ❌ HubSpot call creation failed: ${hsResult.error}`);
          results.failed++;

          await supabase.from("recovery_runs").insert({
            run_date: targetDate,
            contact_id: gap.contactId,
            contact_name: gap.contactName,
            form_submission_id: gap.formId,
            disposition: gap.disposition,
            status: "failed",
            rc_call_id: callRecord.callId,
            rc_session_id: callRecord.sessionId,
            recording_url: callRecord.recordingContentUri,
            error_message: hsResult.error,
            details: { phones: allPhones, callRecord },
          });

          recoveryDetails.push({
            contactId: gap.contactId,
            contactName: gap.contactName,
            status: "failed",
            error: hsResult.error,
          });
          continue;
        }

        console.log(`  ✅ HubSpot call engagement created: ${hsResult.callId}`);

        // Update contact call notes flag
        await updateContactCallNotesFlag(gap.contactId, hubspotToken);

        // Record success
        results.recovered++;

        await supabase.from("recovery_runs").insert({
          run_date: targetDate,
          contact_id: gap.contactId,
          contact_name: gap.contactName,
          form_submission_id: gap.formId,
          disposition: gap.disposition,
          status: "recovered",
          rc_call_id: callRecord.callId,
          rc_session_id: callRecord.sessionId,
          hubspot_call_id: hsResult.callId,
          recording_url: callRecord.recordingContentUri,
          details: {
            phones: allPhones,
            duration: callRecord.duration,
            direction: callRecord.direction,
            result: callRecord.result,
          },
        });

        recoveryDetails.push({
          contactId: gap.contactId,
          contactName: gap.contactName,
          status: "recovered",
          hubspotCallId: hsResult.callId,
        });
      } catch (error) {
        console.error(`  ❌ Unexpected error: ${error.message}`);
        results.failed++;

        // Try to record the failure
        try {
          await supabase.from("recovery_runs").insert({
            run_date: targetDate,
            contact_id: gap.contactId,
            contact_name: gap.contactName,
            form_submission_id: gap.formId,
            disposition: gap.disposition,
            status: "failed",
            error_message: error.message,
          });
        } catch {
          // Ignore insert errors (e.g. duplicate key if race condition)
        }

        recoveryDetails.push({
          contactId: gap.contactId,
          contactName: gap.contactName,
          status: "failed",
          error: error.message,
        });
      }
    }

    // ── Step 4: Summary ──────────────────────────────────────────────
    const summary = {
      date: targetDate,
      total_gaps: gaps.length,
      processed: gapsToProcess.length,
      ...results,
    };

    console.log(`\n📋 Auto-Recovery Summary for ${targetDate}:`);
    console.log(`   Gaps detected: ${gaps.length}`);
    console.log(`   Processed: ${gapsToProcess.length}`);
    console.log(`   Recovered: ${results.recovered}`);
    console.log(`   No match: ${results.no_match}`);
    console.log(`   Already recovered: ${results.already_recovered}`);
    console.log(`   Failed: ${results.failed}`);
    console.log(`   Skipped: ${results.skipped}`);

    // Send Google Chat notification
    await notifyGChat(summary);

    return new Response(
      JSON.stringify({ summary, details: recoveryDetails }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("❌ Auto-recovery cron error:", error);

    // Try to notify Google Chat about the failure
    try {
      const webhookUrl = Deno.env.get("GOOGLE_CHAT_WEBHOOK_URL");
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `🚨 *Auto-Recovery Cron FAILED*\n\n*Error:* ${error.message}\n*Time:* ${new Date().toISOString()}`,
          }),
        });
      }
    } catch {
      // Ignore notification errors
    }

    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
