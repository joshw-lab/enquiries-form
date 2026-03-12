import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Disposition Reconciliation
 *
 * Compares form submissions (which create HubSpot notes) against
 * webhook logs (which create HubSpot call engagements) to identify
 * calls that were dispositioned manually but never received a webhook.
 *
 * These are gaps where a call happened in RingCX but only a note
 * was created in HubSpot — not a proper call engagement.
 */

interface ReconciliationRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  includeTestContacts?: boolean; // default false
}

// Known test contact IDs to exclude from production results
const TEST_CONTACT_IDS = new Set([
  "42694751",       // Matt Jamieson Test
  "17461201",       // Josh77 Williams (test contact from memory)
  "184364994875",   // Matt Jamieson - RC Test
  "42743401",       // Sam Test-Mike
  "56245751",       // Hubspot Testing
  "44169201",       // Matt Jamieson (test)
  "185015538276",   // Craig Purser - RingCX Test
]);

// Window (in seconds) to consider a webhook "matching" a form submission
const MATCH_WINDOW_SECONDS = 86400; // 24 hours

interface GapEntry {
  form_submission_id: string;
  contact_id: string;
  contact_name: string;
  disposition: string;
  form_submitted_at: string;
  gap_type: "no_webhook" | "no_nearby_webhook" | "corrupted_id";
}

interface ReconciliationResponse {
  summary: {
    total_form_submissions: number;
    matched: number;
    unmatched: number;
    gap_rate_percent: number;
    corrupted_ids: number;
    date_range: { start: string; end: string };
  };
  gaps: GapEntry[];
  webhook_status_breakdown: Record<string, number>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      startDate,
      endDate,
      includeTestContacts = false,
    }: ReconciliationRequest = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required (YYYY-MM-DD)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch form submissions in the date range
    const { data: formSubmissions, error: formError } = await supabase
      .from("hubspot_form_submissions")
      .select("id, disposition, created_at, submitted_by, contact")
      .gte("created_at", `${startDate}T00:00:00Z`)
      .lte("created_at", `${endDate}T23:59:59Z`)
      .order("created_at", { ascending: false });

    if (formError) {
      throw new Error(`Failed to fetch form submissions: ${formError.message}`);
    }

    // Fetch webhook logs in the date range (with some buffer)
    const { data: webhookLogs, error: webhookError } = await supabase
      .from("ringcx_webhook_logs")
      .select("call_id, contact_id, status, created_at")
      .gte("created_at", `${startDate}T00:00:00Z`)
      .lte("created_at", `${endDate}T23:59:59Z`);

    if (webhookError) {
      throw new Error(`Failed to fetch webhook logs: ${webhookError.message}`);
    }

    // Build webhook status breakdown
    const statusBreakdown: Record<string, number> = {};
    for (const log of webhookLogs || []) {
      const status = log.status || "unknown";
      statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    }

    // Build contact_id -> list of webhook timestamps
    const webhookContactMap = new Map<string, number[]>();
    for (const log of webhookLogs || []) {
      const cid = log.contact_id;
      if (!cid) continue;
      if (!webhookContactMap.has(cid)) {
        webhookContactMap.set(cid, []);
      }
      webhookContactMap.get(cid)!.push(new Date(log.created_at).getTime());
    }

    // Reconcile
    const gaps: GapEntry[] = [];
    let matched = 0;
    let corruptedIds = 0;

    for (const form of formSubmissions || []) {
      const contactId = form.submitted_by?.contact_id || "";
      if (!contactId) continue;

      // Skip test contacts unless explicitly included
      if (!includeTestContacts && TEST_CONTACT_IDS.has(contactId)) {
        continue;
      }

      const contactName = form.contact?.name || "Unknown";
      const disposition = form.disposition || "unknown";
      const formTime = new Date(form.created_at).getTime();

      // Check for corrupted scientific notation IDs
      if (/[eE]/.test(contactId) || contactId.includes(" ")) {
        corruptedIds++;
        gaps.push({
          form_submission_id: form.id,
          contact_id: contactId,
          contact_name: contactName,
          disposition,
          form_submitted_at: form.created_at,
          gap_type: "corrupted_id",
        });
        continue;
      }

      const webhookTimestamps = webhookContactMap.get(contactId);

      if (!webhookTimestamps) {
        // No webhook logs at all for this contact
        gaps.push({
          form_submission_id: form.id,
          contact_id: contactId,
          contact_name: contactName,
          disposition,
          form_submitted_at: form.created_at,
          gap_type: "no_webhook",
        });
      } else {
        // Check if any webhook is within the match window
        const hasMatch = webhookTimestamps.some(
          (wt) => Math.abs(formTime - wt) < MATCH_WINDOW_SECONDS * 1000
        );

        if (hasMatch) {
          matched++;
        } else {
          gaps.push({
            form_submission_id: form.id,
            contact_id: contactId,
            contact_name: contactName,
            disposition,
            form_submitted_at: form.created_at,
            gap_type: "no_nearby_webhook",
          });
        }
      }
    }

    const totalConsidered = matched + gaps.length;
    const gapRate = totalConsidered > 0
      ? ((gaps.length / totalConsidered) * 100)
      : 0;

    const response: ReconciliationResponse = {
      summary: {
        total_form_submissions: totalConsidered,
        matched,
        unmatched: gaps.length,
        gap_rate_percent: Math.round(gapRate * 10) / 10,
        corrupted_ids: corruptedIds,
        date_range: { start: startDate, end: endDate },
      },
      gaps,
      webhook_status_breakdown: statusBreakdown,
    };

    console.log(
      `Reconciliation: ${matched} matched, ${gaps.length} gaps (${gapRate.toFixed(1)}%) out of ${totalConsidered} form submissions`
    );

    return new Response(JSON.stringify(response, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in disposition-reconciliation:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
