import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  CAMPAIGN_TIMEZONE,
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
import { isInServiceArea } from "../_shared/service-area-postcodes.ts";

const AGING_THRESHOLD_HOURS = 72;
const OLD_THRESHOLD_HOURS = 90 * 24; // 2160 hours = 90 days

// Fallback mapping: New campaign ID → Old campaign ID (by state)
const NEW_TO_OLD: Record<string, string> = {
  "222": "223", // WA
  "226": "227", // QLD
  "230": "231", // NSW
  "234": "235", // ACT
  "238": "239", // VIC
  "242": "243", // SA
};

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

    // Service area postcode filter
    const postcodeCheck = await isInServiceArea(properties.zip, supabaseClient);
    if (!postcodeCheck.allowed) {
      console.log(`[LeadIngest] Contact ${contactId} postcode "${properties.zip}" outside service area — skipping`);

      await supabaseClient.from("lead_routing_events").insert({
        contact_id: contactId,
        event_type: "skipped_outside_service_area",
        from_campaign_id: null,
        to_campaign_id: null,
        from_tier: null,
        to_tier: null,
        ringcx_lead_id: null,
        details: { postcode: properties.zip, state: properties.state || null },
      }).then(() => {}).catch((e: unknown) => console.warn("Failed to log skip event:", e));

      await updateHubSpotContact(contactId, hubspotAccessToken, {
        ringcx_load_status: `[Ingest] Blocked — postcode "${properties.zip}" outside service area`,
      });

      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: "outside_service_area", postcode: properties.zip }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // Determine tier: HOT (<72h), NEW (72h–90d), OLD (>90d)
    const leadDateStr = properties.lead_date || properties.createdate;
    let tier: "HOT" | "NEW" | "OLD" = "HOT";
    let targetCampaignId = hotCampaignId;
    let dialPriority: "IMMEDIATE" | "NORMAL" = "IMMEDIATE";
    let ageHours: number | null = null;

    if (leadDateStr) {
      const leadDateMs = new Date(leadDateStr).getTime();
      ageHours = Math.round(((Date.now() - leadDateMs) / (1000 * 60 * 60)) * 10) / 10;

      if (ageHours >= OLD_THRESHOLD_HOURS) {
        tier = "OLD";
        targetCampaignId = oldCampaignId || NEW_TO_OLD[newCampaignId] || newCampaignId;
        dialPriority = "NORMAL";
      } else if (ageHours >= AGING_THRESHOLD_HOURS) {
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

    // Pre-check: look up existing routing in Supabase first (fast, no RingCX API calls)
    const { data: existingRouting } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("ringcx_lead_id, current_campaign_id, current_tier")
      .eq("contact_id", contactId)
      .is("removed_at", null)
      .maybeSingle();

    if (existingRouting?.ringcx_lead_id) {
      console.log(`[LeadIngest] Lead already exists in ${existingRouting.current_tier} campaign ${existingRouting.current_campaign_id} (leadId=${existingRouting.ringcx_lead_id}) — skipping push to preserve RingCX state`);

      // Log duplicate skip event
      const { error: evtErr } = await supabaseClient.from("lead_routing_events").insert({
        contact_id: contactId,
        event_type: "skipped_duplicate",
        from_campaign_id: null,
        to_campaign_id: existingRouting.current_campaign_id,
        from_tier: null,
        to_tier: existingRouting.current_tier,
        ringcx_lead_id: existingRouting.ringcx_lead_id,
        details: {
          requested_tier: tier,
          requested_campaign: targetCampaignId,
          age_hours: ageHours,
          reason: "lead_already_exists_in_ringcx",
        },
      });
      if (evtErr) console.warn("Failed to log routing event:", evtErr);

      await updateHubSpotContact(contactId, hubspotAccessToken, {
        ringcx_load_status: `[Ingest] Skipped — already in ${existingRouting.current_tier} campaign ${existingRouting.current_campaign_id} (lead ${existingRouting.ringcx_lead_id}). Preserved existing RingCX state.`,
      });

      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          reason: "lead_already_exists",
          existingCampaignId: existingRouting.current_campaign_id,
          existingLeadId: existingRouting.ringcx_lead_id,
          existingTier: existingRouting.current_tier,
          contactId,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // Cross-contact phone dedup: block if a DIFFERENT contact ID with the same phone is already active.
    // This catches duplicate HubSpot contacts created by form submission search misses.
    const phonesToCheck = [phone1, phone2].filter(isValidE164);
    if (phonesToCheck.length > 0) {
      try {
        const { data: phoneDupe } = await supabaseClient
          .from("ringcx_lead_routing")
          .select("contact_id, current_campaign_id, current_tier, ringcx_lead_id, contact_phone")
          .in("contact_phone", phonesToCheck)
          .neq("contact_id", contactId)
          .is("removed_at", null)
          .limit(1)
          .maybeSingle();

        if (phoneDupe) {
          console.warn(`[LeadIngest] CROSS-CONTACT DUPLICATE: Contact ${contactId} has same phone (${phoneDupe.contact_phone}) as existing contact ${phoneDupe.contact_id} in ${phoneDupe.current_tier} campaign ${phoneDupe.current_campaign_id}. Blocking ingestion.`);

          await supabaseClient.from("lead_routing_events").insert({
            contact_id: contactId,
            event_type: "skipped_duplicate",
            from_campaign_id: null,
            to_campaign_id: targetCampaignId,
            from_tier: null,
            to_tier: tier,
            ringcx_lead_id: null,
            details: {
              reason: "cross_contact_phone_duplicate",
              existing_contact_id: phoneDupe.contact_id,
              existing_campaign_id: phoneDupe.current_campaign_id,
              existing_tier: phoneDupe.current_tier,
              matching_phone: phoneDupe.contact_phone,
            },
          });

          await notifyGChatError({
            source: "ringcx-lead-ingest",
            error: `Cross-contact phone duplicate blocked: contact ${contactId} matches existing contact ${phoneDupe.contact_id} by phone ${phoneDupe.contact_phone}. These HubSpot contacts likely need merging.`,
            details: { contactId, existingContactId: phoneDupe.contact_id, phone: phoneDupe.contact_phone },
          });

          await updateHubSpotContact(contactId, hubspotAccessToken, {
            ringcx_load_status: `[Ingest] Blocked — phone ${phoneDupe.contact_phone} already active under contact ${phoneDupe.contact_id} in ${phoneDupe.current_tier} campaign. Likely duplicate HubSpot contact.`,
          });

          return new Response(
            JSON.stringify({
              success: true,
              skipped: true,
              reason: "cross_contact_phone_duplicate",
              existingContactId: phoneDupe.contact_id,
              existingCampaignId: phoneDupe.current_campaign_id,
              matchingPhone: phoneDupe.contact_phone,
              contactId,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
          );
        }
      } catch (phoneCheckErr) {
        // Defense-in-depth — don't block ingestion if the phone check itself fails
        console.warn("[LeadIngest] Phone dedup check failed (proceeding):", phoneCheckErr);
      }
    }

    // Check for recently archived terminal dispositions — prevent re-ingestion loop
    const { data: archivedRouting } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("contact_id, removal_reason, removed_at, current_campaign_id, ringcx_lead_id")
      .eq("contact_id", contactId)
      .not("removed_at", "is", null)
      .like("removal_reason", "disposition:%")
      .order("removed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (archivedRouting?.removed_at) {
      const daysSinceRemoval = (Date.now() - new Date(archivedRouting.removed_at).getTime()) / (1000 * 60 * 60 * 24);
      const REINGEST_COOLDOWN_DAYS = 30;

      if (daysSinceRemoval < REINGEST_COOLDOWN_DAYS) {
        const disposition = archivedRouting.removal_reason?.replace("disposition:", "") || "unknown";
        console.log(`[LeadIngest] Contact ${contactId} was disposed "${disposition}" ${Math.round(daysSinceRemoval)}d ago — blocking re-ingestion (cooldown ${REINGEST_COOLDOWN_DAYS}d)`);

        await supabaseClient.from("lead_routing_events").insert({
          contact_id: contactId,
          event_type: "skipped_previously_disposed",
          from_campaign_id: null,
          to_campaign_id: targetCampaignId,
          from_tier: "ARCHIVED",
          to_tier: tier,
          ringcx_lead_id: archivedRouting.ringcx_lead_id,
          details: {
            original_disposition: disposition,
            days_since_removal: Math.round(daysSinceRemoval),
            cooldown_days: REINGEST_COOLDOWN_DAYS,
            archived_from_campaign: archivedRouting.current_campaign_id,
          },
        }).then(() => {}).catch((e: unknown) => console.warn("Failed to log skip event:", e));

        await updateHubSpotContact(contactId, hubspotAccessToken, {
          ringcx_load_status: `[Ingest] Blocked — previously disposed "${disposition}" ${Math.round(daysSinceRemoval)}d ago. Cooldown ${REINGEST_COOLDOWN_DAYS}d.`,
        });

        return new Response(
          JSON.stringify({
            success: true,
            skipped: true,
            reason: "previously_disposed",
            disposition,
            daysSinceRemoval: Math.round(daysSinceRemoval),
            cooldownDays: REINGEST_COOLDOWN_DAYS,
            contactId,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
        );
      }
    }

    console.log(`[LeadIngest] No existing routing found — proceeding with push`);

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

    // Resolve timezone from newCampaignId as fallback (always in CAMPAIGN_TIMEZONE map)
    const tzOverride = CAMPAIGN_TIMEZONE[Number(newCampaignId)];

    // Create provisional routing record BEFORE push to prevent reconcile race condition.
    // If reconcile runs between push and routing creation, it would not see this contact
    // as active and could load it into a second campaign.
    const now = new Date().toISOString();
    const { error: routingError } = await supabaseClient.from("ringcx_lead_routing").upsert({
      contact_id: contactId,
      hot_campaign_id: hotCampaignId,
      new_campaign_id: newCampaignId,
      old_campaign_id: oldCampaignId || null,
      current_campaign_id: targetCampaignId,
      current_tier: tier,
      ringcx_lead_id: null, // not yet known — will be updated after push
      lead_date: leadDateStr || now,
      ingested_at: now,
      moved_to_new_at: tier === "NEW" || tier === "OLD" ? now : null,
      moved_to_old_at: tier === "OLD" ? now : null,
      removed_at: null,         // Clear any previous disposal on re-ingest
      removal_reason: null,     // Clear previous disposal reason
      contact_state: properties.state || null,
      contact_phone: phone1 || phone2 || null,
      updated_at: now,
    }, { onConflict: "contact_id" });
    if (routingError) {
      console.error(`[LeadIngest] Failed to upsert routing record for ${contactId}:`, routingError);
    }

    // Push to RingCX
    const result = await pushLeadToRingCX(targetCampaignId, leadData, ringcxToken, dialPriority, tzOverride);

    if (!result.success) {
      // Clean up provisional routing record on push failure
      await supabaseClient.from("ringcx_lead_routing")
        .update({ removed_at: new Date().toISOString(), removal_reason: "push_failed", updated_at: new Date().toISOString() })
        .eq("contact_id", contactId)
        .is("removed_at", null);

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

    // Search for lead ID and update routing record
    const searchResult = await searchLeadInCampaign(targetCampaignId, contactId, ringcxToken);
    const leadId = searchResult.success ? searchResult.leadId : result.leadId;

    // Update provisional routing record with ringcx_lead_id
    await supabaseClient.from("ringcx_lead_routing")
      .update({ ringcx_lead_id: leadId || null, updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("removed_at", null);

    // Log routing event
    const { error: ingestEvtErr } = await supabaseClient.from("lead_routing_events").insert({
      contact_id: contactId,
      event_type: "ingested",
      from_campaign_id: null,
      to_campaign_id: targetCampaignId,
      from_tier: null,
      to_tier: tier,
      ringcx_lead_id: leadId || null,
      details: {
        dial_priority: dialPriority,
        age_hours: ageHours,
        lead_date: leadDateStr || null,
        num_contacted: parseInt(properties.num_contacted_notes || "0", 10),
      },
    });
    if (ingestEvtErr) console.warn("Failed to log routing event:", ingestEvtErr);

    // Record in lead_loads (existing pattern for hourly reporting)
    await supabaseClient.from("lead_loads").insert({
      contact_id: contactId,
      campaign_id: targetCampaignId,
      campaign_type: tier,
      lead_id: leadId || null,
      dial_priority: dialPriority,
      priority_reason: tier === "HOT" ? "hot_lead" : tier === "OLD" ? "aged_into_old" : "aged_into_new",
      priority_context: { lead_date: leadDateStr || null, age_hours: ageHours, tier },
      contact_first_name: properties.firstname || null,
      contact_last_name: properties.lastname || null,
      contact_state: properties.state || null,
      contact_postcode: properties.zip || null,
      contact_email: properties.email || null,
      contact_phone: phone1 || phone2 || null,
    });
    // lead_loads insert is non-critical — errors logged but don't block

    // Write back status + campaign assignment to HubSpot.
    // n0_new_list_id is always set to newCampaignId so the contact is visible
    // in HubSpot segment lists regardless of whether it's currently in HOT or NEW.
    const statusMsg = `[Ingest] ${tier} campaign ${targetCampaignId}${leadId ? ` (lead ${leadId})` : ""} at ${now.replace("T", " ").substring(0, 19)}`;
    const hubspotUpdate: Record<string, string> = {
      ringcx_load_status: statusMsg,
      n0_new_list_id: String(newCampaignId),
    };
    if (oldCampaignId) {
      hubspotUpdate.n0_old_list_id = String(oldCampaignId);
    }
    await updateHubSpotContact(contactId, hubspotAccessToken, hubspotUpdate);

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
