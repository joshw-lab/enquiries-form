import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyGChatError } from "../gchat-notify.ts";

// RingCX API Configuration
export const RINGCX_ACCOUNT_ID = "44510001";
export const RINGCX_API_BASE = "https://ringcx.ringcentral.com/voice/api/v1";
export const RINGCX_AUTH_BASE = "https://ringcx.ringcentral.com/api";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * HubSpot Webhook Payload (Property Change)
 * HubSpot sends different formats, so we make fields optional
 */
export interface HubSpotListWebhookPayload {
  subscriptionType?: string;
  portalId?: number;
  objectId?: number; // Contact ID (standard property change webhooks)
  contactId?: number; // Alternative contact ID field
  hubspotContactId?: number; // Custom integration format
  externID?: number; // External ID from custom workflow
  campaignID?: number; // Campaign ID from payload (optional - we fetch from contact properties)
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  eventId?: number;
  subscriptionId?: number;
  attemptNumber?: number;
  // Raw payload for debugging
  [key: string]: any;
}

/**
 * Lead data to send to RingCX
 */
export interface RingCXLeadData {
  externId: string;
  firstName?: string;
  lastName?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  gatekeeper?: string;
  email?: string;
  phone1?: string;
  phone2?: string;
  phone3?: string;
  extendedLeadData?: Record<string, string>;
}

/**
 * Get RingCentral access token with automatic refresh.
 * By default, exchanges for a RingCX JWT token (needed for disposition webhooks).
 * Set skipRingCXExchange=true for the Lead Loader API which uses the raw RC token.
 */
export async function getRingCentralAccessToken(
  supabaseClient: ReturnType<typeof createClient>,
  skipRingCXExchange = false
): Promise<{ token: string | null; error?: string }> {
  try {
    const { data: authData, error: fetchError } = await supabaseClient
      .from("ringcentral_auth")
      .select("*")
      .single();

    if (fetchError || !authData) {
      console.error("Failed to fetch RingCentral auth:", fetchError);
      return { token: null, error: "RingCentral auth not configured" };
    }

    const now = new Date();
    const expiresAt = new Date(authData.rc_access_token_expires_at);
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();

    // Token refresh is handled exclusively by the cron job (every 30 mins).
    // This avoids race conditions where both cron and just-in-time refresh
    // consume the single-use RC refresh token, causing OAU-210 errors.
    if (timeUntilExpiry <= 0) {
      const errorMsg = `RC access token expired at ${expiresAt.toISOString()}. Cron refresh may have failed — check error_log.`;
      console.error(errorMsg);

      try {
        await supabaseClient.from("error_log").insert({
          source: "ringcentral-auth",
          error_message: errorMsg,
          error_details: { expiresAt: expiresAt.toISOString(), stage: "token_expiry_check" },
        });
      } catch (_) { /* don't mask original error */ }

      await notifyGChatError({
        source: "ringcentral-auth",
        error: errorMsg,
        details: { expiresAt: expiresAt.toISOString() },
      });

      return { token: null, error: errorMsg };
    }

    if (timeUntilExpiry < 5 * 60 * 1000) {
      console.warn(`RC access token expiring soon (${Math.round(timeUntilExpiry / 1000)}s remaining). Cron should refresh shortly.`);
    }

    const rcAccessToken = authData.rc_access_token;

    // For Lead Loader API: return raw RC token (no exchange needed)
    if (skipRingCXExchange) {
      console.log("Skipping RingCX exchange — returning raw RC token for Lead Loader API");
      return { token: rcAccessToken };
    }

    // Exchange RC access token for a RingCX access token
    console.log("Exchanging RC token for RingCX token...");
    const ringcxAuthResponse = await fetch(
      `${RINGCX_AUTH_BASE}/auth/login/rc/accesstoken?includeRefresh=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `rcAccessToken=${encodeURIComponent(rcAccessToken)}&rcTokenType=Bearer`,
      }
    );

    if (!ringcxAuthResponse.ok) {
      const errorText = await ringcxAuthResponse.text();
      const errorMsg = `RingCX token exchange failed (${ringcxAuthResponse.status}): ${errorText}`;
      console.error(errorMsg);

      try {
        await supabaseClient.from("error_log").insert({
          source: "ringcentral-auth",
          error_message: errorMsg,
          error_details: { httpStatus: ringcxAuthResponse.status, response: errorText, stage: "ringcx_token_exchange" },
        });
      } catch (_) { /* don't mask original error */ }

      await notifyGChatError({
        source: "ringcentral-auth",
        error: errorMsg,
        details: { httpStatus: ringcxAuthResponse.status, stage: "ringcx_token_exchange" },
      });

      return { token: null, error: errorMsg };
    }

    const ringcxAuthData = await ringcxAuthResponse.json();
    const ringcxToken = ringcxAuthData.accessToken || ringcxAuthData.access_token;

    if (!ringcxToken) {
      const errorMsg = "RingCX token exchange returned no access token";
      console.error(errorMsg, JSON.stringify(ringcxAuthData));

      try {
        await supabaseClient.from("error_log").insert({
          source: "ringcentral-auth",
          error_message: errorMsg,
          error_details: { responseBody: ringcxAuthData, stage: "ringcx_token_exchange_empty" },
        });
      } catch (_) { /* don't mask original error */ }

      await notifyGChatError({
        source: "ringcentral-auth",
        error: errorMsg,
        details: { stage: "ringcx_token_exchange_empty" },
      });

      return { token: null, error: errorMsg };
    }

    console.log(`RingCX token obtained (length=${ringcxToken.length}, dots=${(ringcxToken.match(/\./g) || []).length})`);
    return { token: ringcxToken };
  } catch (error) {
    console.error("Error getting RingCX access token:", error);

    try {
      await supabaseClient.from("error_log").insert({
        source: "ringcentral-auth",
        error_message: error.message || "Unknown error getting access token",
        error_details: { error: error.message, stack: error.stack, stage: "uncaught" },
      });
    } catch (_) { /* don't mask original error */ }

    await notifyGChatError({
      source: "ringcentral-auth",
      error: error.message || "Unknown error getting access token",
      details: { stage: "uncaught" },
    });

    return { token: null, error: error.message };
  }
}

/**
 * Fetch contact data from HubSpot with specified campaign ID field
 */
export async function getHubSpotContact(
  contactId: string,
  accessToken: string,
  campaignIdField: string
): Promise<{ success: boolean; contact?: any; error?: string }> {
  try {
    const properties = [
      "firstname",
      "lastname",
      "email",
      "phone",
      "address",
      "city",
      "state",
      "zip",
      "mobilephone",
      campaignIdField,
    ].join(",");

    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot fetch failed:", errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    return { success: true, contact: data };
  } catch (error) {
    console.error("HubSpot API error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Push lead to RingCX Lead Loader API
 */
export async function pushLeadToRingCX(
  campaignId: string,
  leadData: RingCXLeadData,
  accessToken: string
): Promise<{ success: boolean; leadId?: string; error?: string }> {
  try {
    // Validate required fields before making the API call
    if (!leadData.phone1) {
      console.error(`❌ Cannot push lead ${leadData.externId}: no phone number (phone1 is empty)`);
      return { success: false, error: "Lead has no phone number - leadPhone is required by RingCX" };
    }

    if (!campaignId) {
      console.error(`❌ Cannot push lead ${leadData.externId}: no campaign ID`);
      return { success: false, error: "Campaign ID is required" };
    }

    const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${campaignId}/leadLoader/direct`;

    // RingCX Lead Loader API: matches working Postman payload format
    // Only include fields that have values — empty strings can cause lead rejection
    const leadRecord: Record<string, string> = {
      externId: leadData.externId,
      leadPhone: leadData.phone1!,
    };
    if (leadData.firstName) leadRecord.firstName = leadData.firstName;
    if (leadData.lastName) leadRecord.lastName = leadData.lastName;
    if (leadData.address1) leadRecord.address1 = leadData.address1;
    if (leadData.city) leadRecord.city = leadData.city;
    if (leadData.state) leadRecord.state = leadData.state;
    if (leadData.zip) leadRecord.zip = leadData.zip;
    if (leadData.email) leadRecord.email = leadData.email;
    if (leadData.phone2) leadRecord.auxPhone = leadData.phone2;

    const requestBody = {
      description: `HubSpot lead ${leadData.externId}`,
      listState: "ACTIVE",
      fileType: "COMMA",
      duplicateHandling: "REMOVE_ALL_EXISTING",
      timeZoneOption: "NPA_NXX",
      dialPriority: "IMMEDIATE",
      phoneNumbersI18nEnabled: true,
      internationalNumberFormat: true,
      numberOriginCountry: "e164",
      uploadLeads: [leadRecord],
      dncTags: [],
    };

    console.log(`Pushing lead to RingCX: ${url}`);
    console.log("Request body:", JSON.stringify(requestBody, null, 2));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("RingCX Lead Loader HTTP error:", response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();

    // Log full RingCX response for debugging
    console.log(`RingCX response for lead ${leadData.externId}:`, JSON.stringify(result));

    // Check the response body for actual failure — RingCX returns 200 even on failure
    // supplied=0 means the lead wasn't even parsed (format error)
    // GENERAL_FAILURE means something went wrong server-side
    // supplied>0 with inserted=0 can be OK with REMOVE_ALL_EXISTING (replacement)
    if (result.processingStatus === "GENERAL_FAILURE" || result.leadsSupplied === 0) {
      const errorDetail = result.message || "Unknown processing failure";
      console.error(`❌ RingCX rejected lead ${leadData.externId}:`, JSON.stringify(result));
      console.error(`   Status: ${result.processingStatus}, Message: ${errorDetail}`);
      console.error(`   Supplied: ${result.leadsSupplied}, Accepted: ${result.leadsAccepted}, Inserted: ${result.leadsInserted}`);
      return {
        success: false,
        error: `RingCX processing failed: ${errorDetail} (supplied=${result.leadsSupplied}, accepted=${result.leadsAccepted}, inserted=${result.leadsInserted})`,
      };
    }

    console.log(`✅ Lead ${leadData.externId} pushed successfully: inserted=${result.leadsInserted}, accepted=${result.leadsAccepted}`);
    const leadId = result?.leadId?.toString() || result?.id?.toString() || null;
    return { success: true, leadId };
  } catch (error) {
    console.error("RingCX API error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Update a HubSpot contact property (used to write back the RingCX lead ID)
 */
export async function updateHubSpotContact(
  contactId: string,
  accessToken: string,
  properties: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ properties }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot update failed:", errorText);
      return { success: false, error: errorText };
    }

    console.log(`HubSpot contact ${contactId} updated with properties:`, properties);
    return { success: true };
  } catch (error) {
    console.error("HubSpot update error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Search for a lead in a RingCX campaign and match by externId.
 * The leadSearch API does NOT support externId or phone as search params — it only supports
 * campaignId/campaignIds, firstName, lastName, leadStates, dispositions, etc.
 * We search by campaignId only (no firstName — that's unreliable when contacts share names)
 * then filter client-side by externId.
 * Includes a retry with delay since freshly-uploaded leads may not be indexed immediately.
 * Docs: https://developers.ringcentral.com/engage/voice/guide/dialing/leads/search
 */
export async function searchLeadInCampaign(
  campaignId: string,
  externId: string,
  accessToken: string,
  _firstName?: string // kept for backwards compatibility but no longer used as search filter
): Promise<{ success: boolean; leadId?: string; leadData?: any; error?: string }> {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;

  // Search by campaign only — do NOT filter by firstName (unreliable when multiple
  // contacts share a name). We filter client-side by externId instead.
  const searchBody: Record<string, any> = {
    campaignIds: [Number(campaignId)],
    campaignId: Number(campaignId),
  };

  // Retry up to 2 times with a delay — freshly-inserted leads may not be indexed yet
  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`Lead search attempt ${attempt}/${MAX_ATTEMPTS} — waiting ${RETRY_DELAY_MS}ms for indexing...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      console.log(`Searching RingCX for lead with externId=${externId} in campaign=${campaignId} (attempt ${attempt}/${MAX_ATTEMPTS})`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(searchBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("RingCX lead search HTTP error:", response.status, errorText);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const result = await response.json();

      // Result may be an array of leads or a single object
      const leads = Array.isArray(result) ? result : (result.leads || result.data || [result]);

      console.log(`Lead search returned ${leads.length} lead(s) in campaign ${campaignId}`);

      // Filter client-side by externId — the API doesn't support this filter
      const matchedLead = leads.find((l: any) => {
        const eId = l.externId || l.campaignLead?.externId;
        return eId === externId || eId === String(externId);
      });

      if (matchedLead) {
        const leadId = matchedLead.leadId?.toString() || matchedLead.campaignLead?.leadId?.toString() || matchedLead.id?.toString() || null;
        console.log(`✅ Lead search matched externId=${externId}, leadId=${leadId}`);
        return { success: true, leadId, leadData: matchedLead };
      }

      // Not found yet — log and maybe retry
      const returnedIds = leads.slice(0, 5).map((l: any) => l.externId || l.campaignLead?.externId || "unknown");
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`Lead not found on attempt ${attempt} (${leads.length} leads checked, sample externIds: [${returnedIds.join(", ")}]). Retrying...`);
      } else {
        console.warn(`Lead search exhausted ${MAX_ATTEMPTS} attempts. ${leads.length} lead(s) checked, none matched externId=${externId}. Sample: [${returnedIds.join(", ")}]`);
      }
    } catch (error) {
      console.error(`RingCX lead search error (attempt ${attempt}):`, error);
      if (attempt === MAX_ATTEMPTS) {
        return { success: false, error: error.message };
      }
    }
  }

  return { success: false, error: `No lead found with externId=${externId} in campaign ${campaignId} after ${MAX_ATTEMPTS} attempts` };
}

/**
 * Format phone number to E.164 format
 */
export function formatPhoneNumber(phone: string): string {
  if (!phone) return "";

  let cleaned = phone.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "+61" + cleaned.substring(1);
  } else if (cleaned.startsWith("61") && cleaned.length === 11) {
    cleaned = "+" + cleaned;
  } else if (!cleaned.startsWith("+") && cleaned.length === 9) {
    cleaned = "+61" + cleaned;
  }

  return cleaned;
}

/**
 * Validate that a phone number is in E.164 format (+ followed by 7-15 digits).
 * Returns true if valid, false otherwise.
 */
export function isValidE164(phone: string): boolean {
  if (!phone) return false;
  return /^\+\d{7,15}$/.test(phone);
}
