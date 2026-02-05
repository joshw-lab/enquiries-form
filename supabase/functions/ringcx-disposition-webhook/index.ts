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
 * Parse call duration from various formats
 * Supports: "HH:MM:SS", "MM:SS", "SS", or plain seconds
 */
function parseCallDuration(duration: string): number {
  if (!duration) return 0;

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
  // If explicitly provided, use it
  if (payload.call_direction) {
    const dir = payload.call_direction.toUpperCase();
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
 * Get HubSpot owner ID from agent extern ID
 * This function can be extended to map RingCX agent IDs to HubSpot user IDs
 * For now, it's a placeholder for future implementation
 *
 * To implement:
 * 1. Create a Supabase table: agent_mappings (agent_extern_id, hubspot_owner_id)
 * 2. Query this table to get the HubSpot owner ID
 * 3. Return the owner ID to associate calls with the correct HubSpot user
 */
async function getHubSpotOwnerId(
  agentExternId: string | undefined,
  supabaseClient: any
): Promise<string | null> {
  if (!agentExternId) return null;

  try {
    // TODO: Query agent_mappings table
    // const { data } = await supabaseClient
    //   .from('agent_mappings')
    //   .select('hubspot_owner_id')
    //   .eq('agent_extern_id', agentExternId)
    //   .single();
    //
    // return data?.hubspot_owner_id || null;

    console.log(`Agent extern ID: ${agentExternId} (HubSpot owner mapping not yet implemented)`);
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

  const dispositionMap: Record<string, string> = {
    // Book Water Test variants
    "book_water_test": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
    "booked": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
    "booked_water_test": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
    "connected": "f240bbac-87c9-4f6e-bf70-924b57d47db7",

    // Call Back variants
    "call_back": "9d9162e7-6cf3-4944-bf63-4dff82258764",
    "callback": "9d9162e7-6cf3-4944-bf63-4dff82258764",
    "needs_call_back": "9d9162e7-6cf3-4944-bf63-4dff82258764",

    // Not Interested variants
    "not_interested": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",
    "not_intrested": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff", // common typo
    "ni": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",

    // Other Department
    "other_department": "b2cf5968-551e-4856-9783-52b3da59a7d2",
    "transfer": "b2cf5968-551e-4856-9783-52b3da59a7d2",

    // Unable to Service
    "unable_to_service": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "cannot_service": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "out_of_area": "73a0d17f-1163-4015-bdd5-ec830791da20",

    // No Answer variants
    "no_answer": "17b47fee-58de-441e-a44c-c6300d46f273",
    "noanswer": "17b47fee-58de-441e-a44c-c6300d46f273",
    "na": "17b47fee-58de-441e-a44c-c6300d46f273",
    "no_response": "17b47fee-58de-441e-a44c-c6300d46f273",

    // Wrong Number variants
    "wrong_number": "2e93c5c2-e46a-4e3f-8402-2293e0b2c9ff",
    "wrongnumber": "2e93c5c2-e46a-4e3f-8402-2293e0b2c9ff",
    "wrong": "2e93c5c2-e46a-4e3f-8402-2293e0b2c9ff",
    "invalid_number": "2e93c5c2-e46a-4e3f-8402-2293e0b2c9ff",

    // Not Qualified variants
    "not_qualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7a",
    "notqualified": "7cb0159d-1cc0-4f56-919e-e1231a7be7a",
    "nq": "7cb0159d-1cc0-4f56-919e-e1231a7be7a",

    // Voicemail variants
    "voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "left_voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "leftvoicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "left_vm": "b2cf5968-551e-4856-9783-52b3da59a7d0",
    "message_left": "b2cf5968-551e-4856-9783-52b3da59a7d0",
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
 * Parse call start time with timezone handling
 * RingCX may send various formats - handle them gracefully
 */
function parseCallStartTime(callStart: string): number {
  if (!callStart) return Date.now();

  console.log(`Parsing call_start: "${callStart}"`);

  // Check if it's already an epoch timestamp (10 or 13 digits)
  const epochMatch = callStart.match(/^\d{10,13}$/);
  if (epochMatch) {
    const timestamp = callStart.length === 10
      ? parseInt(callStart, 10) * 1000
      : parseInt(callStart, 10);
    console.log(`  Parsed as epoch: ${timestamp} (${new Date(timestamp).toISOString()})`);
    return timestamp;
  }

  // RingCX sends datetime in AWST (GMT+8) without timezone info
  // Format: "2026-01-29 13:39:00" or "2026-01-29T13:39:00"
  const datetimeMatch = callStart.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (datetimeMatch) {
    const [_, year, month, day, hour, minute, second] = datetimeMatch;

    // Parse as AWST (GMT+8) by explicitly constructing UTC time minus 8 hours
    // AWST 13:39 = UTC 05:39 (13:39 - 8 hours)
    const awstTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
    const timestamp = awstTime.getTime();

    console.log(`  Parsed as AWST datetime: ${timestamp} (${new Date(timestamp).toISOString()})`);
    console.log(`  AWST time: ${year}-${month}-${day} ${hour}:${minute}:${second} +08:00`);

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
  contactInfo?: { firstname?: string; lastname?: string; phone?: string }
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    // Parse call duration using the new parser (handles HH:MM:SS format)
    const durationSeconds = parseCallDuration(payload.call_duration);
    const durationMs = durationSeconds * 1000;

    // Map disposition
    const hubspotDisposition = mapDispositionToHubSpot(payload.disposition);

    // Parse call start time with proper handling
    const callStartTimestamp = parseCallStartTime(payload.call_start);

    // Determine call direction
    const callDirection = determineCallDirection(payload);

    // Get agent display name
    const agentName = getAgentDisplayName(payload);

    // Format phone numbers based on call direction
    // ANI = Automatic Number Identification (caller)
    // DNIS = Dialed Number Identification Service (called party)
    const aniFormatted = formatPhoneNumber(payload.ani);
    const dnisFormatted = formatPhoneNumber(payload.dnis);

    // Format disposition for title
    const dispositionLabel = payload.disposition.replace(/_/g, " ");
    const directionLabel = callDirection === "OUTBOUND" ? "Outbound" : "Inbound";

    // Build contact name from HubSpot data
    const contactName = contactInfo?.firstname && contactInfo?.lastname
      ? `${contactInfo.firstname} ${contactInfo.lastname}`
      : contactInfo?.firstname || contactInfo?.lastname || "Unknown Contact";

    // Build call body header based on direction
    // OUTBOUND: Agent (ANI) calls contact (DNIS), display as FROM agent TO contact
    // INBOUND: Contact (ANI) calls agent (DNIS), display as FROM contact TO agent
    let callBodyHeader: string;
    if (callDirection === "OUTBOUND") {
      // Outbound: FROM agent (ANI) TO contact (DNIS)
      callBodyHeader = `>>>>> [${directionLabel} - ${dispositionLabel}] Call from ${agentName} (${aniFormatted}) to ${contactName} (${dnisFormatted})`;
    } else {
      // Inbound: FROM contact (ANI) TO agent (DNIS)
      callBodyHeader = `>>>>> [${directionLabel} - ${dispositionLabel}] Call from ${contactName} (${aniFormatted}) to ${agentName} (${dnisFormatted})`;
    }

    const callBodyParts = [
      callBodyHeader,
      "<<<<<",
    ];

    if (payload.summary) {
      callBodyParts.push(
        "",
        "<b>Call Summary</b>",
        payload.summary
      );
    }

    if (payload.notes) {
      callBodyParts.push(
        "",
        "<b>Agent Notes</b>",
        payload.notes
      );
    }

    const callPayload = {
      properties: {
        hs_timestamp: callStartTimestamp,
        hs_activity_type: "Verification & Test Appointment Booking",
        hs_call_title: `${directionLabel} Call - ${dispositionLabel}`,
        hs_call_body: callBodyParts.join("<br>"),
        hs_call_direction: callDirection,
        hs_call_disposition: hubspotDisposition,
        hs_call_duration: durationMs,
        hs_call_from_number: callDirection === "OUTBOUND" ? aniFormatted : aniFormatted,
        hs_call_to_number: callDirection === "OUTBOUND" ? dnisFormatted : dnisFormatted,
        hs_call_status: "COMPLETED",
        ...(payload.recording_url && { hs_call_recording_url: payload.recording_url }),
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

    // Normalize disposition field - RingCX sends "agent_disposition", we use "disposition"
    const disposition = payload.agent_disposition || payload.disposition || "no_answer";
    if (!payload.agent_disposition && !payload.disposition) {
      console.log("No disposition provided, defaulting to 'no_answer'");
    }
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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
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

    // Create call engagement in HubSpot with contact info
    const result = await createCallEngagement(
      payload,
      contactId,
      hubspotAccessToken,
      contactVerification.contact
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
