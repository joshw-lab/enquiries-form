import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getRingCentralAccessToken,
  corsHeaders,
} from "../_shared/ringcx-lead-loader-base.ts";

/**
 * RingCX Call Recovery
 *
 * Uses the RingCentral Call Log API to recover call records that may
 * have been missed by the webhook pipeline.
 *
 * The RC Call Log API provides detailed call records including:
 *   - Phone numbers, agent info, duration, result
 *   - Recording URLs for connected calls
 *   - Session IDs for cross-referencing
 *
 * Cross-references results against webhook logs and form submissions
 * to identify gaps.
 *
 * API: GET /restapi/v1.0/account/~/call-log
 * Auth: RingCentral access token (not RingCX JWT)
 * Scope: Read Call Log
 */

interface RecoveryRequest {
  // Date range (required) — ISO-8601 format YYYY-MM-DD
  startDate: string;
  endDate: string;
  // Optional: filter to specific phone number (E.164 format)
  phoneNumber?: string;
  // Optional: only include calls with recordings
  withRecording?: boolean;
  // Optional: filter by call result (e.g., "Call connected", "Busy", "No Answer")
  callResult?: string;
  // Optional: page size (default 100, max 250)
  perPage?: number;
}

interface CallRecord {
  callId: string;
  sessionId: string;
  startTime: string;
  duration: number;
  direction: string;
  result: string;
  toPhone: string;
  fromPhone: string;
  fromName: string;
  extensionId: string;
  recordingId: string | null;
  recordingContentUri: string | null;
}

/**
 * Normalize phone number for matching — strip +, spaces, leading country code
 * Returns last 9 digits for AU numbers
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // For AU numbers, take last 9 digits (removes +61 or 0 prefix)
  if (digits.length >= 9) {
    return digits.slice(-9);
  }
  return digits;
}

/**
 * Fetch all pages of call log results
 */
async function fetchAllCallLogPages(
  rcToken: string,
  params: URLSearchParams,
  maxPages = 10
): Promise<CallRecord[]> {
  const RC_API_BASE = "https://platform.ringcentral.com/restapi/v1.0";
  const allRecords: CallRecord[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    params.set("page", String(page));
    const url = `${RC_API_BASE}/account/~/call-log?${params.toString()}`;

    console.log(`Fetching call log page ${page}: ${url}`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${rcToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`RC Call Log API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const records = data.records || [];

    for (const r of records) {
      const recording = r.recording || null;
      allRecords.push({
        callId: r.id || "",
        sessionId: r.sessionId || "",
        startTime: r.startTime || "",
        duration: r.duration || 0,
        direction: r.direction || "",
        result: r.result || "",
        toPhone: r.to?.phoneNumber || "",
        fromPhone: r.from?.phoneNumber || "",
        fromName: r.from?.name || "",
        extensionId: r.extension?.id?.toString() || "",
        recordingId: recording?.id?.toString() || null,
        recordingContentUri: recording?.contentUri || null,
      });
    }

    // Check pagination
    const paging = data.paging || {};
    const totalPages = paging.totalPages || 1;
    hasMore = page < totalPages;
    page++;
  }

  return allRecords;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      startDate,
      endDate,
      phoneNumber,
      withRecording = false,
      callResult,
      perPage = 100,
    }: RecoveryRequest = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required (YYYY-MM-DD)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📋 Call Recovery: ${startDate} to ${endDate}`);
    if (phoneNumber) console.log(`  Phone filter: ${phoneNumber}`);
    if (withRecording) console.log(`  With recording only`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Get RC access token (raw, NOT RingCX JWT)
    // skipRingCXExchange = true to get the raw RC token
    const { token: rcToken, error: authError } = await getRingCentralAccessToken(supabase, true);
    if (!rcToken) {
      return new Response(
        JSON.stringify({ error: `Auth failed: ${authError}` }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build Call Log API params
    const params = new URLSearchParams({
      dateFrom: `${startDate}T00:00:00Z`,
      dateTo: `${endDate}T23:59:59Z`,
      direction: "Outbound",
      view: "Detailed",
      perPage: String(Math.min(perPage, 250)),
      withRecording: String(withRecording),
    });

    if (phoneNumber) {
      params.set("phoneNumber", phoneNumber);
    }

    // Fetch all call log pages
    const allCalls = await fetchAllCallLogPages(rcToken, params);
    console.log(`Fetched ${allCalls.length} outbound call records`);

    // Apply client-side result filter if specified
    let filteredCalls = allCalls;
    if (callResult) {
      filteredCalls = allCalls.filter(
        (c) => c.result.toLowerCase().includes(callResult.toLowerCase())
      );
      console.log(`After result filter "${callResult}": ${filteredCalls.length} calls`);
    }

    // Cross-reference with webhook logs
    // Match by phone number (normalized) since webhook logs use phone, not RC call IDs
    const callPhones = filteredCalls.map((c) => normalizePhone(c.toPhone)).filter(Boolean);
    const webhookPhoneMatches = new Set<string>();

    if (callPhones.length > 0) {
      // Fetch webhook logs for the same date range
      const { data: webhookLogs } = await supabase
        .from("ringcx_webhook_logs")
        .select("call_id, contact_id, status, payload, created_at")
        .gte("created_at", `${startDate}T00:00:00Z`)
        .lte("created_at", `${endDate}T23:59:59Z`);

      // Extract phone numbers from webhook payloads and build a match set
      for (const log of webhookLogs || []) {
        const payload = log.payload || {};
        const phone = payload.ani || payload.lead_phone || payload.dnis || "";
        const normalized = normalizePhone(phone);
        if (normalized) {
          webhookPhoneMatches.add(normalized);
        }
      }

      console.log(`Found ${webhookPhoneMatches.size} unique phones in webhook logs`);
    }

    // Also check form submissions for the date range
    const { data: formSubs } = await supabase
      .from("hubspot_form_submissions")
      .select("id, disposition, created_at, submitted_by, contact")
      .gte("created_at", `${startDate}T00:00:00Z`)
      .lte("created_at", `${endDate}T23:59:59Z`);

    const formPhones = new Set<string>();
    for (const form of formSubs || []) {
      const phone = form.contact?.phone || form.submitted_by?.phone || "";
      const normalized = normalizePhone(phone);
      if (normalized) {
        formPhones.add(normalized);
      }
    }

    // Annotate calls with webhook and form status
    const annotated = filteredCalls.map((call) => {
      const normalizedTo = normalizePhone(call.toPhone);
      return {
        ...call,
        webhookReceived: webhookPhoneMatches.has(normalizedTo),
        formSubmissionExists: formPhones.has(normalizedTo),
      };
    });

    const missing = annotated.filter((r) => !r.webhookReceived);
    const matched = annotated.filter((r) => r.webhookReceived);
    const formOnlyGaps = annotated.filter(
      (r) => !r.webhookReceived && r.formSubmissionExists
    );

    const response = {
      summary: {
        total_calls: annotated.length,
        webhook_matched: matched.length,
        webhook_missing: missing.length,
        form_only_gaps: formOnlyGaps.length,
        date_range: { start: startDate, end: endDate },
        ...(phoneNumber && { phone_filter: phoneNumber }),
        ...(callResult && { result_filter: callResult }),
      },
      missing_calls: missing.map((c) => ({
        callId: c.callId,
        sessionId: c.sessionId,
        startTime: c.startTime,
        duration: c.duration,
        result: c.result,
        toPhone: c.toPhone,
        fromName: c.fromName,
        hasRecording: !!c.recordingId,
        recordingContentUri: c.recordingContentUri,
        formSubmissionExists: c.formSubmissionExists,
      })),
      matched_calls_count: matched.length,
      // Calls that have a form submission but no webhook (highest priority to fix)
      form_only_gap_details: formOnlyGaps.map((c) => ({
        callId: c.callId,
        startTime: c.startTime,
        duration: c.duration,
        result: c.result,
        toPhone: c.toPhone,
        fromName: c.fromName,
        hasRecording: !!c.recordingId,
        recordingContentUri: c.recordingContentUri,
      })),
    };

    console.log(
      `Recovery: ${annotated.length} total, ${matched.length} matched, ${missing.length} missing, ${formOnlyGaps.length} form-only gaps`
    );

    return new Response(JSON.stringify(response, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in call-recovery:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
