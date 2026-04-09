import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  getRingCentralAccessToken,
  updateHubSpotContact,
  searchLeadInCampaign,
} from "../_shared/ringcx-lead-loader-base.ts";
import { notifyGChatError, notifyGChatSuccess } from "../_shared/gchat-notify.ts";

const AGING_THRESHOLD_DAYS = 90;
const BATCH_SIZE = 20;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Find NEW leads that have aged past 90 days
    const cutoff = new Date(Date.now() - AGING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    console.log(`[AgingNew] Querying NEW leads with lead_date <= ${cutoff}`);

    const { data: agedLeads, error: queryError } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("*")
      .eq("current_tier", "NEW")
      .is("moved_to_old_at", null)
      .is("removed_at", null)
      .lte("lead_date", cutoff)
      .limit(BATCH_SIZE);

    if (queryError) {
      console.error("[AgingNew] Query error:", queryError);
      throw new Error(`Failed to query aged leads: ${queryError.message}`);
    }

    if (!agedLeads || agedLeads.length === 0) {
      console.log("[AgingNew] No aged NEW leads found");
      return new Response(
        JSON.stringify({ success: true, moved: 0, message: "No aged leads" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    console.log(`[AgingNew] Found ${agedLeads.length} NEW leads to move to OLD`);

    // Get RingCX token
    const { token: ringcxToken, error: tokenError } = await getRingCentralAccessToken(supabaseClient);
    if (!ringcxToken) {
      await notifyGChatError({
        source: "ringcx-lead-aging-new",
        error: tokenError || "Failed to get RingCX access token",
        details: { agedLeadCount: agedLeads.length },
      });
      throw new Error(tokenError || "Failed to get RingCX access token");
    }

    // Resolve missing ringcx_lead_id by searching RingCX
    for (const lead of agedLeads) {
      if (!lead.ringcx_lead_id && lead.current_campaign_id) {
        console.log(`[AgingNew] Lead ${lead.contact_id} missing ringcx_lead_id — searching campaign ${lead.current_campaign_id}`);
        const searchResult = await searchLeadInCampaign(
          lead.current_campaign_id,
          lead.contact_id,
          ringcxToken,
        );
        if (searchResult.success && searchResult.leadId) {
          lead.ringcx_lead_id = searchResult.leadId;
          console.log(`[AgingNew] Resolved lead ${lead.contact_id} → leadId ${searchResult.leadId}`);
          await supabaseClient
            .from("ringcx_lead_routing")
            .update({ ringcx_lead_id: searchResult.leadId, updated_at: new Date().toISOString() })
            .eq("id", lead.id);
        } else {
          console.warn(`[AgingNew] Could not find lead ${lead.contact_id} in RingCX campaign ${lead.current_campaign_id}`);
        }
      }
    }

    // Group leads by source→dest campaign pair for batch moves
    const moveGroups = new Map<string, typeof agedLeads>();
    for (const lead of agedLeads) {
      if (!lead.ringcx_lead_id) {
        console.warn(`[AgingNew] Lead ${lead.contact_id} has no ringcx_lead_id after search — marking as orphaned`);
        await supabaseClient
          .from("ringcx_lead_routing")
          .update({
            removed_at: new Date().toISOString(),
            removal_reason: "aging_orphan_not_in_ringcx",
            updated_at: new Date().toISOString(),
          })
          .eq("id", lead.id);
        await supabaseClient.from("lead_routing_events").insert({
          contact_id: lead.contact_id,
          event_type: "aging_orphan_removed",
          from_campaign_id: lead.current_campaign_id,
          to_campaign_id: null,
          from_tier: "NEW",
          to_tier: "ARCHIVED",
          details: { reason: "no_ringcx_lead_id_after_search", lead_date: lead.lead_date, source: "aging_cron" },
        });
        continue;
      }
      if (!lead.old_campaign_id) {
        console.warn(`[AgingNew] Lead ${lead.contact_id} has no old_campaign_id — skipping`);
        continue;
      }
      const key = `${lead.new_campaign_id}→${lead.old_campaign_id}`;
      const group = moveGroups.get(key) || [];
      group.push(lead);
      moveGroups.set(key, group);
    }

    let totalMoved = 0;
    const errors: string[] = [];
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");

    for (const [key, group] of moveGroups) {
      const [sourceCampaign, destCampaign] = key.split("→");
      const leadIds = group.map((l) => parseInt(l.ringcx_lead_id!, 10));

      console.log(`[AgingNew] Moving ${leadIds.length} leads: campaign ${sourceCampaign} → ${destCampaign}`);

      // MOVE_TO_CAMPAIGN API — same pattern as ringcx-lead-mover/index.ts
      const moveUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=MOVE_TO_CAMPAIGN`;
      const moveBody = {
        campaignLeadSearchCriteria: {
          campaignId: parseInt(sourceCampaign, 10),
          leadIds,
          listIds: [],
          agentDispositions: [],
          systemDispositions: [],
          leadStates: [],
          physicalStates: [],
          leadTimezones: [],
          campaignIds: [parseInt(sourceCampaign, 10)],
        },
        leadActionParams: {
          paramMap: {
            CAMPAIGN_ID: destCampaign,
            LIST_ID: "0",
            LIST_NAME: "Aged from New",
            CREATE_COPY_SETTING: "false",
            DUPLICATE_ACTION_SETTING: "MOVE",
          },
        },
      };

      const moveResponse = await fetch(moveUrl, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${ringcxToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(moveBody),
      });

      const moveText = await moveResponse.text();
      console.log(`[AgingNew] RingCX response ${moveResponse.status}: ${moveText}`);

      if (!moveResponse.ok) {
        const errMsg = `MOVE_TO_CAMPAIGN failed for ${key}: HTTP ${moveResponse.status} — ${moveText}`;
        console.error(`[AgingNew] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      // Update routing rows
      const now = new Date().toISOString();
      for (const lead of group) {
        await supabaseClient
          .from("ringcx_lead_routing")
          .update({
            current_campaign_id: destCampaign,
            current_tier: "OLD",
            moved_to_old_at: now,
            updated_at: now,
          })
          .eq("id", lead.id);

        // Log routing event
        const { error: evtErr } = await supabaseClient.from("lead_routing_events").insert({
          contact_id: lead.contact_id,
          event_type: "moved_new_to_old",
          from_campaign_id: sourceCampaign,
          to_campaign_id: destCampaign,
          from_tier: "NEW",
          to_tier: "OLD",
          ringcx_lead_id: lead.ringcx_lead_id,
          details: { lead_date: lead.lead_date, source: "aging_cron" },
        });
        if (evtErr) console.warn("Failed to log routing event:", evtErr);

        // Fire-and-forget HubSpot update (non-blocking)
        if (hubspotAccessToken) {
          updateHubSpotContact(lead.contact_id, hubspotAccessToken, {
            n0_old_list_id: destCampaign,
            ringcx_load_status: `[Aging] NEW→OLD campaign ${destCampaign} at ${now.replace("T", " ").substring(0, 19)}`,
          }).catch((e: unknown) => console.warn(`[AgingNew] HubSpot update failed for ${lead.contact_id}:`, e));
        }
      }

      totalMoved += group.length;
    }

    // Summary notification
    const summary = `Lead Aging NEW→OLD: moved ${totalMoved}/${agedLeads.length} leads${errors.length > 0 ? ` (${errors.length} errors)` : ""}`;
    console.log(`[AgingNew] ${summary}`);

    // Audit trail: log a run summary event for daily compliance reporting
    await supabaseClient.from("lead_routing_events").insert({
      contact_id: 0,
      event_type: "aging_run_summary",
      from_tier: "NEW",
      to_tier: "OLD",
      details: {
        source: "ringcx-lead-aging-new",
        eligible: agedLeads.length,
        moved: totalMoved,
        errors: errors.length,
        error_messages: errors.slice(0, 5),
        run_at: new Date().toISOString(),
      },
    });

    if (errors.length > 0) {
      await notifyGChatError({
        source: "ringcx-lead-aging-new",
        error: summary,
        details: { errors: errors.slice(0, 3) },
      });
    } else if (totalMoved > 0) {
      await notifyGChatSuccess(summary);
    }

    return new Response(
      JSON.stringify({ success: true, moved: totalMoved, total: agedLeads.length, errors: errors.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("[AgingNew] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
