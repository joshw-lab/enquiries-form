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

    // Extract required fields from HubSpot workflow webhook payload
    const contactId = (payload.objectId || payload.contactId || payload.hubspotContactId)?.toString();
    const leadId = parseInt(payload.leadId || payload.n0_new_rc_campaign_leadid || "0", 10);
    const sourceCampaignId = parseInt(payload.sourceCampaignId || payload.n0_new_list_id || "0", 10);
    const destCampaignId = parseInt(payload.destCampaignId || payload.n0_old_list_id || "0", 10)
      || NEW_TO_OLD[sourceCampaignId] || 0;

    if (!contactId) {
      throw new Error("contactId is required");
    }
    if (!leadId) {
      throw new Error("leadId is required (RingCX lead ID from n0_new_rc_campaign_leadid)");
    }
    if (!sourceCampaignId) {
      throw new Error("sourceCampaignId is required (n0_new_list_id)");
    }
    if (!destCampaignId) {
      throw new Error(`destCampaignId is required or sourceCampaignId ${sourceCampaignId} has no mapping`);
    }

    console.log(`[LeadMover] Contact ${contactId}: moving lead ${leadId} from campaign ${sourceCampaignId} to ${destCampaignId}`);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

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

    // Update HubSpot properties
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (hubspotAccessToken) {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      const writebackProps: Record<string, string> = {
        n0_old_list_id: destCampaignId.toString(),
        n0_new_rc_campaign_leadid: "",
        ringcx_load_status: `[Move] Moved lead ${leadId} from New campaign ${sourceCampaignId} to Old campaign ${destCampaignId} at ${now}`,
      };

      console.log(`[LeadMover] Updating HubSpot contact ${contactId}:`, writebackProps);
      const writebackResult = await updateHubSpotContact(contactId, hubspotAccessToken, writebackProps);
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
