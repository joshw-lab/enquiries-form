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
  hasRecentFailure,
} from "../_shared/ringcx-lead-loader-base.ts";
import { notifyGChatError } from "../_shared/gchat-notify.ts";

const AGING_THRESHOLD_HOURS = 72;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: HubSpotListWebhookPayload = await req.json();
    console.log("[LeadIngest] Received webhook:", JSON.stringify(payload, null, 2));

    // Extract contact ID
    const contactIdRaw = payload.objectId || payload.contactId || payload.hubspotContactId || payload.externID;
    if (!contactIdRaw) {
      throw new Error("contactId is required (objectId, contactId, hubspotContactId, or externID)");
    }
    const contactId = contactIdRaw.toString();

    // Extract campaign IDs from webhook payload (set by HubSpot workflow branches)
    const hotCampaignId = (payload.hotCampaignId || payload.hot_campaign_id || "").toString();
    const newCampaignId = (payload.newCampaignId || payload.new_campaign_id || "").toString();
    const oldCampaignId = (payload.oldCampaignId || payload.old_campaign_id || "").toString();

    if (!hotCampaignId) {
      throw new Error("hotCampaignId is required in webhook payload");
    }
    if (!newCampaignId) {
      throw new Error("newCampaignId is required in webhook payload");
    }

    console.log(`[LeadIngest] Contact ${contactId}: hot=${hotCampaignId}, new=${newCampaignId}, old=${oldCampaignId || "none"}`);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Dedup: skip if this contact already failed recently
    const recentFailure = await hasRecentFailure(supabaseClient, contactId);
    if (recentFailure.suppressed) {
      console.log(`[LeadIngest] Skipping contact ${contactId} — recent failure: ${recentFailure.reason}`);
      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: "recent_failure_suppressed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotAccessToken) {
      return new Response(
        JSON.stringify({ success: false, error: "HUBSPOT_ACCESS_TOKEN not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Fetch contact from HubSpot (getHubSpotContact already fetches lead_date, createdate, phone, state, etc.)
    console.log(`[LeadIngest] Fetching contact ${contactId} from HubSpot...`);
    const contactResult = await getHubSpotContact(contactId, hubspotAccessToken, "n0_new_list_id");
    if (!contactResult.success || !contactResult.contact) {
      return new Response(
        JSON.stringify({ success: false, error: contactResult.error || "Failed to fetch contact" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    const properties = contactResult.contact.properties;

    // Format and validate phone
    const phone1 = formatPhoneNumber(properties.phone || "");
    const phone2 = formatPhoneNumber(properties.mobilephone || "");

    if (!isValidE164(phone1) && !isValidE164(phone2)) {
      const msg = `Contact ${contactId} has no valid E.164 phone (phone="${properties.phone || ""}", mobile="${properties.mobilephone || ""}"). Skipping.`;
      console.warn(`[LeadIngest] ${msg}`);

      await supabaseClient.from("error_log").insert({
        source: "ringcx-lead-ingest",
        error_message: msg,
        error_details: { contactId, phone: properties.phone, mobile: properties.mobilephone },
      });

      await notifyGChatError({ source: "ringcx-lead-ingest", error: msg, details: { contactId } });

      await updateHubSpotContact(contactId, hubspotAccessToken, {
        ringcx_load_status: `[Ingest] Failed — No valid phone. phone="${properties.phone || ""}" mobile="${properties.mobilephone || ""}"`,
      });

      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: "no_valid_phone" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // Determine tier: HOT if lead_date < 72h ago, otherwise push straight to NEW
    const leadDateStr = properties.lead_date || properties.createdate;
    let tier: "HOT" | "NEW" = "HOT";
    let targetCampaignId = hotCampaignId;
    let dialPriority: "IMMEDIATE" | "NORMAL" = "IMMEDIATE";
    let ageHours: number | null = null;

    if (leadDateStr) {
      const leadDateMs = new Date(leadDateStr).getTime();
      ageHours = Math.round(((Date.now() - leadDateMs) / (1000 * 60 * 60)) * 10) / 10;

      if (ageHours >= AGING_THRESHOLD_HOURS) {
        tier = "NEW";
        targetCampaignId = newCampaignId;
        dialPriority = "NORMAL";
      }
    }

    console.log(`[LeadIngest] Tier=${tier}, campaign=${targetCampaignId}, priority=${dialPriority}, age=${ageHours ?? "unknown"}h`);

    // Get RingCX token
    const { token: ringcxToken, error: tokenError } = await getRingCentralAccessToken(supabaseClient);
    if (!ringcxToken) {
      await supabaseClient.from("error_log").insert({
        source: "ringcx-lead-ingest",
        error_message: tokenError || "Failed to get RingCX access token",
        error_details: { contactId, tier },
      });
      await notifyGChatError({
        source: "ringcx-lead-ingest",
        error: tokenError || "Failed to get RingCX access token",
        details: { contactId },
      });
      return new Response(
        JSON.stringify({ success: false, error: tokenError }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Build lead data
    const numContacted = parseInt(properties.num_contacted_notes || "0", 10);
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
      numContacted,
    };

    // Push to RingCX
    const result = await pushLeadToRingCX(targetCampaignId, leadData, ringcxToken, dialPriority);

    if (!result.success) {
      await supabaseClient.from("error_log").insert({
        source: "ringcx-lead-ingest",
        error_message: result.error || "Failed to push lead",
        error_details: { contactId, tier, campaignId: targetCampaignId, diagnostic: result.diagnostic },
      });
      await notifyGChatError({
        source: "ringcx-lead-ingest",
        error: result.error || "Failed to push lead",
        details: { contactId, tier, campaignId: targetCampaignId },
      });
      await updateHubSpotContact(contactId, hubspotAccessToken, {
        ringcx_load_status: `[Ingest] Failed — ${(result.error || "Unknown").substring(0, 250)}`,
      });

      const isRetryable = (result.error || "").includes("access token") || (result.error || "").includes("HTTP 5");
      return new Response(
        JSON.stringify({ success: false, error: result.error }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: isRetryable ? 500 : 200 }
      );
    }

    console.log(`[LeadIngest] Successfully pushed contact ${contactId} to ${tier} campaign ${targetCampaignId}`);

    // Search for lead ID
    const searchResult = await searchLeadInCampaign(targetCampaignId, contactId, ringcxToken);
    const leadId = searchResult.success ? searchResult.leadId : result.leadId;

    // Record in lead_loads (existing pattern for hourly reporting)
    await supabaseClient.from("lead_loads").insert({
      contact_id: contactId,
      campaign_id: targetCampaignId,
      campaign_type: tier,
      lead_id: leadId || null,
      dial_priority: dialPriority,
      priority_reason: tier === "HOT" ? "hot_lead" : "aged_into_new",
      priority_context: { lead_date: leadDateStr || null, age_hours: ageHours, tier },
      contact_first_name: properties.firstname || null,
      contact_last_name: properties.lastname || null,
      contact_state: properties.state || null,
      contact_postcode: properties.zip || null,
      contact_email: properties.email || null,
      contact_phone: phone1 || phone2 || null,
    }).then(() => {}).catch((err: unknown) => console.warn("Failed to log lead load:", err));

    // Upsert into ringcx_lead_routing
    const now = new Date().toISOString();
    await supabaseClient.from("ringcx_lead_routing").upsert({
      contact_id: contactId,
      hot_campaign_id: hotCampaignId,
      new_campaign_id: newCampaignId,
      old_campaign_id: oldCampaignId || null,
      current_campaign_id: targetCampaignId,
      current_tier: tier,
      ringcx_lead_id: leadId || null,
      lead_date: leadDateStr || now,
      ingested_at: now,
      moved_to_new_at: tier === "NEW" ? now : null,
      contact_state: properties.state || null,
      contact_phone: phone1 || phone2 || null,
      updated_at: now,
    }, { onConflict: "contact_id" });

    // Write back status to HubSpot
    const statusMsg = `[Ingest] ${tier} campaign ${targetCampaignId}${leadId ? ` (lead ${leadId})` : ""} at ${now.replace("T", " ").substring(0, 19)}`;
    await updateHubSpotContact(contactId, hubspotAccessToken, {
      ringcx_load_status: statusMsg,
    });

    return new Response(
      JSON.stringify({
        success: true,
        contactId,
        tier,
        campaignId: targetCampaignId,
        dialPriority,
        leadId: leadId || null,
        ageHours,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("[LeadIngest] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
