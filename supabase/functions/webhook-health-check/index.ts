import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Webhook Health Check
 *
 * Quick pulse check for the disposition webhook pipeline.
 * Hit this anytime during the day to see:
 *   - Today's webhook volume and status breakdown
 *   - Recent failures with error details
 *   - Form submissions without matching webhooks (today's gaps)
 *   - Last successful webhook timestamp
 *
 * GET or POST — no params required (defaults to today).
 * Optional: { "date": "2026-03-03" } to check a specific date.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let checkDate: string;

    if (req.method === "POST") {
      try {
        const body = await req.json();
        checkDate = body.date || new Date().toISOString().split("T")[0];
      } catch {
        checkDate = new Date().toISOString().split("T")[0];
      }
    } else {
      checkDate = new Date().toISOString().split("T")[0];
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const dayStart = `${checkDate}T00:00:00Z`;
    const dayEnd = `${checkDate}T23:59:59Z`;

    // 1. Webhook logs for the day — status breakdown
    const { data: webhookLogs, error: webhookError } = await supabase
      .from("ringcx_webhook_logs")
      .select("id, call_id, contact_id, status, error_message, hubspot_call_id, created_at")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: false });

    if (webhookError) throw new Error(`Webhook query failed: ${webhookError.message}`);

    const logs = webhookLogs || [];

    // Status breakdown
    const statusCounts: Record<string, number> = {};
    for (const log of logs) {
      const s = log.status || "unknown";
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    // Unique calls (deduplicate by call_id)
    const uniqueCallIds = new Set(logs.map((l) => l.call_id));

    // Recent failures (last 10)
    const failures = logs
      .filter((l) => l.status === "failed")
      .slice(0, 10)
      .map((l) => ({
        call_id: l.call_id,
        contact_id: l.contact_id,
        error: l.error_message,
        time: l.created_at,
      }));

    // Last successful webhook
    const lastSuccess = logs.find(
      (l) => l.status === "processed" && l.hubspot_call_id
    );

    // 2. Form submissions for the day
    const { data: formSubs, error: formError } = await supabase
      .from("hubspot_form_submissions")
      .select("id, disposition, created_at, submitted_by, contact")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: false });

    if (formError) throw new Error(`Form query failed: ${formError.message}`);

    const forms = formSubs || [];

    // Test contact IDs to exclude
    const TEST_CONTACTS = new Set([
      "42694751", "17461201", "184364994875", "42743401",
      "56245751", "44169201", "185015538276",
    ]);

    // Build webhook contact set for the day (with 24h window)
    const webhookContactTimestamps = new Map<string, number[]>();
    for (const log of logs) {
      const cid = log.contact_id;
      if (!cid) continue;
      if (!webhookContactTimestamps.has(cid)) {
        webhookContactTimestamps.set(cid, []);
      }
      webhookContactTimestamps.get(cid)!.push(new Date(log.created_at).getTime());
    }

    // Find form submissions with no matching webhook
    const gaps: Array<{
      contact_id: string;
      contact_name: string;
      disposition: string;
      submitted_at: string;
    }> = [];

    for (const form of forms) {
      const cid = form.submitted_by?.contact_id || "";
      if (!cid || TEST_CONTACTS.has(cid)) continue;

      const formTime = new Date(form.created_at).getTime();
      const webhookTimes = webhookContactTimestamps.get(cid);

      if (!webhookTimes) {
        gaps.push({
          contact_id: cid,
          contact_name: form.contact?.name || "Unknown",
          disposition: form.disposition || "unknown",
          submitted_at: form.created_at,
        });
      } else {
        const hasMatch = webhookTimes.some(
          (wt) => Math.abs(formTime - wt) < 86400 * 1000
        );
        if (!hasMatch) {
          gaps.push({
            contact_id: cid,
            contact_name: form.contact?.name || "Unknown",
            disposition: form.disposition || "unknown",
            submitted_at: form.created_at,
          });
        }
      }
    }

    // 3. Build health summary
    const totalWebhooks = logs.length;
    const processed = statusCounts["processed"] || 0;
    const failed = statusCounts["failed"] || 0;
    const skipped = statusCounts["skipped"] || 0;
    const processing = statusCounts["processing"] || 0;
    const received = statusCounts["received"] || 0;

    // Health score: green/yellow/red
    let health: "🟢 healthy" | "🟡 warning" | "🔴 critical";
    if (failed === 0 && gaps.length === 0) {
      health = "🟢 healthy";
    } else if (failed > 0 || gaps.length > 0) {
      health = failed > 5 || gaps.length > 5 ? "🔴 critical" : "🟡 warning";
    } else {
      health = "🟢 healthy";
    }

    const response = {
      health,
      date: checkDate,
      checked_at: new Date().toISOString(),
      webhooks: {
        total: totalWebhooks,
        unique_calls: uniqueCallIds.size,
        status_breakdown: statusCounts,
        last_successful: lastSuccess
          ? {
              call_id: lastSuccess.call_id,
              hubspot_call_id: lastSuccess.hubspot_call_id,
              time: lastSuccess.created_at,
            }
          : null,
      },
      form_submissions: {
        total: forms.length,
        production_only: forms.filter(
          (f) => !TEST_CONTACTS.has(f.submitted_by?.contact_id || "")
        ).length,
      },
      gaps: {
        count: gaps.length,
        details: gaps,
      },
      recent_failures: failures,
      // Quick action hints
      hints:
        failed > 0
          ? [
              `${failed} webhooks failed today — check recent_failures for details`,
              "Common causes: unmapped disposition, contact not found, HubSpot API error",
            ]
          : gaps.length > 0
          ? [
              `${gaps.length} form submissions have no matching webhook — RingCX may not be firing webhooks for these calls`,
              "Use the disposition-reconciliation function for a deeper analysis",
            ]
          : totalWebhooks === 0
          ? [
              "No webhooks received today — either no calls have been made or the webhook endpoint isn't configured in RingCX",
            ]
          : ["All systems nominal ✅"],
    };

    return new Response(JSON.stringify(response, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in webhook-health-check:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
