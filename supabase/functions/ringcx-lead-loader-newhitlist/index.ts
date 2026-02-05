import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  HubSpotListWebhookPayload,
  RingCXLeadData,
  getRingCentralAccessToken,
  getHubSpotContact,
  pushLeadToRingCX,
  formatPhoneNumber,
} from "../_shared/ringcx-lead-loader-base.ts";

const CAMPAIGN_TYPE = "NewHitlist";
const CAMPAIGN_ID_FIELD = "ringcx_campaignid_newhitlist";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: HubSpotListWebhookPayload = await req.json();
    console.log(`[${CAMPAIGN_TYPE}] Received HubSpot list webhook:`, JSON.stringify(payload, null, 2));

    if (!payload.objectId) {
      throw new Error("objectId (contact ID) is required");
    }

    const contactId = payload.objectId.toString();

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotAccessToken) {
      console.error("HUBSPOT_ACCESS_TOKEN not configured");
      return new Response(
        JSON.stringify({ success: false, error: "HubSpot integration not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    console.log(`[${CAMPAIGN_TYPE}] Fetching contact ${contactId} from HubSpot...`);
    const contactResult = await getHubSpotContact(contactId, hubspotAccessToken, CAMPAIGN_ID_FIELD);

    if (!contactResult.success || !contactResult.contact) {
      return new Response(
        JSON.stringify({ success: false, error: contactResult.error || "Failed to fetch contact from HubSpot" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    const contact = contactResult.contact;
    const properties = contact.properties;

    const campaignId = properties[CAMPAIGN_ID_FIELD];
    if (!campaignId) {
      console.warn(`[${CAMPAIGN_TYPE}] Contact ${contactId} has no ${CAMPAIGN_ID_FIELD} property`);
      return new Response(
        JSON.stringify({ success: false, error: `Contact does not have a ${CAMPAIGN_TYPE} Campaign ID (${CAMPAIGN_ID_FIELD})` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }

    console.log(`[${CAMPAIGN_TYPE}] Contact has campaign ID: ${campaignId}`);

    const { token: ringcxAccessToken, error: tokenError } = await getRingCentralAccessToken(supabaseClient);

    if (!ringcxAccessToken) {
      console.error("Failed to get RingCX access token:", tokenError);
      return new Response(
        JSON.stringify({ success: false, error: tokenError || "Failed to get RingCX access token" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    const leadData: RingCXLeadData = {
      externId: contactId,
      firstName: properties.firstname || "",
      lastName: properties.lastname || "",
      address1: properties.address || "",
      city: properties.city || "",
      state: properties.state || "",
      zip: properties.zip || "",
      email: properties.email || "",
      phone1: formatPhoneNumber(properties.phone || ""),
      phone2: formatPhoneNumber(properties.mobilephone || ""),
    };

    const result = await pushLeadToRingCX(campaignId, leadData, ringcxAccessToken);

    if (!result.success) {
      await supabaseClient.from("error_log").insert({
        source: `ringcx-lead-loader-${CAMPAIGN_TYPE.toLowerCase()}`,
        error_message: result.error || "Failed to push lead to RingCX",
        error_details: { contactId, campaignId, campaignType: CAMPAIGN_TYPE, error: result.error },
      });

      return new Response(
        JSON.stringify({ success: false, error: result.error || "Failed to push lead to RingCX" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    console.log(`[${CAMPAIGN_TYPE}] Successfully pushed contact ${contactId} to RingCX campaign ${campaignId}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Lead pushed to RingCX successfully",
        contactId: contactId,
        campaignId: campaignId,
        campaignType: CAMPAIGN_TYPE,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error(`[${CAMPAIGN_TYPE}] Error processing webhook:`, error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Unknown error occurred", details: error.stack }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
