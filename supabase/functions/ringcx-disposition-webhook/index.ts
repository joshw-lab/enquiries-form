import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  getRingCentralAccessToken,
  searchLeadInCampaign,
} from "../_shared/ringcx-lead-loader-base.ts";
import { hubspotFetch } from "../_shared/hubspot-rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// HubSpot API base URL
const HUBSPOT_API_BASE = "https://api.hubapi.com";

// Not Interested disposition UUID (HubSpot call disposition ID)
const NOT_INTERESTED_DISPOSITION_ID = "5e8c009f-db89-4e1a-9c9a-429b45faf0c0";

// HubSpot owner IDs for disposition-based contact owner reassignment
const CHF_PROMOTIONS_OWNER_ID = "27663217";
const ENQUIRIES_OWNER_ID = "13568480";
const SHANNON_WATSON_OWNER_ID = "10288671";

/**
 * RingCX Disposition Webhook Payload
 * Maps directly to RingCX webhook variables
 */
interface RingCXWebhookPayload {
  // Call details
  call_id: string;           // #uii#
  call_duration: string;     // #call_duration# - format: "HH:MM:SS" or seconds
  call_start: string;        // #call_start#
  call_direction?: string;   // #call_direction# - "OUTBOUND" or "INBOUND"

  // Agent info
  agent_id: string;          // #agent_id#
  agent_username: string;    // #agent_username#
  agent_first_name?: string; // #agent_first_name#
  agent_last_name?: string;  // #agent_last_name#
  agent_extern_id?: string;  // External agent ID from RingCX (for HubSpot user mapping)

  // Contact info - extern_id contains HubSpot contact ID
  extern_id: string;         // #extern_id# - REQUIRED: HubSpot contact ID
  ani: string;               // #ani# - caller phone number
  dnis: string;              // #dnis# - dialed number

  // Disposition
  agent_disposition?: string; // #agent_disposition# - RingCX sends this
  disposition?: string;       // Alternative key name

  // Notes and summary from disposition form
  notes?: string;            // Agent notes from disposition form
  summary?: string;          // AI-generated call summary

  // Queue / campaign metadata
  queue_id?: string;         // #queue_id# - populated for inbound queue calls (e.g. "1221")

  // Additional metadata
  recording_url?: string;    // #recording_url#
  account_id?: string;       // #account_id#
}

/**
 * Check if a value is an unresolved RingCX template variable (e.g. "#summary#", "#call_duration#")
 * Returns true if the value is a template placeholder that RingCX failed to substitute
 */
function isUnresolvedTemplateVar(value: string | undefined): boolean {
  if (!value) return false;
  // Match pattern: starts with # and ends with # (e.g. "#summary#", "#call_duration#")
  return /^#[a-z_]+#$/i.test(value.trim());
}

/**
 * Clean a payload string field: returns undefined if empty or unresolved template variable
 */
function resolveField(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isUnresolvedTemplateVar(value)) {
    console.warn(`⚠️ Unresolved template variable: "${value}" — treating as empty`);
    return undefined;
  }
  return value;
}

/**
 * Parse call duration from various formats
 * Supports: "HH:MM:SS", "MM:SS", "SS", or plain seconds
 */
function parseCallDuration(duration: string): number {
  if (!duration) return 0;

  // If RingCX sends unresolved template variable (e.g. "#call_duration#"), treat as 0
  if (isUnresolvedTemplateVar(duration)) {
    console.warn(`⚠️ call_duration is unresolved template variable: "${duration}" — treating as 0`);
    return 0;
  }

  // If it's already a number string, return it
  if (/^\d+$/.test(duration)) {
    return parseInt(duration, 10);
  }

  // Parse HH:MM:SS or MM:SS format
  const parts = duration.split(":").map(p => parseInt(p, 10));

  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  }

  return 0;
}

/**
 * Determine call direction from payload
 * Uses call_direction field if available, otherwise infers from ANI/DNIS
 */
function determineCallDirection(payload: RingCXWebhookPayload): "INBOUND" | "OUTBOUND" {
  // If explicitly provided and not an unresolved template var, use it
  const callDir = resolveField(payload.call_direction);
  if (callDir) {
    const dir = callDir.toUpperCase();
    if (dir === "OUTBOUND" || dir === "OUT") return "OUTBOUND";
    if (dir === "INBOUND" || dir === "IN") return "INBOUND";
  }

  // Inbound queue ID — if queue_id matches the inbound queue, it's inbound
  const INBOUND_QUEUE_ID = "1221";
  const queueId = resolveField(payload.queue_id);
  if (queueId === INBOUND_QUEUE_ID) {
    console.log(`📞 Detected INBOUND from queue_id=${queueId}`);
    return "INBOUND";
  }

  // Infer from DNIS - if DNIS is the company number, it's inbound
  // Common company DNIS patterns (Australian) + known inbound numbers
  const companyDnisPatterns = [
    /^1300/, /^1800/, /^13\d{4}$/,  // Australian toll-free/local rate
    /^\(03\)/, /^03/,               // Melbourne landline
    /^861868471$/,                   // CHF inbound test line
  ];

  const dnis = payload.dnis?.replace(/\s/g, "") || "";
  for (const pattern of companyDnisPatterns) {
    if (pattern.test(dnis)) {
      return "INBOUND";
    }
  }

  // Default to OUTBOUND for dialer campaigns (most common use case)
  return "OUTBOUND";
}

/**
 * Generate AU phone format variants for HubSpot search.
 * Mirrors getPhoneSearchVariants() in hubspot-form-submission and resolve-contact.
 */
function getPhoneSearchVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const variants = new Set<string>();

  let subscriber: string | null = null;

  if (digits.startsWith("61") && digits.length === 11) {
    subscriber = digits.substring(2);
  } else if (digits.startsWith("0") && digits.length === 10) {
    subscriber = digits.substring(1);
  } else if (digits.length === 9) {
    subscriber = digits;
  }

  if (subscriber) {
    variants.add(`+61${subscriber}`);
    variants.add(`0${subscriber}`);
    variants.add(`61${subscriber}`);
  } else if (digits.length > 0) {
    variants.add(phone.trim());
  }

  return [...variants];
}

/**
 * Search HubSpot for a contact by phone number (all AU format variants).
 * Used as fallback for inbound calls where extern_id is not available.
 */
async function searchContactByPhone(
  phone: string,
  accessToken: string
): Promise<string | null> {
  const variants = getPhoneSearchVariants(phone);
  if (variants.length === 0) return null;

  console.log(`🔍 Searching HubSpot for contact by phone variants: ${JSON.stringify(variants)}`);

  const filterGroups = variants.flatMap((variant) => [
    { filters: [{ propertyName: "phone", operator: "EQ", value: variant }] },
    { filters: [{ propertyName: "mobilephone", operator: "EQ", value: variant }] },
  ]);

  for (let i = 0; i < filterGroups.length; i += 5) {
    const batch = filterGroups.slice(i, i + 5);
    const response = await hubspotFetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ filterGroups: batch, limit: 1 }),
      }
    );

    if (!response.ok) {
      console.error(`HubSpot phone search failed (${response.status}):`, await response.text());
      continue;
    }

    const data = await response.json();
    if (data.results && data.results.length > 0) {
      console.log(`✅ Found contact ${data.results[0].id} by phone variant (batch ${Math.floor(i / 5) + 1})`);
      return data.results[0].id;
    }
  }

  console.log(`⚠️ No HubSpot contact found for phone variants: ${JSON.stringify(variants)}`);
  return null;
}

/**
 * Format phone number to E.164 format for HubSpot
 */
function formatPhoneNumber(phone: string): string {
  if (!phone) return "";

  // Extract embedded AU phone from freetext
  const embeddedMatch = phone.match(/\b(0[2-9]\d{8})\b/);
  if (embeddedMatch) phone = embeddedMatch[1];

  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, "");

  // Strip duplicate + signs (e.g. "+61+61..." → "+6161...")
  if (cleaned.indexOf("+", 1) > 0) {
    cleaned = "+" + cleaned.substring(1).replace(/\+/g, "");
  }

  // Doubled country code (+6161… → +61…)
  if (cleaned.startsWith("+6161") && cleaned.length === 14) {
    cleaned = "+61" + cleaned.substring(5);
  } else if (cleaned.startsWith("6161") && cleaned.length === 13) {
    cleaned = "+61" + cleaned.substring(4);
  }

  // AU mobile with stripped leading 0: +437730983 → +61437730983
  if (/^\+4\d{8}$/.test(cleaned)) {
    cleaned = "+61" + cleaned.substring(1);
  }

  // If starts with 0 (Australian local format), convert to +61
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "+61" + cleaned.substring(1);
  }
  // If starts with 61 without +, add +
  else if (cleaned.startsWith("61") && cleaned.length === 11) {
    cleaned = "+" + cleaned;
  }
  // If doesn't start with +, assume Australian and add +61
  else if (!cleaned.startsWith("+") && cleaned.length === 9) {
    cleaned = "+61" + cleaned;
  }

  return cleaned;
}

/**
 * Get agent display name from payload
 */
/**
 * Clean an email-format string into a display name.
 * e.g., "haley.b+44510001_8051@completehomefiltration.com.au" → "Haley B"
 */
function cleanEmailToName(email: string): string {
  const namePart = email.split("@")[0];
  // Remove any + suffix (e.g., haley.b+12345 -> haley.b)
  const cleanName = namePart.split("+")[0];
  // Convert haley.b or josh_w to Haley B or Josh W
  return cleanName
    .split(/[._]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getAgentDisplayName(payload: RingCXWebhookPayload): string {
  // Prefer first/last name if available AND not an email
  const firstName = payload.agent_first_name?.trim();
  const lastName = payload.agent_last_name?.trim();

  if (firstName || lastName) {
    // RingCX sometimes puts the email in agent_first_name — clean it
    const cleanFirst = firstName && firstName.includes("@") ? cleanEmailToName(firstName) : (firstName || "");
    const cleanLast = lastName && lastName.includes("@") ? "" : (lastName || "");
    const name = `${cleanFirst} ${cleanLast}`.trim();
    if (name) return name;
  }

  // Fall back to username, but clean it up if it's an email
  const username = payload.agent_username || "Unknown Agent";

  if (username.includes("@")) {
    return cleanEmailToName(username);
  }

  return username;
}

/**
 * Get HubSpot owner/user information including timezone
 * Fetches user details from HubSpot API to get their configured timezone
 */
async function getHubSpotOwnerInfo(
  ownerId: string,
  accessToken: string
): Promise<{ id: string; email?: string; timezone?: string } | null> {
  try {
    const response = await hubspotFetch(
      `${HUBSPOT_API_BASE}/crm/v3/owners/${ownerId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`Failed to fetch owner ${ownerId}:`, response.statusText);
      return null;
    }

    const data = await response.json();
    console.log(`Owner ${ownerId} timezone: ${data.timezone || "not specified"}`);

    return {
      id: data.id,
      email: data.email,
      timezone: data.timezone, // e.g., "Australia/Perth", "Australia/Sydney"
    };
  } catch (error) {
    console.error("Error fetching HubSpot owner info:", error);
    return null;
  }
}

interface AgentMapping {
  hubspotOwnerId: string | null;
  leadsRep: string | null;
}

/**
 * Maps RingCX agent IDs to HubSpot user IDs and leads_rep via database lookup.
 * Tries ringcx_agent_id first (always populated), falls back to agent_extern_id.
 * Returns leads_rep from the DB if set, otherwise falls back to agent_name.
 */
async function getAgentMapping(
  agentId: string | undefined,
  agentExternId: string | undefined,
  supabaseClient: any
): Promise<AgentMapping> {
  const empty: AgentMapping = { hubspotOwnerId: null, leadsRep: null };

  // Try ringcx_agent_id first (RingCX internal ID, always populated)
  if (agentId) {
    try {
      const { data, error } = await supabaseClient
        .from('agent_mappings')
        .select('hubspot_owner_id, agent_name, leads_rep')
        .eq('ringcx_agent_id', agentId)
        .single();

      if (!error && data) {
        const hubspotOwnerId = data.hubspot_owner_id || null;
        const leadsRep = data.leads_rep || data.agent_name || null;
        console.log(`Mapped agent_id ${agentId} (${data.agent_name || 'unknown'}) to HubSpot owner ${hubspotOwnerId}, leads_rep="${leadsRep}"`);
        return { hubspotOwnerId, leadsRep };
      }
    } catch (error) {
      console.error("Error fetching agent mapping by agent_id:", error);
    }
  }

  // Fall back to agent_extern_id (often unresolved in RingCX)
  if (agentExternId && !isUnresolvedTemplateVar(agentExternId)) {
    try {
      const { data, error } = await supabaseClient
        .from('agent_mappings')
        .select('hubspot_owner_id, agent_name, leads_rep')
        .eq('agent_extern_id', agentExternId)
        .single();

      if (!error && data) {
        const hubspotOwnerId = data.hubspot_owner_id || null;
        const leadsRep = data.leads_rep || data.agent_name || null;
        console.log(`Mapped agent_extern_id ${agentExternId} (${data.agent_name || 'unknown'}) to HubSpot owner ${hubspotOwnerId}, leads_rep="${leadsRep}"`);
        return { hubspotOwnerId, leadsRep };
      }
    } catch (error) {
      console.error("Error fetching agent mapping by extern_id:", error);
    }
  }

  console.log(`No agent mapping found for agent_id=${agentId}, extern_id=${agentExternId}`);
  return empty;
}


/**
 * Map RingCX disposition to HubSpot call disposition
 * Handles various naming conventions and aliases
 */
function mapDispositionToHubSpot(disposition: string): string {
  // Guard: reject unresolved template variables
  if (isUnresolvedTemplateVar(disposition)) {
    throw new Error(`Disposition is an unresolved RingCX template variable: "${disposition}". This webhook should have been skipped.`);
  }

  // Normalize disposition: lowercase, replace spaces with underscores
  const normalized = disposition.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

  // GUID source of truth: /hubspot call disposition IDs.csv
  const dispositionMap: Record<string, string> = {
    // Connected (f240bbac-87c9-4f6e-bf70-924b57d47db7)
    "connected": "f240bbac-87c9-4f6e-bf70-924b57d47db7",

    // Booked Test (f72848b8-6063-4591-9832-a4e4604864f5)
    "booked_test": "f72848b8-6063-4591-9832-a4e4604864f5",
    "booked": "f72848b8-6063-4591-9832-a4e4604864f5",
    "book_water_test": "f72848b8-6063-4591-9832-a4e4604864f5",
    "booked_water_test": "f72848b8-6063-4591-9832-a4e4604864f5",

    // Booked Test - Single Leg (0823d714-3974-4bb4-a65a-ecf3596f49ac)
    "booked_test_single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",
    "booked_single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",
    "single_leg": "0823d714-3974-4bb4-a65a-ecf3596f49ac",

    // No answer (73a0d17f-1163-4015-bdd5-ec830791da20)
    "no_answer": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "noanswer": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "na": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "no_response": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Wrong number (17b47fee-58de-441e-a44c-c6300d46f273)
    "wrong_number": "17b47fee-58de-441e-a44c-c6300d46f273",
    "wrongnumber": "17b47fee-58de-441e-a44c-c6300d46f273",
    "wrong": "17b47fee-58de-441e-a44c-c6300d46f273",
    "invalid_number": "17b47fee-58de-441e-a44c-c6300d46f273",

    // Not interested (5e8c009f-db89-4e1a-9c9a-429b45faf0c0)
    "not_interested": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",
    "not_intrested": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0", // common typo
    "ni": "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",

    // Busy (9d9162e7-6cf3-4944-bf63-4dff82258764)
    "busy": "9d9162e7-6cf3-4944-bf63-4dff82258764",

    // Left live message (a4c4c377-d246-4b32-a13b-75a56a4cd0ff)
    "left_live_message": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",
    "live_message": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",

    // Left voicemail (b2cf5968-551e-4856-9783-52b3da59a7d0)
    "voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "left_voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "leftvoicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "left_vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",

    // Unable to Service (109bdbfc-6552-40e0-8eb2-0e58c13208a1)
    "unable_to_service": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",
    "cannot_service": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",
    "out_of_area": "109bdbfc-6552-40e0-8eb2-0e58c13208a1",

    // Other Departments (c5067c48-aaf1-4f67-9c56-6a749b666817)
    "other_departments": "c5067c48-aaf1-4f67-9c56-6a749b666817",
    "other_department": "c5067c48-aaf1-4f67-9c56-6a749b666817",
    "transfer": "c5067c48-aaf1-4f67-9c56-6a749b666817",

    // Needs Call Back (4aa8b662-f76e-4557-8a24-ffae50519382)
    "needs_call_back": "4aa8b662-f76e-4557-8a24-ffae50519382",
    "call_back": "4aa8b662-f76e-4557-8a24-ffae50519382",
    "callback": "4aa8b662-f76e-4557-8a24-ffae50519382",

    // RO Only (ba63d1f1-e3ef-400a-a3c0-c6e1f1a5d6a4)
    "ro_only": "ba63d1f1-e3ef-400a-a3c0-c6e1f1a5d6a4",
    "ro": "ba63d1f1-e3ef-400a-a3c0-c6e1f1a5d6a4",

    // New Build (21467e3f-24c5-4b82-9e37-e918d77d2c48)
    "new_build": "21467e3f-24c5-4b82-9e37-e918d77d2c48",
    "newbuild": "21467e3f-24c5-4b82-9e37-e918d77d2c48",

    // Water Source (a8a9584b-366a-4a68-a185-21ce4181d78c)
    "water_source": "a8a9584b-366a-4a68-a185-21ce4181d78c",
    "watersource": "a8a9584b-366a-4a68-a185-21ce4181d78c",

    // Phone Pitch - CHF (6c20cc50-781f-4543-a773-d4698f649bcf)
    "phone_pitch_chf": "6c20cc50-781f-4543-a773-d4698f649bcf",
    "phone_pitch": "6c20cc50-781f-4543-a773-d4698f649bcf",
    "phonepitch": "6c20cc50-781f-4543-a773-d4698f649bcf",

    // Wants Follow Up (937b1e0e-ab79-49c8-9e8f-a5efd6966c3f)
    "wants_follow_up": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",
    "follow_up": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",
    "followup": "937b1e0e-ab79-49c8-9e8f-a5efd6966c3f",

    // Internal - Closed Deal (def5ec8d-b566-413c-b558-e4a39884ab8b)
    "internal_closed_deal": "def5ec8d-b566-413c-b558-e4a39884ab8b",
    "closed_deal": "def5ec8d-b566-413c-b558-e4a39884ab8b",

    // Internal - Deposit Taken (5f7f3f43-e0d0-4c03-ba44-09894047c474)
    "internal_deposit_taken": "5f7f3f43-e0d0-4c03-ba44-09894047c474",
    "deposit_taken": "5f7f3f43-e0d0-4c03-ba44-09894047c474",
    "deposit": "5f7f3f43-e0d0-4c03-ba44-09894047c474",

    // Not Qualified (7cb0159d-1cc0-4f56-919e-e1231a7be7af)
    "not_qualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",
    "notqualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",
    "nq": "7cb0159d-1cc0-4f56-919e-e1231a7be7af",

    // Do Not Call (df11c246-3ff0-45da-b77b-35baaf3e7238)
    "do_not_call": "df11c246-3ff0-45da-b77b-35baaf3e7238",
    "donotcall": "df11c246-3ff0-45da-b77b-35baaf3e7238",
    "dnc": "df11c246-3ff0-45da-b77b-35baaf3e7238",
    "do_not_register": "df11c246-3ff0-45da-b77b-35baaf3e7238",

    // Hangup (1bbfa758-eef2-4475-8717-2cebb16270db)
    "hangup": "1bbfa758-eef2-4475-8717-2cebb16270db",
    "hang_up": "1bbfa758-eef2-4475-8717-2cebb16270db",
    "hung_up": "1bbfa758-eef2-4475-8717-2cebb16270db",

    // --- RingCX system dispositions (auto-fired, no agent interaction) ---

    // Intercept — number not in service / disconnected → map to No Answer
    "intercept": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "operator_intercept": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Machine — answering machine detected → map to No Answer
    "machine": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "answering_machine": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Fax machine → map to Wrong Number (not a person)
    "fax_machine": "17b47fee-58de-441e-a44c-c6300d46f273",
    "fax": "17b47fee-58de-441e-a44c-c6300d46f273",

    // Dead line / dead air → map to No Answer
    "dead_line": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "dead_air": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Rejected / declined → map to No Answer
    "rejected": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "declined": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Abandon — caller hung up before agent connected → map to No Answer
    "abandon": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "abandoned": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Congestion — network/carrier congestion → map to No Answer
    "congestion": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "network_congestion": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Not Live Person — IVR/automated system detected → map to No Answer
    "not_live_person": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "nlp": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // Inbound Callback — system scheduled callback → map to Needs Call Back
    "inbound_callback": "4aa8b662-f76e-4557-8a24-ffae50519382",
    "callback_inbound": "4aa8b662-f76e-4557-8a24-ffae50519382",

    // Answer — system "answer" disposition (call connected at system level) → map to Connected
    "answer": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
    "answered": "f240bbac-87c9-4f6e-bf70-924b57d47db7",

    // Other — catch-all system disposition → map to No Answer
    "other": "73a0d17f-1163-4015-bdd5-ec830791da20",
  };

  const mapped = dispositionMap[normalized];
  if (mapped) {
    return mapped;
  }

  // Fallback: unmapped dispositions default to "No Answer" so they still create
  // HubSpot activity instead of silently failing. Log a warning for investigation.
  const NO_ANSWER_FALLBACK = "73a0d17f-1163-4015-bdd5-ec830791da20";
  console.warn(`⚠️ UNMAPPED DISPOSITION: "${disposition}" (normalized: "${normalized}") — falling back to No Answer`);
  console.warn(`   Known dispositions: ${Object.keys(dispositionMap).join(", ")}`);
  return NO_ANSWER_FALLBACK;
}

/**
 * Verify HubSpot contact exists
 */
async function verifyContactExists(
  contactId: string,
  accessToken: string
): Promise<{ exists: boolean; contact?: { firstname?: string; lastname?: string; phone?: string } }> {
  try {
    const response = await hubspotFetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,phone`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log(`Contact verified: ${data.id} - ${data.properties?.firstname} ${data.properties?.lastname}`);
      return {
        exists: true,
        contact: {
          firstname: data.properties?.firstname,
          lastname: data.properties?.lastname,
          phone: data.properties?.phone,
        }
      };
    }

    return { exists: false };
  } catch (error) {
    console.error("Error verifying contact:", error);
    return { exists: false };
  }
}

/**
 * Get timezone offset for IANA timezone (e.g., "Australia/Perth" -> "+08:00")
 */
function getTimezoneOffset(timezone: string, date: Date = new Date()): string {
  try {
    // Use Intl API to get offset for the timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find((part) => part.type === "timeZoneName");

    if (offsetPart?.value) {
      // Extract offset like "GMT+8" or "GMT+08:00"
      const match = offsetPart.value.match(/GMT([+-]\d{1,2}):?(\d{2})?/);
      if (match) {
        const hours = match[1].padStart(3, "+0"); // "+8" -> "+08"
        const minutes = match[2] || "00";
        return `${hours}:${minutes}`;
      }
    }
  } catch (error) {
    console.error(`Failed to get offset for timezone ${timezone}:`, error);
  }

  // Default to UTC if can't determine
  return "+00:00";
}

/**
 * Parse call start time with timezone handling
 *
 * RingCX sends call_start as a naive datetime (no timezone indicator).
 * Verified Feb 2026 from webhook log analysis: diff between call_start (naive)
 * and processed_at (UTC) is consistently ~18,000 seconds (5 hours) plus a
 * small processing delay. This confirms call_start is in US Eastern (UTC-5 EST).
 *
 * Previous incorrect assumption: Sydney time (UTC+11) — this caused timestamps
 * to appear ~16 hours off (previous evening instead of current morning AWST).
 *
 * We convert: RingCX US Eastern time → UTC → HubSpot displays in agent's AWST.
 */
function parseCallStartTime(callStart: string, agentTimezone?: string): number {
  if (!callStart) return Date.now();

  // RingCX platform timezone — verified from webhook log analysis Feb 2026:
  // call_start offset to processed_at (UTC) is consistently ~5 hours = US Eastern
  const RINGCX_PLATFORM_TIMEZONE = "America/New_York";

  console.log(`Parsing call_start: "${callStart}" (RingCX platform tz: ${RINGCX_PLATFORM_TIMEZONE})`);

  // Check if it's already an epoch timestamp (10 or 13 digits)
  const epochMatch = callStart.match(/^\d{10,13}$/);
  if (epochMatch) {
    const timestamp = callStart.length === 10
      ? parseInt(callStart, 10) * 1000
      : parseInt(callStart, 10);
    console.log(`  Parsed as epoch: ${timestamp} (${new Date(timestamp).toISOString()})`);
    return timestamp;
  }

  // RingCX sends datetime without timezone info
  // Format: "2026-01-29 13:39:00" or "2026-01-29T13:39:00"
  // These are in the RingCX platform timezone (Australia/Sydney), NOT AWST
  const datetimeMatch = callStart.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (datetimeMatch) {
    const [_, year, month, day, hour, minute, second] = datetimeMatch;

    // Use Australia/Sydney to interpret the naive datetime from RingCX
    // This correctly handles AEDT (UTC+11) in summer and AEST (UTC+10) in winter
    const timezoneOffset = getTimezoneOffset(RINGCX_PLATFORM_TIMEZONE, new Date(`${year}-${month}-${day}`));

    // Parse with the platform timezone to get correct UTC
    const localTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${timezoneOffset}`);
    const timestamp = localTime.getTime();

    console.log(`  Parsed as ${RINGCX_PLATFORM_TIMEZONE} (${timezoneOffset}): ${timestamp} (${new Date(timestamp).toISOString()})`);
    console.log(`  Local time: ${year}-${month}-${day} ${hour}:${minute}:${second} ${timezoneOffset}`);

    if (!isNaN(timestamp)) {
      return timestamp;
    }
  }

  // Fallback: Try parsing as-is (will interpret as UTC or local time)
  let timestamp = new Date(callStart).getTime();
  if (!isNaN(timestamp)) {
    console.log(`  Parsed as Date: ${timestamp} (${new Date(timestamp).toISOString()})`);
    return timestamp;
  }

  // Final fallback to current time
  console.warn(`Could not parse call_start: "${callStart}", using current time`);
  return Date.now();
}

/**
 * Check if a form submission recently created a call engagement for this contact.
 * Used to avoid duplicate call records when both the form and RingCX webhook fire.
 * The form typically fires first (agent submits form) then the webhook fires
 * (agent dispositions in RingCX), so we check for recent form submissions.
 */
async function findRecentFormSubmissionCall(
  contactId: string,
  supabaseClient: any,
  windowMinutes: number = 60
): Promise<{ hubspot_call_id: string; id: string } | null> {
  try {
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabaseClient
      .from("hubspot_form_submissions")
      .select("id, hubspot_call_id")
      .eq("hubspot_contact_id", contactId)
      .not("hubspot_call_id", "is", null)
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("Error checking for recent form submission call:", error);
      return null;
    }

    return data;
  } catch (err) {
    console.warn("Exception checking for recent form submission call:", err);
    return null;
  }
}

/**
 * Update an existing HubSpot call engagement with richer data from the RingCX webhook.
 * Used when the form submission already created a call and the webhook has
 * additional data (actual duration, recording URL, agent name, summary, etc.)
 */
async function updateExistingCallEngagement(
  callId: string,
  payload: RingCXWebhookPayload,
  contactId: string,
  accessToken: string,
  contactInfo?: { firstname?: string; lastname?: string; phone?: string },
  agentTimezone?: string,
  hubspotOwnerId?: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const durationSeconds = parseCallDuration(payload.call_duration);
    const durationMs = durationSeconds * 1000;
    const callDirection = determineCallDirection(payload);
    const agentName = getAgentDisplayName(payload);

    // Resolve fields
    const callSummary = resolveField(payload.summary);
    const agentNotes = resolveField(payload.notes);
    const recordingUrl = resolveField(payload.recording_url);

    // Format disposition for title
    const dispositionLabel = payload.disposition
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
    const directionLabel = callDirection === "OUTBOUND" ? "Outbound" : "Inbound";

    // Build contact name
    const contactName = contactInfo?.firstname && contactInfo?.lastname
      ? `${contactInfo.firstname} ${contactInfo.lastname}`
      : contactInfo?.firstname || contactInfo?.lastname || "Unknown Contact";

    // Format phone numbers
    const aniFormatted = formatPhoneNumber(payload.ani);
    const dnisFormatted = formatPhoneNumber(payload.dnis);

    // Build call body header (matches createCallEngagement format)
    let callBodyHeader: string;
    if (callDirection === "OUTBOUND") {
      callBodyHeader = `Call from ${agentName} (${dnisFormatted}) to ${contactName} (${aniFormatted})`;
    } else {
      callBodyHeader = `Call from ${contactName} (${aniFormatted}) to ${agentName} (${dnisFormatted})`;
    }

    // Format duration display
    const durationMins = Math.floor(durationSeconds / 60);
    const durationSecs = durationSeconds % 60;
    const durationDisplay = durationMins > 0
      ? `${durationMins}m ${durationSecs}s`
      : `${durationSecs}s`;

    const callBodyParts = [
      callBodyHeader,
      `<b>Duration:</b> ${durationDisplay} | <b>Disposition:</b> ${dispositionLabel}`,
    ];

    if (callSummary) {
      callBodyParts.push("", "<b>Call Summary</b>", callSummary);
    }
    if (agentNotes) {
      callBodyParts.push("", "<b>Agent Notes</b>", agentNotes);
    }

    const updateProperties: Record<string, any> = {
      hs_call_title: `${directionLabel} Call - ${dispositionLabel}`,
      hs_call_body: callBodyParts.join("<br>"),
      hs_call_direction: callDirection,
      hs_call_disposition: mapDispositionToHubSpot(payload.disposition || "no_answer"),
      hs_call_duration: durationMs,
      hs_call_from_number: callDirection === "OUTBOUND" ? dnisFormatted : aniFormatted,
      hs_call_to_number: callDirection === "OUTBOUND" ? aniFormatted : dnisFormatted,
      ...(hubspotOwnerId && { hubspot_owner_id: hubspotOwnerId }),
    };

    if (recordingUrl) {
      updateProperties.hs_call_recording_url = recordingUrl;
    }

    console.log(`Updating existing HubSpot call ${callId} with webhook data:`, JSON.stringify(updateProperties, null, 2));

    const response = await hubspotFetch(`${HUBSPOT_API_BASE}/crm/v3/objects/calls/${callId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ properties: updateProperties }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot update call failed:", errorText);
      return { success: false, error: errorText };
    }

    console.log(`✅ Updated existing call engagement ${callId} with RingCX webhook data`);
    return { success: true };
  } catch (error) {
    console.error("HubSpot update call error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Create a call engagement in HubSpot
 */
async function createCallEngagement(
  payload: RingCXWebhookPayload,
  contactId: string,
  accessToken: string,
  contactInfo?: { firstname?: string; lastname?: string; phone?: string },
  agentTimezone?: string,
  hubspotOwnerId?: string | null
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    // Parse call duration using the new parser (handles HH:MM:SS format)
    const durationSeconds = parseCallDuration(payload.call_duration);
    const durationMs = durationSeconds * 1000;

    // Map disposition
    const hubspotDisposition = mapDispositionToHubSpot(payload.disposition);

    // Parse call start time with agent's timezone
    console.log(`🕐 TIMESTAMP DEBUG: raw call_start="${payload.call_start}", current UTC=${new Date().toISOString()}, current AWST=${new Date().toLocaleString("en-AU", { timeZone: "Australia/Perth" })}`);
    const callStartTimestamp = parseCallStartTime(payload.call_start, agentTimezone);
    console.log(`🕐 TIMESTAMP DEBUG: parsed epoch=${callStartTimestamp}, as UTC=${new Date(callStartTimestamp).toISOString()}, as AWST=${new Date(callStartTimestamp).toLocaleString("en-AU", { timeZone: "Australia/Perth" })}, as Sydney=${new Date(callStartTimestamp).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}`);

    // Determine call direction
    const callDirection = determineCallDirection(payload);

    // Get agent display name
    const agentName = getAgentDisplayName(payload);

    // Format phone numbers based on call direction
    // ANI = Automatic Number Identification (caller)
    // DNIS = Dialed Number Identification Service (called party)
    const aniFormatted = formatPhoneNumber(payload.ani);
    const dnisFormatted = formatPhoneNumber(payload.dnis);

    // Resolve fields that may contain unresolved RingCX template variables
    const callSummary = resolveField(payload.summary);
    const agentNotes = resolveField(payload.notes);
    const recordingUrl = resolveField(payload.recording_url);

    console.log(`Call direction: ${callDirection}`);
    console.log(`ANI (caller): ${payload.ani} -> ${aniFormatted}`);
    console.log(`DNIS (called): ${payload.dnis} -> ${dnisFormatted}`);
    console.log(`Agent name: ${agentName}`);
    console.log(`Contact name: ${contactInfo?.firstname} ${contactInfo?.lastname}`);
    console.log(`Disposition received: "${payload.disposition}"`);
    console.log(`Summary: ${callSummary ? `"${callSummary.substring(0, 80)}..."` : "(none)"}`);
    console.log(`Notes: ${agentNotes ? `"${agentNotes.substring(0, 80)}..."` : "(none)"}`);
    console.log(`Recording URL: ${recordingUrl ? "present" : "(none)"}`);

    // Format disposition for title (title case)
    const dispositionLabel = payload.disposition
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const directionLabel = callDirection === "OUTBOUND" ? "Outbound" : "Inbound";

    // Build contact name from HubSpot data
    const contactName = contactInfo?.firstname && contactInfo?.lastname
      ? `${contactInfo.firstname} ${contactInfo.lastname}`
      : contactInfo?.firstname || contactInfo?.lastname || "Unknown Contact";

    // Build call body header - simple format without arrows or disposition
    // OUTBOUND: Agent (DNIS=+613) calls contact (ANI=+614), display FROM agent TO contact
    // INBOUND: Contact (ANI) calls agent (DNIS), display FROM contact TO agent
    let callBodyHeader: string;
    if (callDirection === "OUTBOUND") {
      // Outbound: FROM agent (DNIS is the +613 company number) TO contact (ANI is customer mobile)
      callBodyHeader = `Call from ${agentName} (${dnisFormatted}) to ${contactName} (${aniFormatted})`;
    } else {
      // Inbound: FROM contact (ANI) TO agent (DNIS)
      callBodyHeader = `Call from ${contactName} (${aniFormatted}) to ${agentName} (${dnisFormatted})`;
    }

    // Format duration for display (e.g. "5m 30s" or "45s")
    const durationMins = Math.floor(durationSeconds / 60);
    const durationSecs = durationSeconds % 60;
    const durationDisplay = durationMins > 0
      ? `${durationMins}m ${durationSecs}s`
      : `${durationSecs}s`;

    const callBodyParts = [
      callBodyHeader,
      `<b>Duration:</b> ${durationDisplay} | <b>Disposition:</b> ${dispositionLabel}`,
    ];

    if (callSummary) {
      callBodyParts.push(
        "",
        "<b>Call Summary</b>",
        callSummary
      );
    }

    if (agentNotes) {
      callBodyParts.push(
        "",
        "<b>Agent Notes</b>",
        agentNotes
      );
    }

    const callPayload = {
      properties: {
        hs_timestamp: Date.now(), // Use disposition completion time (when webhook fires) to match RingCX agent view
        hs_activity_type: "Verification & Test Appointment Booking",
        hs_call_title: `${directionLabel} Call - ${dispositionLabel}`,
        hs_call_body: callBodyParts.join("<br>"),
        hs_call_direction: callDirection,
        hs_call_disposition: hubspotDisposition,
        hs_call_duration: durationMs,
        // OUTBOUND: agent (DNIS=company number) calls contact (ANI=customer mobile)
        // INBOUND: contact (ANI=customer mobile) calls agent (DNIS=company number)
        hs_call_from_number: callDirection === "OUTBOUND" ? dnisFormatted : aniFormatted,
        hs_call_to_number: callDirection === "OUTBOUND" ? aniFormatted : dnisFormatted,
        hs_call_status: "COMPLETED",
        ...(recordingUrl && { hs_call_recording_url: recordingUrl }),
        ...(hubspotOwnerId && { hubspot_owner_id: hubspotOwnerId }),
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 194, // Call to Contact association
            },
          ],
        },
      ],
    };

    // Validate critical fields before sending to HubSpot
    if (!callPayload.properties.hs_call_disposition) {
      throw new Error("Call disposition is required but not set");
    }
    if (!callPayload.properties.hs_activity_type) {
      throw new Error("Call activity type is required but not set");
    }

    console.log("Creating HubSpot call with payload:", JSON.stringify(callPayload, null, 2));

    const response = await hubspotFetch(`${HUBSPOT_API_BASE}/crm/v3/objects/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(callPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot create call failed:", errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    console.log("HubSpot call engagement created:", data.id);
    return { success: true, callId: data.id };
  } catch (error) {
    console.error("HubSpot create call error:", error);
    return { success: false, error: error.message };
  }
}

// Main handler
serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: RingCXWebhookPayload = await req.json();

    console.log("Received RingCX webhook:", JSON.stringify(payload, null, 2));
    console.log("Payload keys received:", Object.keys(payload));
    console.log("extern_id value:", payload.extern_id);
    console.log("agent_extern_id value:", payload.agent_extern_id || "not provided");

    // RingCX fires TWO webhooks per call:
    //   1. Auto-fire: empty agent_disposition, system disposition only — fired on call end
    //   2. Disposition: actual agent_disposition filled in — fired after agent submits disposition
    // We process ALL webhooks to ensure every call attempt (including passes like no_answer,
    // abandon, congestion) creates a HubSpot record. If an agent disposition webhook follows
    // for the same call_id, it will UPDATE the existing record with richer data (step 3 dedup).
    console.log("Raw disposition fields:", {
      agent_disposition: payload.agent_disposition,
      disposition: payload.disposition
    });

    if (!payload.agent_disposition || isUnresolvedTemplateVar(payload.agent_disposition)) {
      let systemDisp = (payload.disposition || "").toLowerCase().trim();

      if (!systemDisp) {
        // Both agent_disposition and system disposition are empty.
        // RingCX sometimes sends auto-fire webhooks with completely null disposition
        // fields (e.g., 0-second calls where the contact didn't answer). Default to
        // "no_answer" so these passes still create HubSpot call records.
        console.log(`📞 Empty disposition fields — defaulting to "no_answer" (0-duration pass)`);
        systemDisp = "no_answer";
      }

      // System disposition present — process it directly. For passes (no_answer, abandon,
      // busy, etc.) where no agent connected, this creates the HubSpot call record.
      // If an agent DID connect, their disposition webhook will arrive later and
      // UPDATE this record via call_recordings dedup.
      console.log(`📞 Auto-fire webhook with system disposition "${systemDisp}" — processing directly`);
      payload.agent_disposition = systemDisp;
      // Fall through to normal processing below
    }

    const disposition = payload.agent_disposition;
    console.log(`✓ Processing disposition webhook: "${disposition}"`);

    // Set disposition on payload for use in createCallEngagement
    payload.disposition = disposition;

    // Determine call direction early — needed for inbound fallback logic
    const callDirection = determineCallDirection(payload);

    // Resolve HubSpot contact ID — extern_id for outbound (lead-loaded) calls,
    // phone-based search fallback for inbound calls where extern_id is unavailable.
    let contactId = payload.extern_id || "";
    if (contactId.startsWith("hs-")) {
      contactId = contactId.substring(3);
      console.log(`Stripped 'hs-' prefix from extern_id: ${payload.extern_id} -> ${contactId}`);
    }

    // If extern_id is missing or looks like an unresolved template var, try phone fallback for inbound
    if (!contactId || isUnresolvedTemplateVar(contactId)) {
      if (callDirection === "INBOUND") {
        console.log(`📞 Inbound call without extern_id — attempting phone-based contact lookup via ANI: ${payload.ani}`);
        const ani = payload.ani || "";
        if (ani) {
          // Need HubSpot token early for phone search
          const earlyToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
          if (earlyToken) {
            const phoneContactId = await searchContactByPhone(ani, earlyToken);
            if (phoneContactId) {
              contactId = phoneContactId;
              console.log(`✅ Inbound call: resolved contact ${contactId} from ANI ${ani}`);
            }
          }
        }

        if (!contactId || isUnresolvedTemplateVar(contactId)) {
          // No contact found — still log to call_recordings so the data isn't lost
          console.warn(`⚠️ Inbound call: no HubSpot contact found for ANI "${ani}". Logging to call_recordings with null contact.`);

          const supabaseClient = createClient(
            Deno.env.get("SUPABASE_URL") ?? "",
            Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
          );

          const recordingUrl = resolveField(payload.recording_url);
          const agentName = getAgentDisplayName(payload);
          const durationSeconds = parseCallDuration(payload.call_duration);
          const callStartTimestamp = parseCallStartTime(payload.call_start);
          const customerPhone = formatPhoneNumber(ani);

          await supabaseClient.from("call_recordings").upsert(
            {
              call_id: payload.call_id,
              ringcx_recording_url: recordingUrl || null,
              call_direction: "INBOUND",
              call_duration_seconds: durationSeconds,
              call_start: new Date(callStartTimestamp).toISOString(),
              disposition,
              phone_number: customerPhone,
              agent_id: payload.agent_id,
              agent_name: agentName,
              hubspot_contact_id: null,
              hubspot_call_id: null,
              backup_status: recordingUrl ? "pending" : "no_recording",
            },
            { onConflict: "call_id" }
          );

          // Also log the webhook
          await supabaseClient.from("ringcx_webhook_logs").insert({
            call_id: payload.call_id,
            contact_id: null,
            payload,
            processed_at: new Date().toISOString(),
            status: "skipped_no_contact",
          });

          return new Response(
            JSON.stringify({
              success: true,
              warning: `Inbound call logged to call_recordings but no HubSpot contact found for ANI "${ani}"`,
              call_id: payload.call_id,
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 200,
            }
          );
        }
      } else {
        // Outbound call must have extern_id — this is a configuration error
        throw new Error(`extern_id (HubSpot contact ID) is required for outbound calls. Received: "${payload.extern_id}". Check RingCX tag name.`);
      }
    }

    // Initialize Supabase client for logging
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Log the webhook for audit trail
    const { data: logRow, error: insertError } = await supabaseClient
      .from("ringcx_webhook_logs")
      .insert({
        call_id: payload.call_id,
        contact_id: contactId,
        payload: payload,
        processed_at: new Date().toISOString(),
        status: "processing",
      })
      .select("id")
      .single();

    const webhookLogId = logRow?.id;

    if (insertError) {
      console.error("Failed to log webhook:", insertError);
      // Continue processing even if logging fails
    }

    // Get HubSpot access token
    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");

    if (!hubspotAccessToken) {
      console.error("HUBSPOT_ACCESS_TOKEN not configured");
      return new Response(
        JSON.stringify({
          success: false,
          error: "HubSpot integration not configured",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // Verify the contact exists in HubSpot and get contact info
    const contactVerification = await verifyContactExists(contactId, hubspotAccessToken);

    if (!contactVerification.exists) {
      console.error("HubSpot contact not found:", contactId);
      if (webhookLogId) {
        await supabaseClient
          .from("ringcx_webhook_logs")
          .update({ status: "failed", error_message: `Contact not found: ${contactId}` })
          .eq("id", webhookLogId);
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `HubSpot contact not found: ${contactId}`,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        }
      );
    }

    // Get agent mapping from DB (owner ID, leads_rep, timezone)
    const agentMapping = await getAgentMapping(payload.agent_id, payload.agent_extern_id, supabaseClient);
    let agentTimezone: string | undefined;
    if (agentMapping.hubspotOwnerId) {
      const ownerInfo = await getHubSpotOwnerInfo(agentMapping.hubspotOwnerId, hubspotAccessToken);
      if (ownerInfo?.timezone) {
        agentTimezone = ownerInfo.timezone;
        console.log(`Using agent timezone: ${agentTimezone}`);
      }
    }

    // Insert into call_recordings FIRST — always track the call regardless of HubSpot outcome
    const recordingUrl = resolveField(payload.recording_url);
    const agentName = getAgentDisplayName(payload);
    // callDirection already determined above (before extern_id resolution)
    const durationSeconds = parseCallDuration(payload.call_duration);
    const callStartTimestamp = parseCallStartTime(payload.call_start, agentTimezone);
    const customerPhone = callDirection === "OUTBOUND"
      ? formatPhoneNumber(payload.ani)
      : formatPhoneNumber(payload.ani);

    // Check if an auto-fire webhook already processed this call_id (dedup for same call)
    const { data: existingCallRec } = await supabaseClient
      .from("call_recordings")
      .select("hubspot_call_id")
      .eq("call_id", payload.call_id)
      .maybeSingle();

    const existingHubSpotCallId = existingCallRec?.hubspot_call_id || null;

    // Insert/update call_recordings — preserve hubspot_call_id if already set by auto-fire
    const callRecordingFields = {
      ringcx_recording_url: recordingUrl || null,
      call_direction: callDirection,
      call_duration_seconds: durationSeconds,
      call_start: new Date(callStartTimestamp).toISOString(),
      disposition: payload.disposition,
      phone_number: customerPhone,
      agent_id: payload.agent_id,
      agent_name: agentName,
      hubspot_contact_id: contactId,
      backup_status: recordingUrl ? "pending" : "no_recording",
    };

    let recordingInsertError;
    if (existingCallRec) {
      // Update existing row — don't overwrite hubspot_call_id
      ({ error: recordingInsertError } = await supabaseClient
        .from("call_recordings")
        .update(callRecordingFields)
        .eq("call_id", payload.call_id));
    } else {
      // Insert new row
      ({ error: recordingInsertError } = await supabaseClient
        .from("call_recordings")
        .insert({ call_id: payload.call_id, hubspot_call_id: null, ...callRecordingFields }));
    }

    if (recordingInsertError) {
      console.error("Failed to insert/update call_recordings row:", recordingInsertError);
    } else {
      console.log(`📼 Call recording tracked: ${payload.call_id} (${recordingUrl ? "has recording" : "no recording"})`);
    }

    // Deduplication priority:
    // 1. Same call_id already has a HubSpot call (auto-fire created it) → UPDATE with agent data
    // 2. Recent form submission created a call for this contact → UPDATE with webhook data
    // 3. Otherwise → CREATE new call engagement
    const recentFormCall = await findRecentFormSubmissionCall(contactId, supabaseClient);
    let result: { success: boolean; callId?: string; error?: string };

    if (existingHubSpotCallId) {
      // Auto-fire already created a HubSpot call for this call_id — update with richer agent data
      console.log(`🔄 Auto-fire already created HubSpot call ${existingHubSpotCallId} for call_id ${payload.call_id}. Updating with agent disposition.`);
      const updateResult = await updateExistingCallEngagement(
        existingHubSpotCallId,
        payload,
        contactId,
        hubspotAccessToken,
        contactVerification.contact,
        agentTimezone,
        agentMapping.hubspotOwnerId
      );
      result = { success: updateResult.success, callId: existingHubSpotCallId, error: updateResult.error };
    } else if (recentFormCall?.hubspot_call_id) {
      console.log(`🔄 Found recent form submission call ${recentFormCall.hubspot_call_id} for contact ${contactId}. Updating instead of creating new.`);
      const updateResult = await updateExistingCallEngagement(
        recentFormCall.hubspot_call_id,
        payload,
        contactId,
        hubspotAccessToken,
        contactVerification.contact,
        agentTimezone,
        agentMapping.hubspotOwnerId
      );
      result = { success: updateResult.success, callId: recentFormCall.hubspot_call_id, error: updateResult.error };
    } else {
      // No existing call — create new
      result = await createCallEngagement(
        payload,
        contactId,
        hubspotAccessToken,
        contactVerification.contact,
        agentTimezone,
        agentMapping.hubspotOwnerId
      );
    }

    if (!result.success) {
      if (webhookLogId) {
        await supabaseClient
          .from("ringcx_webhook_logs")
          .update({ status: "failed", error_message: result.error || "Failed to create/update call engagement" })
          .eq("id", webhookLogId);
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Failed to create/update call engagement",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // HubSpot engagement succeeded — update call_recordings with the HubSpot call ID
    await supabaseClient
      .from("call_recordings")
      .update({ hubspot_call_id: result.callId })
      .eq("call_id", payload.call_id);

    // Update contact properties: call notes flag, leads_rep, num_contacted_notes
    try {
      const contactProperties: Record<string, string> = {
        n0_ringcx_call_notes: "Yes",
      };

      // num_contacted_notes is now a read-only calculated property in HubSpot — skip update

      // Only set leads_rep for Booked Test or Not Interested dispositions
      const LEADS_REP_DISPOSITIONS = new Set([
        "booked_test", "booked", "book_water_test", "booked_water_test",
        "booked_test_single_leg", "booked_single_leg", "single_leg",
        "not_interested", "not_intrested", "ni",
      ]);
      const normDisp = (disposition || "").toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

      const hasRealAgent = agentMapping.leadsRep ||
        (payload.agent_id && !isUnresolvedTemplateVar(payload.agent_id) && payload.agent_id !== "0");

      if (hasRealAgent && LEADS_REP_DISPOSITIONS.has(normDisp)) {
        const leadsRepValue = agentMapping.leadsRep || getAgentDisplayName(payload);
        contactProperties.leads_rep = leadsRepValue;
        console.log(`📋 Will update leads_rep="${leadsRepValue}" (disposition: ${disposition})`);
      } else if (!hasRealAgent) {
        console.log(`📋 Skipping leads_rep update — system-level pass (no agent interaction)`);
      } else {
        console.log(`📋 Skipping leads_rep update — disposition "${disposition}" does not update leads_rep`);
      }

      // On specific dispositions, reassign contact owner
      try {
        const hubspotDispositionId = mapDispositionToHubSpot(disposition);
        const BOOKED_TEST_ID = "f72848b8-6063-4591-9832-a4e4604864f5";
        const BOOKED_SINGLE_LEG_ID = "0823d714-3974-4bb4-a65a-ecf3596f49ac";
        const CALL_BACK_ID = "4aa8b662-f76e-4557-8a24-ffae50519382";

        if (hubspotDispositionId === BOOKED_TEST_ID || hubspotDispositionId === BOOKED_SINGLE_LEG_ID) {
          contactProperties.hubspot_owner_id = ENQUIRIES_OWNER_ID;
          console.log(`🔄 ${disposition} — setting contact owner to Enquiries (${ENQUIRIES_OWNER_ID})`);
        } else if (hubspotDispositionId === NOT_INTERESTED_DISPOSITION_ID) {
          contactProperties.hubspot_owner_id = CHF_PROMOTIONS_OWNER_ID;
          console.log(`🔄 Not Interested — setting contact owner to CHF Promotions (${CHF_PROMOTIONS_OWNER_ID})`);
        } else if (hubspotDispositionId === CALL_BACK_ID) {
          contactProperties.hubspot_owner_id = SHANNON_WATSON_OWNER_ID;
          console.log(`🔄 Call Back — setting contact owner to Shannon Watson (${SHANNON_WATSON_OWNER_ID})`);
        }
      } catch {
        // If disposition can't be mapped, skip the owner change
      }

      const contactUpdateResponse = await hubspotFetch(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${hubspotAccessToken}`,
          },
          body: JSON.stringify({
            properties: contactProperties,
          }),
        }
      );
      if (!contactUpdateResponse.ok) {
        console.error(`Failed to update contact properties: ${contactUpdateResponse.status} ${await contactUpdateResponse.text()}`);
      } else {
        const propsUpdated = Object.keys(contactProperties).join(", ");
        console.log(`✅ Updated contact ${contactId}: ${propsUpdated}`);
      }
    } catch (err) {
      console.error("Error updating contact properties:", err);
      // Non-fatal — don't fail the webhook response
    }

    // ── Terminal disposition → move lead to archive campaign ──────────
    // When an agent dispositions a call as booked, not interested, wrong number,
    // etc., move the lead to the archive campaign so they stop being called
    // but retain history for potential reactivation.
    const ARCHIVE_CAMPAIGN_ID = 289;
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

    const normalizedDisposition = (payload.disposition || "")
      .toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

    if (TERMINAL_DISPOSITIONS.has(normalizedDisposition) && callDirection !== "INBOUND") {
      try {
        // Look up the lead's current routing to get campaign + lead ID
        // Skip for INBOUND calls — inbound callers are never loaded into RingCX campaigns
        const { data: routing } = await supabaseClient
          .from("ringcx_lead_routing")
          .select("current_campaign_id, ringcx_lead_id, current_tier")
          .eq("contact_id", contactId)
          .is("removed_at", null)
          .maybeSingle();

        if (routing?.current_campaign_id) {
          const sourceCampaignId = parseInt(routing.current_campaign_id, 10);
          let leadId = routing.ringcx_lead_id ? parseInt(routing.ringcx_lead_id, 10) : 0;

          // If we have the campaign but no lead ID, search for it
          if (!leadId && sourceCampaignId !== ARCHIVE_CAMPAIGN_ID) {
            const { token: searchToken } = await getRingCentralAccessToken(supabaseClient);
            if (searchToken) {
              const searchResult = await searchLeadInCampaign(String(sourceCampaignId), contactId, searchToken);
              if (searchResult.success && searchResult.leadId) {
                leadId = parseInt(searchResult.leadId, 10);
                console.log(`📦 Found lead ID ${leadId} for ${contactId} in campaign ${sourceCampaignId} via search`);
              }
            }
          }

          if (!leadId) {
            console.log(`📦 Terminal disposition "${payload.disposition}" for ${contactId} — routing exists (campaign ${sourceCampaignId}) but lead not found in RingCX`);
          } else

          if (sourceCampaignId === ARCHIVE_CAMPAIGN_ID) {
            console.log(`📦 Lead ${contactId} already in archive campaign — skipping move`);
          } else {
            console.log(`📦 Terminal disposition "${payload.disposition}" — moving contact ${contactId} (lead ${leadId}) from campaign ${sourceCampaignId} to archive ${ARCHIVE_CAMPAIGN_ID}`);

            const { token: ringcxToken } = await getRingCentralAccessToken(supabaseClient);
            if (ringcxToken) {
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
                    CAMPAIGN_ID: ARCHIVE_CAMPAIGN_ID.toString(),
                    LIST_ID: "0",
                    LIST_NAME: `Archived — ${payload.disposition}`,
                    CREATE_COPY_SETTING: "false",
                    DUPLICATE_ACTION_SETTING: "MOVE",
                  },
                },
              };

              const moveResp = await fetch(moveUrl, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${ringcxToken}`,
                },
                body: JSON.stringify(moveBody),
              });

              const moveText = await moveResp.text();
              if (moveResp.ok) {
                console.log(`✅ Lead ${contactId} moved to archive campaign ${ARCHIVE_CAMPAIGN_ID} after "${payload.disposition}"`);

                // Update routing record
                await supabaseClient
                  .from("ringcx_lead_routing")
                  .update({
                    removed_at: new Date().toISOString(),
                    removal_reason: `disposition:${normalizedDisposition}`,
                    current_tier: "ARCHIVED",
                    current_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                  })
                  .eq("contact_id", contactId)
                  .is("removed_at", null);

                // Log routing event
                await supabaseClient.from("lead_routing_events").insert({
                  contact_id: contactId,
                  event_type: "disposition_archived",
                  from_campaign_id: sourceCampaignId.toString(),
                  to_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                  from_tier: routing.current_tier,
                  to_tier: "ARCHIVED",
                  ringcx_lead_id: routing.ringcx_lead_id,
                  details: { reason: `terminal_disposition:${normalizedDisposition}` },
                }).then(() => {}).catch((e: unknown) => console.warn("Failed to log archive event:", e));
              } else {
                console.error(`⚠️ Move to archive failed for ${contactId}: ${moveResp.status} ${moveText}`);
              }
            } else {
              console.warn("⚠️ Could not get RingCX token for archive move");
            }
          }
        } else {
          // Fallback: no routing record (pre-routing leads). Search RingCX directly.
          console.log(`📦 Terminal disposition "${payload.disposition}" for ${contactId} — no routing record, searching RingCX campaigns directly`);

          // All active campaigns: HOT (272-277) + NEW (222,226,230,234,238,242) + OLD (223,227,231,235,239,243) + legacy (182)
          const ALL_ACTIVE_CAMPAIGN_IDS = [182, 222, 223, 226, 227, 230, 231, 234, 235, 238, 239, 242, 243, 272, 273, 274, 275, 276, 277];
          const { token: fallbackToken } = await getRingCentralAccessToken(supabaseClient);

          if (fallbackToken) {
            // Search all campaigns in parallel for the lead
            const searchResults = await Promise.all(
              ALL_ACTIVE_CAMPAIGN_IDS.map(async (cid) => {
                const result = await searchLeadInCampaign(String(cid), contactId, fallbackToken);
                return result.success ? { campaignId: cid, leadId: result.leadId! } : null;
              })
            );

            const found = searchResults.find((r) => r !== null);
            if (found) {
              console.log(`📦 Found lead ${contactId} in campaign ${found.campaignId} (leadId=${found.leadId}) — moving to archive`);

              const moveUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=MOVE_TO_CAMPAIGN`;
              const moveBody = {
                campaignLeadSearchCriteria: {
                  campaignId: found.campaignId,
                  leadIds: [parseInt(found.leadId, 10)],
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
                    LIST_NAME: `Archived — ${payload.disposition} (fallback)`,
                    CREATE_COPY_SETTING: "false",
                    DUPLICATE_ACTION_SETTING: "MOVE",
                  },
                },
              };

              const moveResp = await fetch(moveUrl, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${fallbackToken}`,
                },
                body: JSON.stringify(moveBody),
              });

              const moveText = await moveResp.text();
              if (moveResp.ok) {
                console.log(`✅ Fallback: Lead ${contactId} moved to archive from campaign ${found.campaignId}`);

                // Create retroactive routing record
                await supabaseClient.from("ringcx_lead_routing").insert({
                  contact_id: contactId,
                  current_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                  current_tier: "ARCHIVED",
                  ringcx_lead_id: found.leadId,
                  removed_at: new Date().toISOString(),
                  removal_reason: `disposition:${normalizedDisposition}`,
                  lead_date: new Date().toISOString(),
                  ingested_at: new Date().toISOString(),
                }).then(() => {}).catch((e: unknown) => console.warn("Failed to create retroactive routing:", e));

                // Log routing event
                await supabaseClient.from("lead_routing_events").insert({
                  contact_id: contactId,
                  event_type: "disposition_archived_fallback",
                  from_campaign_id: found.campaignId.toString(),
                  to_campaign_id: ARCHIVE_CAMPAIGN_ID.toString(),
                  from_tier: "UNKNOWN",
                  to_tier: "ARCHIVED",
                  ringcx_lead_id: found.leadId,
                  details: { reason: `terminal_disposition:${normalizedDisposition}`, fallback: true },
                }).then(() => {}).catch((e: unknown) => console.warn("Failed to log fallback archive event:", e));
              } else {
                console.error(`⚠️ Fallback move to archive failed for ${contactId}: ${moveResp.status} ${moveText}`);
              }
            } else {
              console.log(`📦 Lead ${contactId} not found in any active campaign — may have been removed already`);
            }
          } else {
            console.warn("⚠️ Could not get RingCX token for fallback archive search");
          }
        }
      } catch (archiveErr) {
        console.error(`Error archiving lead ${contactId} after terminal disposition:`, archiveErr);
        // Non-fatal — don't fail the webhook response
      }
    }

    // Update webhook log status to processed
    if (webhookLogId) {
      await supabaseClient
        .from("ringcx_webhook_logs")
        .update({
          status: "processed",
          hubspot_call_id: result.callId,
          hubspot_contact_id: contactId,
        })
        .eq("id", webhookLogId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        callId: result.callId,
        contactId: contactId,
        message: "Call engagement created successfully in HubSpot",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error processing webhook:", error);

    // Attempt to update webhook log with failure status
    try {
      const failClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
      );
      // If we have a log row ID, update it; otherwise insert a new failure record
      if (typeof webhookLogId !== "undefined" && webhookLogId) {
        await failClient
          .from("ringcx_webhook_logs")
          .update({
            status: "failed",
            error_message: error.message || "Unknown error",
          })
          .eq("id", webhookLogId);
      } else {
        // Try to extract call_id from the request body for traceability
        await failClient.from("ringcx_webhook_logs").insert({
          call_id: "unknown",
          payload: { error_context: "Failed before log row created" },
          processed_at: new Date().toISOString(),
          status: "failed",
          error_message: error.message || "Unknown error",
        });
      }
    } catch (logErr) {
      console.error("Failed to log error status:", logErr);
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Unknown error occurred",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      }
    );
  }
});
