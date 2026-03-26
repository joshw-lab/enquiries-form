import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  getRingCentralAccessToken,
} from "../_shared/ringcx-lead-loader-base.ts";
import { notifyGChatError, notifyGChatSuccess } from "../_shared/gchat-notify.ts";

// All active campaign IDs: HOT (272-277) + NEW + OLD for each state + legacy (182)
const ALL_ACTIVE_CAMPAIGN_IDS = [182, 222, 223, 226, 227, 230, 231, 234, 235, 238, 239, 242, 243, 272, 273, 274, 275, 276, 277];
const ARCHIVE_CAMPAIGN_ID = 289;
const BATCH_SIZE = 5; // process 5 contacts at a time

// Same terminal dispositions as the disposition webhook
const TERMINAL_DISPOSITIONS = new Set([
  "booked_test", "booked", "book_water_test", "booked_water_test",
  "booked_test_single_leg", "booked_single_leg", "single_leg",
  "not_interested", "not_intrested", "ni",
  "wrong_number", "wrongnumber", "wrong", "invalid_number",
  "other_departments", "other_department", "transfer",
  "unable_to_service", "cannot_service", "out_of_area",
  "do_not_call", "donotcall", "dnc", "do_not_register",
  "not_qualified", "notqualified", "nq",
  "internal_closed_deal", "closed_deal",
  "internal_deposit_taken", "deposit_taken", "deposit",
]);

/**
 * Search for a lead in a RingCX campaign by externId.
 * Returns { campaignId, leadId } if found, null otherwise.
 */
async function findLeadInCampaigns(
  externId: string,
  campaignIds: number[],
  ringcxToken: string,
): Promise<{ campaignId: number; leadId: number } | null> {
  // Search all campaigns in parallel
  const results = await Promise.all(
    campaignIds.map(async (campaignId) => {
      try {
        const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ringcxToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ campaignIds: [campaignId] }),
        });

        if (!resp.ok) return null;

        const data = await resp.json();
        const leads = Array.isArray(data) ? data : (data.leads || data.data || []);

        for (const lead of leads) {
          const eid = String(lead.externId || lead.extern_id || "");
          if (eid === externId) {
            return {
              campaignId,
              leadId: Number(lead.leadId || lead.lead_id || lead.id || 0),
            };
          }
        }
      } catch {
        // Skip campaign on error
      }
      return null;
    }),
  );

  return results.find((r) => r !== null) || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let dryRun = true;
    let hours = 48;

    try {
      const payload = await req.json();
      if (payload.dryRun === false) dryRun = false;
      if (typeof payload.hours === "number") hours = payload.hours;
    } catch {
      // Defaults: dryRun=true, hours=48
    }

    console.log(`[RemediateDispositions] Starting (dryRun=${dryRun}, hours=${hours})`);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "",
    );

    // Find terminal dispositions from webhook logs in the lookback window
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    console.log(`[RemediateDispositions] Querying webhook logs since ${cutoff}`);

    const { data: webhookLogs, error: queryError } = await supabaseClient
      .from("ringcx_webhook_logs")
      .select("contact_id, payload, created_at")
      .gte("created_at", cutoff)
      .eq("status", "processed")
      .order("created_at", { ascending: false });

    if (queryError) {
      throw new Error(`Failed to query webhook logs: ${queryError.message}`);
    }

    // Filter to terminal dispositions and deduplicate by contact_id (latest wins)
    const seen = new Set<string>();
    const terminalContacts: { contactId: string; disposition: string; disposedAt: string }[] = [];

    for (const log of webhookLogs || []) {
      const contactId = log.contact_id;
      if (!contactId || seen.has(contactId)) continue;

      const rawDisposition = (log.payload?.disposition || "")
        .toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

      if (!TERMINAL_DISPOSITIONS.has(rawDisposition)) continue;

      seen.add(contactId);
      terminalContacts.push({
        contactId,
        disposition: rawDisposition,
        disposedAt: log.created_at,
      });
    }

    console.log(`[RemediateDispositions] Found ${terminalContacts.length} unique terminal dispositions in last ${hours}h`);

    if (terminalContacts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, dryRun, remediated: 0, message: "No terminal dispositions found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    // Check which of these contacts still have active leads in RingCX
    const { token: ringcxToken, error: tokenError } = await getRingCentralAccessToken(supabaseClient);
    if (!ringcxToken) {
      throw new Error(tokenError || "Failed to get RingCX access token");
    }

    const remediated: { contactId: string; disposition: string; campaignId: number; leadId: number }[] = [];
    const alreadyClean: string[] = [];
    const errors: string[] = [];

    // Process in batches
    for (let i = 0; i < terminalContacts.length; i += BATCH_SIZE) {
      const batch = terminalContacts.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async ({ contactId, disposition }) => {
          try {
            // First check if there's already an archived routing record
            const { data: routing } = await supabaseClient
              .from("ringcx_lead_routing")
              .select("id, current_campaign_id, ringcx_lead_id")
              .eq("contact_id", contactId)
              .is("removed_at", null)
              .maybeSingle();

            // If no active routing, check RingCX directly
            let found: { campaignId: number; leadId: number } | null = null;

            if (routing?.ringcx_lead_id) {
              // Active routing exists — lead wasn't properly archived
              const cid = parseInt(routing.current_campaign_id, 10);
              if (cid !== ARCHIVE_CAMPAIGN_ID && ALL_ACTIVE_CAMPAIGN_IDS.includes(cid)) {
                found = { campaignId: cid, leadId: parseInt(routing.ringcx_lead_id, 10) };
              }
            } else {
              // No active routing — search RingCX directly
              // Get a fresh token for each batch to avoid expiry
              const { token: freshToken } = await getRingCentralAccessToken(supabaseClient);
              if (freshToken) {
                found = await findLeadInCampaigns(contactId, ALL_ACTIVE_CAMPAIGN_IDS, freshToken);
              }
            }

            if (!found) {
              alreadyClean.push(contactId);
              return;
            }

            if (dryRun) {
              remediated.push({ contactId, disposition, ...found });
              return;
            }

            // Live: move lead to archive campaign
            const { token: moveToken } = await getRingCentralAccessToken(supabaseClient);
            if (!moveToken) {
              errors.push(`${contactId}: failed to get token for move`);
              return;
            }

            const moveUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=MOVE_TO_CAMPAIGN`;
            const moveBody = {
              campaignLeadSearchCriteria: {
                campaignId: found.campaignId,
                leadIds: [found.leadId],
                listIds: [],
                agentDispositions: [],
                systemDispositions: [],
                leadStates: [],
                physicalStates: [],
                leadTimezones: [],
                campaignIds: [found.campaignId],
              },
              leadActionParams: {
                paramMap: {
                  CAMPAIGN_ID: ARCHIVE_CAMPAIGN_ID.toString(),
                  LIST_ID: "0",
                  LIST_NAME: `Remediation — ${disposition}`,
                  CREATE_COPY_SETTING: "false",
                  DUPLICATE_ACTION_SETTING: "MOVE",
                },
              },
            };

            const moveResp = await fetch(moveUrl, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${moveToken}`,
              },
              body: JSON.stringify(moveBody),
            });

            if (!moveResp.ok) {
              const moveText = await moveResp.text();
              errors.push(`${contactId}: move failed HTTP ${moveResp.status} — ${moveText.substring(0, 200)}`);
              return;
            }

            console.log(`[RemediateDispositions] Moved ${contactId} from campaign ${found.campaignId} to archive`);

            // Update or create routing record
            const now = new Date().toISOString();
            if (routing) {
              await supabaseClient
                .from("ringcx_lead_routing")
                .update({
                  current_tier: "ARCHIVED",
                  current_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                  removed_at: now,
                  removal_reason: `disposition:${disposition}`,
                  updated_at: now,
                })
                .eq("id", routing.id);
            } else {
              await supabaseClient.from("ringcx_lead_routing").insert({
                contact_id: contactId,
                current_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                current_tier: "ARCHIVED",
                ringcx_lead_id: String(found.leadId),
                removed_at: now,
                removal_reason: `disposition:${disposition}`,
                lead_date: now,
                ingested_at: now,
              }).catch((e: unknown) => console.warn(`Failed to insert routing for ${contactId}:`, e));
            }

            // Log routing event
            await supabaseClient.from("lead_routing_events").insert({
              contact_id: contactId,
              event_type: "remediation_archived",
              from_campaign_id: String(found.campaignId),
              to_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
              from_tier: "UNKNOWN",
              to_tier: "ARCHIVED",
              ringcx_lead_id: String(found.leadId),
              details: {
                source: "remediate_stale_dispositions",
                disposition,
                hours_lookback: hours,
              },
            }).catch((e: unknown) => console.warn(`Failed to log event for ${contactId}:`, e));

            remediated.push({ contactId, disposition, ...found });
          } catch (err) {
            errors.push(`${contactId}: ${(err as Error).message}`);
          }
        }),
      );
    }

    const summary = dryRun
      ? `Remediation DRY RUN: ${remediated.length} stale leads found in active campaigns (${alreadyClean.length} already clean)`
      : `Remediation LIVE: ${remediated.length} leads moved to archive (${alreadyClean.length} already clean, ${errors.length} errors)`;

    console.log(`[RemediateDispositions] ${summary}`);

    if (!dryRun && remediated.length > 0) {
      await notifyGChatSuccess(summary);
    }
    if (errors.length > 0) {
      await notifyGChatError({
        source: "ringcx-remediate-stale-dispositions",
        error: summary,
        details: { errors: errors.slice(0, 5) },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        hours,
        totalTerminalDispositions: terminalContacts.length,
        remediated: remediated.length,
        alreadyClean: alreadyClean.length,
        errors: errors.length,
        remediatedLeads: remediated,
        errorDetails: errors.slice(0, 10),
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    console.error("[RemediateDispositions] Fatal error:", error);
    await notifyGChatError({
      source: "ringcx-remediate-stale-dispositions",
      error: (error as Error).message || "Unknown error",
    });
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
