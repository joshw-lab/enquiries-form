import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  HubSpotListWebhookPayload,
  RingCXLeadData,
  getRingCentralAccessToken,
  getHubSpotContact,
  pushLeadToRingCX,
  updateHubSpotContact,
  formatPhoneNumber,
  isValidE164,
  searchLeadInCampaign,
} from "../_shared/ringcx-lead-loader-base.ts";
import { notifyGChatError } from "../gchat-notify.ts";

const CAMPAIGN_TYPE = "Old";
const CAMPAIGN_ID_FIELD = "n0_old_list_id";
const LEAD_ID_FIELD = "old_rc_campaign_leadid";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: HubSpotListWebhookPayload = await req.json();
    console.log(`[${CAMPAIGN_TYPE}] Received HubSpot webhook:`, JSON.stringify(payload, null, 2));
    console.log(`[${CAMPAIGN_TYPE}] Payload keys:`, Object.keys(payload));

    // Extract contact ID - HubSpot can send it in multiple formats
    const contactIdRaw = payload.objectId || payload.contactId || payload.hubspotContactId || payload.externID;

    if (!contactIdRaw) {
      console.error(`[${CAMPAIGN_TYPE}] Missing contact ID in payload:`, payload);
      throw new Error("Contact ID is required (objectId, contactId, hubspotContactId, or externID). Received: " + JSON.stringify(payload));
    }

    const contactId = contactIdRaw.toString();

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
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

      await supabaseClient.from("error_log").insert({
        source: `ringcx-lead-loader-${CAMPAIGN_TYPE.toLowerCase()}`,
        error_message: tokenError || "Failed to get RingCX access token",
        error_details: { contactId, campaignId, campaignType: CAMPAIGN_TYPE, error: tokenError },
      });

      await notifyGChatError({
        source: `ringcx-lead-loader-${CAMPAIGN_TYPE.toLowerCase()}`,
        error: tokenError || "Failed to get RingCX access token",
        details: { contactId, campaignId, campaignType: CAMPAIGN_TYPE },
      });

      return new Response(
        JSON.stringify({ success: false, error: tokenError || "Failed to get RingCX access token" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Format phone numbers and validate E.164
    const phone1 = formatPhoneNumber(properties.phone || "");
    const phone2 = formatPhoneNumber(properties.mobilephone || "");

    // Check for a valid phone number — if neither phone is valid E.164,
    // return 200 so HubSpot does NOT retry (this contact simply can't be loaded).
    if (!isValidE164(phone1) && !isValidE164(phone2)) {
      const msg = `Contact ${contactId} has no valid E.164 phone number (phone="${properties.phone || ""}", mobile="${properties.mobilephone || ""}"). Skipping.`;
      console.warn(`[${CAMPAIGN_TYPE}] ${msg}`);

      await supabaseClient.from("error_log").insert({
        source: `ringcx-lead-loader-${CAMPAIGN_TYPE.toLowerCase()}`,
        error_message: msg,
        error_details: { contactId, campaignId, campaignType: CAMPAIGN_TYPE, phone: properties.phone, mobile: properties.mobilephone },
      });

      // Return 200 — this is a data quality issue, not a transient error. Do NOT retry.
      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: "no_valid_phone", error: msg }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
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
      phone1: isValidE164(phone1) ? phone1 : (isValidE164(phone2) ? phone2 : ""),
      phone2: isValidE164(phone1) && isValidE164(phone2) ? phone2 : "",
    };

    const result = await pushLeadToRingCX(campaignId, leadData, ringcxAccessToken);

    if (!result.success) {
      await supabaseClient.from("error_log").insert({
        source: `ringcx-lead-loader-${CAMPAIGN_TYPE.toLowerCase()}`,
        error_message: result.error || "Failed to push lead to RingCX",
        error_details: { contactId, campaignId, campaignType: CAMPAIGN_TYPE, error: result.error },
      });

      // Return 200 for data/validation failures (non-retryable) — only 500 for auth/infra failures
      const isRetryable = (result.error || "").includes("access token") || (result.error || "").includes("HTTP 5");
      const statusCode = isRetryable ? 500 : 200;

      return new Response(
        JSON.stringify({ success: false, error: result.error || "Failed to push lead to RingCX" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: statusCode }
      );
    }

    console.log(`[${CAMPAIGN_TYPE}] Successfully pushed contact ${contactId} to RingCX campaign ${campaignId}`);

    // Search for the lead to get the RingCX lead ID
    const searchResult = await searchLeadInCampaign(campaignId, contactId, ringcxAccessToken, properties.firstname);

    // Write back the RingCX lead ID to HubSpot
    const leadId = searchResult.success ? searchResult.leadId : result.leadId;
    if (leadId) {
      console.log(`[${CAMPAIGN_TYPE}] Writing back lead ID ${leadId} to HubSpot field ${LEAD_ID_FIELD}`);
      const writebackResult = await updateHubSpotContact(contactId, hubspotAccessToken, {
        [LEAD_ID_FIELD]: leadId,
      });
      if (!writebackResult.success) {
        console.error(`[${CAMPAIGN_TYPE}] Failed to write back lead ID to HubSpot:`, writebackResult.error);
      }
    } else {
      console.warn(`[${CAMPAIGN_TYPE}] No lead ID found, skipping HubSpot writeback`);
    }

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
