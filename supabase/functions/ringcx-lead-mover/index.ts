import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  getRingCentralAccessToken,
  updateHubSpotContact,
} from "../_shared/ringcx-lead-loader-base.ts";
import { notifyGChatError } from "../_shared/gchat-notify.ts";

// New campaign ID → Old campaign ID (each state: New, Old, NewHL, OldHL)
const NEW_TO_OLD: Record<number, number> = {
  222: 223, // WA
  226: 227, // QLD
  230: 231, // NSW
  234: 235, // ACT
  238: 239, // VIC
  242: 243, // SA
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    console.log("[LeadMover] Received webhook:", JSON.stringify(payload, null, 2));

    const contactId = (payload.objectId || payload.contactId || payload.hubspotContactId)?.toString();
    if (!contactId) {
      throw new Error("contactId is required");
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Look up lead routing from Supabase (single source of truth)
    const { data: routing, error: routingError } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("*")
      .eq("contact_id", contactId)
      .is("removed_at", null)
      .single();

    if (routingError || !routing) {
      throw new Error(`No routing record found for contact ${contactId}: ${routingError?.message || "not found"}`);
    }

    const leadId = parseInt(routing.ringcx_lead_id || "0", 10);
    const sourceCampaignId = parseInt(routing.current_campaign_id || "0", 10);

    // Determine destination: payload override, or derive from NEW_TO_OLD mapping
    const destCampaignId = parseInt(payload.destCampaignId || "0", 10)
      || NEW_TO_OLD[sourceCampaignId] || 0;

    if (!leadId) {
      throw new Error(`Contact ${contactId} has no ringcx_lead_id in routing table`);
    }
    if (!sourceCampaignId) {
      throw new Error(`Contact ${contactId} has no current_campaign_id in routing table`);
    }
    if (!destCampaignId) {
      throw new Error(`No destination campaign for contact ${contactId} — sourceCampaignId ${sourceCampaignId} has no mapping`);
    }

    console.log(`[LeadMover] Contact ${contactId}: moving lead ${leadId} from campaign ${sourceCampaignId} to ${destCampaignId}`);

    // Get RingCX access token
    const { token: ringcxToken, error: tokenError } = await getRingCentralAccessToken(supabaseClient);
    if (!ringcxToken) {
      await notifyGChatError({
        source: "ringcx-lead-mover",
        error: tokenError || "Failed to get RingCX access token",
        details: { contactId, leadId, sourceCampaignId, destCampaignId },
      });
      throw new Error(tokenError || "Failed to get RingCX access token");
    }

    // Call MOVE_TO_CAMPAIGN API — targeting specific lead by leadId
    const moveUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=MOVE_TO_CAMPAIGN`;
    const moveBody = {
      campaignLeadSearchCriteria: {
        campaignId: sourceCampaignId,
        leadIds: [leadId],
        listIds: [],
        agentDispositions: [],
        systemDispositions: [],
        leadStates: [],
        physicalStates: [],
        leadTimezones: [],
        campaignIds: [sourceCampaignId],
      },
      leadActionParams: {
        paramMap: {
          CAMPAIGN_ID: destCampaignId.toString(),
          LIST_ID: "0",
          LIST_NAME: "Moved from New",
          CREATE_COPY_SETTING: "false",
          DUPLICATE_ACTION_SETTING: "MOVE",
        },
      },
    };

    console.log(`[LeadMover] PUT ${moveUrl}`);
    console.log(`[LeadMover] Body:`, JSON.stringify(moveBody, null, 2));

    const moveResponse = await fetch(moveUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${ringcxToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(moveBody),
    });

    const moveResponseText = await moveResponse.text();
    console.log(`[LeadMover] RingCX response ${moveResponse.status}: ${moveResponseText}`);

    if (!moveResponse.ok) {
      const errMsg = `MOVE_TO_CAMPAIGN failed: HTTP ${moveResponse.status} — ${moveResponseText}`;
      await notifyGChatError({
        source: "ringcx-lead-mover",
        error: errMsg,
        details: { contactId, leadId, sourceCampaignId, destCampaignId },
      });
      throw new Error(errMsg);
    }

    let moveResult: Record<string, unknown> = {};
    try {
      moveResult = JSON.parse(moveResponseText);
    } catch {
      moveResult = { raw: moveResponseText };
    }

    // Update routing table — Supabase is source of truth
    const now = new Date().toISOString();
    await supabaseClient
      .from("ringcx_lead_routing")
      .update({
        current_campaign_id: destCampaignId.toString(),
        current_tier: "OLD",
        moved_to_old_at: now,
        updated_at: now,
      })
      .eq("contact_id", contactId);

    // Log routing event
    const { error: evtErr } = await supabaseClient.from("lead_routing_events").insert({
      contact_id: contactId,
      event_type: "moved_new_to_old",
      from_campaign_id: sourceCampaignId.toString(),
      to_campaign_id: destCampaignId.toString(),
      from_tier: "NEW",
      to_tier: "OLD",
      ringcx_lead_id: leadId.toString(),
      details: { source: "lead_mover" },
    });
    if (evtErr) console.warn("Failed to log routing event:", evtErr);

    // Update HubSpot status
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (hubspotAccessToken) {
      const nowFormatted = now.replace("T", " ").substring(0, 19);
      const writebackResult = await updateHubSpotContact(contactId, hubspotAccessToken, {
        ringcx_load_status: `[Move] Moved lead ${leadId} from campaign ${sourceCampaignId} to ${destCampaignId} at ${nowFormatted}`,
      });
      if (!writebackResult.success) {
        console.error(`[LeadMover] Failed to update HubSpot:`, writebackResult.error);
      }
    }

    console.log(`[LeadMover] Successfully moved contact ${contactId} lead ${leadId} from campaign ${sourceCampaignId} to ${destCampaignId}`);

    return new Response(
      JSON.stringify({
        success: true,
        contactId,
        leadId,
        fromCampaign: sourceCampaignId,
        toCampaign: destCampaignId,
        moveResult,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("[LeadMover] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
