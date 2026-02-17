import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// HubSpot API base URL
const HUBSPOT_API_BASE = "https://api.hubapi.com";

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

  // Infer from DNIS - if DNIS is the company number, it's inbound
  // Common company DNIS patterns (Australian)
  const companyDnisPatterns = [
    /^1300/, /^1800/, /^13\d{4}$/,  // Australian toll-free/local rate
    /^\(03\)/, /^03/,               // Melbourne landline
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
 * Format phone number to E.164 format for HubSpot
 */
function formatPhoneNumber(phone: string): string {
  if (!phone) return "";

  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, "");

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
function getAgentDisplayName(payload: RingCXWebhookPayload): string {
  // Prefer first/last name if available
  if (payload.agent_first_name || payload.agent_last_name) {
    return `${payload.agent_first_name || ""} ${payload.agent_last_name || ""}`.trim();
  }

  // Fall back to username, but clean it up if it's an email
  const username = payload.agent_username || "Unknown Agent";

  // If username looks like an email, extract the name part
  if (username.includes("@")) {
    const namePart = username.split("@")[0];
    // Remove any + suffix (e.g., josh.w+12345 -> josh.w)
    const cleanName = namePart.split("+")[0];
    // Convert josh.w or josh_w to Josh W
    return cleanName
      .split(/[._]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
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
    const response = await fetch(
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

/**
 * Get HubSpot owner ID from agent extern ID
 * Maps RingCX agent IDs to HubSpot user IDs via database lookup
 */
async function getHubSpotOwnerId(
  agentExternId: string | undefined,
  supabaseClient: any
): Promise<string | null> {
  if (!agentExternId) {
    console.log("No agent_extern_id provided, skipping owner mapping");
    return null;
  }

  try {
    const { data, error } = await supabaseClient
      .from('agent_mappings')
      .select('hubspot_owner_id, agent_name')
      .eq('agent_extern_id', agentExternId)
      .single();

    if (error) {
      console.log(`No mapping found for agent_extern_id: ${agentExternId}`);
      return null;
    }

    if (data?.hubspot_owner_id) {
      console.log(`Mapped agent ${agentExternId} (${data.agent_name || 'unknown'}) to HubSpot owner ${data.hubspot_owner_id}`);
      return data.hubspot_owner_id;
    }

    return null;
  } catch (error) {
    console.error("Error fetching HubSpot owner ID:", error);
    return null;
  }
}

/**
 * Map RingCX disposition to HubSpot call disposition
 * Handles various naming conventions and aliases
 */
function mapDispositionToHubSpot(disposition: string): string {
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
  };

  const mapped = dispositionMap[normalized];
  if (mapped) {
    return mapped;
  }

  // CRITICAL ERROR: Unmapped disposition will cause HubSpot to reject or default
  console.error(`❌ UNMAPPED DISPOSITION: "${disposition}" (normalized: "${normalized}")`);
  console.error(`   Available dispositions: ${Object.keys(dispositionMap).join(", ")}`);
  throw new Error(`Disposition "${disposition}" is not mapped to a HubSpot value. Add mapping to dispositionMap in the webhook code.`);
}

/**
 * Verify HubSpot contact exists
 */
async function verifyContactExists(
  contactId: string,
  accessToken: string
): Promise<{ exists: boolean; contact?: { firstname?: string; lastname?: string; phone?: string } }> {
  try {
    const response = await fetch(
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
          phone: data.properties?.phone
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
 * Create a call engagement in HubSpot
 */
async function createCallEngagement(
  payload: RingCXWebhookPayload,
  contactId: string,
  accessToken: string,
  contactInfo?: { firstname?: string; lastname?: string; phone?: string },
  agentTimezone?: string
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

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/calls`, {
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

    // Validate required fields - extern_id is the HubSpot contact ID
    if (!payload.extern_id) {
      throw new Error(`extern_id (HubSpot contact ID) is required. Received: "${payload.extern_id}". Check RingCX tag name.`);
    }

    // RingCX fires TWO webhooks per call:
    //   1. Auto-fire: empty agent_disposition, disposition="no_answer" — fired on call end
    //   2. Disposition: actual agent_disposition filled in — fired after agent submits disposition
    // We only want to create a HubSpot call record from the DISPOSITION webhook (#2)
    // to avoid duplicate records and ensure we have the correct disposition.
    console.log("Raw disposition fields:", {
      agent_disposition: payload.agent_disposition,
      disposition: payload.disposition
    });

    if (!payload.agent_disposition) {
      console.log("⏭️ Skipping auto-fire webhook (no agent_disposition) — waiting for disposition webhook");
      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          message: "Auto-fire webhook ignored — will process disposition webhook instead",
          call_id: payload.call_id,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    const disposition = payload.agent_disposition;
    console.log(`✓ Processing disposition webhook: "${disposition}"`);

    // Set disposition on payload for use in createCallEngagement
    payload.disposition = disposition;

    // Extract HubSpot contact ID - remove "hs-" prefix if present
    let contactId = payload.extern_id;
    if (contactId.startsWith("hs-")) {
      contactId = contactId.substring(3);
      console.log(`Stripped 'hs-' prefix from extern_id: ${payload.extern_id} -> ${contactId}`);
    }

    // Initialize Supabase client for logging
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Log the webhook for audit trail
    const { error: insertError } = await supabaseClient
      .from("ringcx_webhook_logs")
      .insert({
        call_id: payload.call_id,
        contact_id: contactId,
        payload: payload,
        processed_at: new Date().toISOString(),
      });

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

    // Get agent's timezone from HubSpot (if agent_extern_id is provided and mapped)
    let agentTimezone: string | undefined;
    if (payload.agent_extern_id) {
      const ownerId = await getHubSpotOwnerId(payload.agent_extern_id, supabaseClient);
      if (ownerId) {
        const ownerInfo = await getHubSpotOwnerInfo(ownerId, hubspotAccessToken);
        if (ownerInfo?.timezone) {
          agentTimezone = ownerInfo.timezone;
          console.log(`Using agent timezone: ${agentTimezone}`);
        }
      }
    }

    // Create call engagement in HubSpot with contact info and agent timezone
    const result = await createCallEngagement(
      payload,
      contactId,
      hubspotAccessToken,
      contactVerification.contact,
      agentTimezone
    );

    if (!result.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Failed to create call engagement",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // Update contact property to flag that call notes exist
    try {
      const contactUpdateResponse = await fetch(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${hubspotAccessToken}`,
          },
          body: JSON.stringify({
            properties: {
              n0_ringcx_call_notes: "Yes",
            },
          }),
        }
      );
      if (!contactUpdateResponse.ok) {
        console.error(`Failed to set n0_ringcx_call_notes: ${contactUpdateResponse.status} ${await contactUpdateResponse.text()}`);
      } else {
        console.log(`✅ Set n0_ringcx_call_notes=Yes for contact ${contactId}`);
      }
    } catch (err) {
      console.error("Error setting n0_ringcx_call_notes:", err);
      // Non-fatal — don't fail the webhook response
    }

    // Insert into call_recordings table for the recordings backup pipeline
    const recordingUrl = resolveField(payload.recording_url);
    const agentName = getAgentDisplayName(payload);
    const callDirection = determineCallDirection(payload);
    const durationSeconds = parseCallDuration(payload.call_duration);
    const callStartTimestamp = parseCallStartTime(payload.call_start, agentTimezone);
    const customerPhone = callDirection === "OUTBOUND"
      ? formatPhoneNumber(payload.ani)
      : formatPhoneNumber(payload.ani);

    const { error: recordingInsertError } = await supabaseClient
      .from("call_recordings")
      .upsert({
        call_id: payload.call_id,
        ringcx_recording_url: recordingUrl || null,
        call_direction: callDirection,
        call_duration_seconds: durationSeconds,
        call_start: new Date(callStartTimestamp).toISOString(),
        disposition: payload.disposition,
        phone_number: customerPhone,
        agent_id: payload.agent_id,
        agent_name: agentName,
        hubspot_contact_id: contactId,
        hubspot_call_id: result.callId,
        backup_status: recordingUrl ? "pending" : "no_recording",
      }, { onConflict: "call_id" });

    if (recordingInsertError) {
      console.error("Failed to insert call_recordings row:", recordingInsertError);
      // Non-fatal — don't fail the webhook response
    } else {
      console.log(`📼 Call recording queued for backup: ${payload.call_id} (${recordingUrl ? "has recording" : "no recording"})`);
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
