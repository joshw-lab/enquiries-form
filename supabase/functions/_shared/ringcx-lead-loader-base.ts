import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyGChatError } from "./gchat-notify.ts";

// RingCX API Configuration
export const RINGCX_ACCOUNT_ID = "44510001";
export const RINGCX_API_BASE = "https://ringcx.ringcentral.com/voice/api/v1";
export const RINGCX_AUTH_BASE = "https://ringcx.ringcentral.com/api";

/**
 * Campaign ID → timezone code mapping.
 * Each state has 4 campaigns: New, Old, HitList (New), HitList (Old).
 */
const CAMPAIGN_TIMEZONE: Record<number, string> = {
  // WA
  222: "WA01", 223: "WA01", 224: "WA01", 225: "WA01",
  // QLD
  226: "QLD1", 227: "QLD1", 228: "QLD1", 229: "QLD1",
  // NSW
  230: "NSW1", 231: "NSW1", 232: "NSW1", 233: "NSW1",
  // ACT
  234: "ACT1", 235: "ACT1", 236: "ACT1", 237: "ACT1",
  // VIC
  238: "VIC1", 239: "VIC1", 240: "VIC1", 241: "VIC1",
  // SA
  242: "SA01", 243: "SA01", 244: "SA01", 245: "SA01",
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Check if this contact already has a recent error in error_log.
 * Prevents duplicate API calls and error noise when a contact triggers
 * multiple loader functions (New + NewHitlist + Old + OldHitlist).
 */
export async function hasRecentFailure(
  supabaseClient: ReturnType<typeof createClient>,
  contactId: string,
  windowMinutes = 60
): Promise<{ suppressed: boolean; reason?: string }> {
  try {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const { data } = await supabaseClient
      .from("error_log")
      .select("error_message")
      .eq("error_details->>contactId", contactId)
      .gte("created_at", since)
      .limit(1);

    if (data && data.length > 0) {
      return { suppressed: true, reason: data[0].error_message };
    }
  } catch (err) {
    // Don't block the loader if the dedup check fails
    console.warn("hasRecentFailure check failed, proceeding:", err);
  }
  return { suppressed: false };
}

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
  numContacted?: number;
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
      "num_contacted_notes",
      "lead_date",
      "createdate",
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
 * Convert E.164 phone to local Australian format for RingCX dialer.
 * +61412036166 → 0412036166
 * 61412036166  → 0412036166
 * 0412036166   → 0412036166 (already local)
 */
function toLocalAU(phone: string): string {
  let digits = phone.replace(/[^\d]/g, "");
  // Strip country code: 61XXXXXXXXX (11 digits) → 0XXXXXXXXX
  if (digits.startsWith("61") && digits.length === 11) {
    digits = "0" + digits.substring(2);
  }
  // Already local format (0XXXXXXXXX)
  if (digits.startsWith("0") && digits.length === 10) {
    return digits;
  }
  // 9-digit without leading 0 (rare) — add 0
  if (!digits.startsWith("0") && digits.length === 9) {
    return "0" + digits;
  }
  // Fallback: return as-is
  return digits;
}

/**
 * Structured result from dial priority determination.
 * Captures the decision + reasoning for queue visibility dashboards.
 */
export interface DialPriorityResult {
  priority: "IMMEDIATE" | "NORMAL";
  reason: string; // "reconversion" | "recontacted" | "new_today" | "aged_lead"
  context: {
    lead_date: string | null;
    createdate: string | null;
    num_contacted: number;
  };
}

/**
 * Determine dial priority for a lead.
 * IMMEDIATE (jump the queue) when lead_date is today AND either:
 *   - It's a reconversion (lead_date differs from createdate), OR
 *   - numContacted > 1 (previously contacted — ensures reconverted leads
 *     with high pass counts aren't deprioritized by RingCX)
 * Otherwise NORMAL.
 */
export function determineDialPriority(
  leadDate?: string,
  createDate?: string,
  numContacted = 0,
): DialPriorityResult {
  const context = {
    lead_date: leadDate?.slice(0, 10) || null,
    createdate: createDate?.slice(0, 10) || null,
    num_contacted: numContacted,
  };

  if (!leadDate) return { priority: "NORMAL", reason: "aged_lead", context };

  const today = new Date().toISOString().slice(0, 10);
  const leadDay = leadDate.slice(0, 10);

  if (leadDay !== today) return { priority: "NORMAL", reason: "aged_lead", context };

  // lead_date is today — check for reconversion signals
  const isReconversion = createDate ? leadDay !== createDate.slice(0, 10) : false;
  if (isReconversion) return { priority: "IMMEDIATE", reason: "reconversion", context };

  const wasPreviouslyContacted = numContacted > 1;
  if (wasPreviouslyContacted) return { priority: "IMMEDIATE", reason: "recontacted", context };

  return { priority: "NORMAL", reason: "new_today", context };
}

/**
 * Push lead to RingCX Lead Loader API
 */
/**
 * Pre-flight validation for lead data before calling RingCX.
 * Returns an array of human-readable issues. Empty array = all good.
 */
function validateLeadData(
  campaignId: string,
  leadData: RingCXLeadData
): string[] {
  const issues: string[] = [];

  if (!campaignId) {
    issues.push("Missing campaign ID");
  }

  if (!leadData.externId) {
    issues.push("Missing externId (HubSpot contact ID)");
  }

  // Phone validation — E.164 international format (+61XXXXXXXXX)
  if (!leadData.phone1) {
    issues.push("Missing phone number — leadPhone is required by RingCX");
  } else if (!/^\+\d{7,15}$/.test(leadData.phone1)) {
    issues.push(`Invalid E.164 phone format: "${leadData.phone1}" — expected +countrycode followed by 7-15 digits`);
  }

  // Timezone validation
  const campaignNum = Number(campaignId);
  if (campaignId && !CAMPAIGN_TIMEZONE[campaignNum]) {
    issues.push(`Campaign ${campaignId} has no timezone mapping — will use timeZoneOption=NOT_APPLICABLE`);
  }

  return issues;
}

/**
 * Build a diagnostic summary of what we sent when RingCX returns a vague error.
 * Helps identify which field is actually the problem.
 */
function buildLeadDiagnostic(
  leadRecord: Record<string, string | number>,
  requestBody: Record<string, unknown>
): string {
  const parts: string[] = [];

  // Summarise key fields
  const phone = String(leadRecord.leadPhone || "");
  parts.push(`leadPhone=${phone ? `"${phone}" (${phone.length} digits)` : "MISSING"}`);
  parts.push(`externId=${leadRecord.externId || "MISSING"}`);
  parts.push(`firstName=${leadRecord.firstName ? `"${leadRecord.firstName}"` : "empty"}`);
  parts.push(`lastName=${leadRecord.lastName ? `"${leadRecord.lastName}"` : "empty"}`);
  if (leadRecord.leadTimezone) {
    parts.push(`leadTimezone="${leadRecord.leadTimezone}"`);
  }
  if (leadRecord.passCount) {
    parts.push(`passCount=${leadRecord.passCount}`);
  }
  parts.push(`timeZoneOption=${requestBody.timeZoneOption}`);

  // Count which optional fields were included
  const optionalFields = ["address1", "city", "state", "zip", "email", "auxPhone1"];
  const included = optionalFields.filter((f) => leadRecord[f]);
  parts.push(`optional fields: ${included.length > 0 ? included.join(", ") : "none"}`);

  return parts.join(" | ");
}

export async function pushLeadToRingCX(
  campaignId: string,
  leadData: RingCXLeadData,
  accessToken: string,
  dialPriority: "IMMEDIATE" | "NORMAL" = "IMMEDIATE"
): Promise<{ success: boolean; leadId?: string; error?: string; diagnostic?: string }> {
  try {
    // ── Pre-flight validation ──────────────────────────────────
    const issues = validateLeadData(campaignId, leadData);
    const hardErrors = issues.filter(
      (i) => i.startsWith("Missing") || i.startsWith("Invalid") || i.includes("wrong length")
    );
    if (hardErrors.length > 0) {
      const errorMsg = `Lead validation failed: ${hardErrors.join("; ")}`;
      console.error(`❌ ${errorMsg} (externId=${leadData.externId}, campaignId=${campaignId})`);
      return { success: false, error: errorMsg };
    }
    if (issues.length > 0) {
      console.warn(`⚠️ Lead warnings for ${leadData.externId}: ${issues.join("; ")}`);
    }

    const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${campaignId}/leadLoader/direct`;

    // RingCX Lead Loader API — send E.164 international format (campaign intl dialling enabled)
    // Only include fields that have values — empty strings can cause lead rejection
    const leadRecord: Record<string, string | number> = {
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
    if (leadData.phone2) leadRecord.auxPhone1 = leadData.phone2;

    // Pass count from HubSpot "number of times contacted" (num_contacted_notes).
    // Sets the lead's pass count so RingCX knows how many times the contact has been dialled.
    if (leadData.numContacted != null && leadData.numContacted > 0) {
      leadRecord.passCount = leadData.numContacted;
      leadRecord.leadPasses = leadData.numContacted;
    }

    // NPA_NXX: RingCX auto-determines timezone from phone number area code
    const requestBody = {
      description: `HubSpot lead ${leadData.externId}`,
      listState: "ACTIVE",
      fileType: "COMMA",
      duplicateHandling: "REMOVE_ALL_EXISTING",
      timeZoneOption: "NPA_NXX",
      dialPriority,
      phoneNumbersI18nEnabled: true,
      internationalNumberFormat: true,
      numberOriginCountry: "e164",
      uploadLeads: [leadRecord],
      dncTags: [],
    };

    const diagnostic = buildLeadDiagnostic(leadRecord, requestBody);
    console.log(`Pushing lead to RingCX: ${url}`);
    console.log(`Lead diagnostic: ${diagnostic}`);
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
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        diagnostic,
      };
    }

    const result = await response.json();

    // Log full RingCX response for debugging
    console.log(`RingCX response for lead ${leadData.externId}:`, JSON.stringify(result));

    // ── Interpret RingCX error responses ──────────────────────
    // RingCX returns 200 even on failure — check the body for actual status.
    // supplied=0 means the lead wasn't even parsed (format error)
    // GENERAL_FAILURE means something went wrong server-side
    // supplied>0 with inserted=0 can be OK with REMOVE_ALL_EXISTING (replacement)
    if (result.processingStatus === "GENERAL_FAILURE" || result.leadsSupplied === 0) {
      const rawMessage = result.message || "Unknown processing failure";

      // Map vague RingCX error codes to actionable descriptions
      let friendlyError: string;
      if (rawMessage === "missing.required.param" && result.leadsSupplied === 0) {
        // supplied=0 means the API couldn't parse the lead at all — figure out why
        const phone = leadRecord.leadPhone;
        if (!phone) {
          friendlyError = "Missing phone number — leadPhone is required";
        } else if (!/^\+?\d{7,15}$/.test(phone)) {
          friendlyError = `Invalid phone format: "${phone}" — must be E.164 international format`;
        } else {
          friendlyError = `Lead rejected (supplied=0): likely invalid field format. Sent: ${diagnostic}`;
        }
      } else if (rawMessage === "missing.required.param") {
        friendlyError = `Required field missing (${result.leadsSupplied} supplied, ${result.leadsAccepted} accepted). Sent: ${diagnostic}`;
      } else if (rawMessage.includes("duplicate")) {
        friendlyError = `Duplicate lead — externId ${leadData.externId} already exists in campaign ${campaignId}`;
      } else if (result.processingStatus === "GENERAL_FAILURE") {
        friendlyError = `RingCX server error: ${rawMessage}. Sent: ${diagnostic}`;
      } else {
        friendlyError = `${rawMessage} (supplied=${result.leadsSupplied}, accepted=${result.leadsAccepted}, inserted=${result.leadsInserted}). Sent: ${diagnostic}`;
      }

      console.error(`❌ RingCX rejected lead ${leadData.externId}: ${friendlyError}`);
      console.error(`   Raw response: ${JSON.stringify(result)}`);
      return {
        success: false,
        error: friendlyError,
        diagnostic,
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
 * Format phone number to E.164 format (+61XXXXXXXXX).
 *
 * Handles the various raw formats stored in HubSpot now that the
 * HubSpot automation that used to pre-format phone numbers is disabled.
 *
 * Supported input formats (AU):
 *   +61 4XX XXX XXX   → already E.164
 *   +610 4XX XXX XXX  → redundant zero after country code
 *   0061 4XX XXX XXX  → international dialing prefix
 *   61 4XXXXXXXX      → country code without +
 *   610 4XXXXXXXX     → country code without +, redundant zero
 *   04XX XXX XXX      → local mobile
 *   0X XXXX XXXX      → local landline
 *   4XXXXXXXX         → 9 digits, missing leading 0
 */
export function formatPhoneNumber(phone: string): string {
  if (!phone) return "";

  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, "");

  // ── International dialing prefix (0061… → 61…) ──────────
  if (cleaned.startsWith("+0061")) {
    cleaned = "+" + cleaned.substring(3); // +0061… → +61…
  } else if (cleaned.startsWith("0061")) {
    cleaned = cleaned.substring(2);       // 0061…  → 61…
  }

  // ── Redundant zero after country code ────────────────────
  if (cleaned.startsWith("+610") && cleaned.length === 13) {
    // +610408199928 → +61408199928
    cleaned = "+61" + cleaned.substring(4);
  } else if (cleaned.startsWith("610") && cleaned.length === 12) {
    // 610408199928 → +61408199928
    cleaned = "+61" + cleaned.substring(3);
  }

  // ── Standard conversions ─────────────────────────────────
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    // Local AU format: 0408199928 → +61408199928
    cleaned = "+61" + cleaned.substring(1);
  } else if (cleaned.startsWith("61") && cleaned.length === 11) {
    // Country code without +: 61408199928 → +61408199928
    cleaned = "+" + cleaned;
  } else if (!cleaned.startsWith("+") && cleaned.length === 9) {
    // 9 digits without leading 0: 408199928 → +61408199928
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

/**
 * Create a note on a HubSpot contact (e.g. to flag missing phone details).
 * Uses the CRM v3 Notes API with association type 202 (Note → Contact).
 */
export async function createHubSpotNote(
  contactId: string,
  noteBody: string,
  accessToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: Date.now(),
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 202,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot create note failed:", errorText);
      return { success: false, error: errorText };
    }

    console.log(`HubSpot note created on contact ${contactId}`);
    return { success: true };
  } catch (error) {
    console.error("HubSpot create note error:", error);
    return { success: false, error: error.message };
  }
}
