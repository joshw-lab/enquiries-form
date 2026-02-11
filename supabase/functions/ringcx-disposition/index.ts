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
  call_duration: string;     // #call_duration#
  call_start: string;        // #call_start#

  // Agent info
  agent_id: string;          // #agent_id#
  agent_username: string;    // #agent_username#

  // Contact info - extern_id contains HubSpot contact ID
  extern_id: string;         // #extern_id# - REQUIRED: HubSpot contact ID
  ani: string;               // #ani# - caller phone number
  dnis: string;              // #dnis# - dialed number

  // Disposition
  disposition: string;       // #agent_disposition#

  // Notes and summary from disposition form
  notes?: string;            // Agent notes from disposition form
  summary?: string;          // AI-generated call summary

  // Additional metadata
  recording_url?: string;    // #recording_url#
  account_id?: string;       // #account_id#
}

/**
 * Map RingCX disposition to HubSpot call disposition
 */
function mapDispositionToHubSpot(disposition: string): string {
  const dispositionMap: Record<string, string> = {
    "book_water_test": "f240bbac-87c9-4f6e-bf70-924b57d47db7", // Connected - customize these GUIDs
    "call_back": "9d9162e7-6cf3-4944-bf63-4dff82258764",
    "not_interested": "a4c4c377-d246-4b32-a13b-75a56a4cd0ff",
    "other_department": "b2cf5968-551e-4856-9783-52b3da59a7d2",
    "unable_to_service": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "no_answer": "17b47fee-58de-441e-a44c-c6300d46f273", // No answer
    "wrong_number": "2e93c5c2-e46a-4e3f-8402-2293e0b2c9ff", // Wrong number
    "voicemail": "b2cf5968-551e-4856-9783-52b3da59a7d0", // Left voicemail
  };

  return dispositionMap[disposition] || disposition;
}

/**
 * Verify HubSpot contact exists
 */
async function verifyContactExists(
  contactId: string,
  accessToken: string
): Promise<boolean> {
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
      return true;
    }

    return false;
  } catch (error) {
    console.error("Error verifying contact:", error);
    return false;
  }
}

/**
 * Create a call engagement in HubSpot
 */
async function createCallEngagement(
  payload: RingCXWebhookPayload,
  contactId: string,
  accessToken: string
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    // Parse call duration (comes as string from RingCX)
    const durationSeconds = parseInt(payload.call_duration, 10) || 0;
    const durationMs = durationSeconds * 1000;

    // Map disposition
    const hubspotDisposition = mapDispositionToHubSpot(payload.disposition);

    // Parse call start time
    const callStartTimestamp = new Date(payload.call_start).getTime() || Date.now();

    // Format disposition for title
    const dispositionLabel = payload.disposition.replace(/_/g, " ");

    // Build call body with notes and summary
    const callBodyParts = [
      `Agent: ${payload.agent_username}`,
      `Call ID: ${payload.call_id}`,
    ];

    if (payload.summary) {
      callBodyParts.push("", "--- Call Summary ---", payload.summary);
    }

    if (payload.notes) {
      callBodyParts.push("", "--- Agent Notes ---", payload.notes);
    }

    const callPayload = {
      properties: {
        hs_timestamp: callStartTimestamp,
        hs_call_title: `Inbound Call - ${dispositionLabel}`,
        hs_call_body: callBodyParts.join("\n"),
        hs_call_direction: "INBOUND",
        hs_call_disposition: hubspotDisposition,
        hs_call_duration: durationMs,
        hs_call_from_number: payload.ani,
        hs_call_to_number: payload.dnis,
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

    // Validate required fields - extern_id is the HubSpot contact ID
    if (!payload.extern_id) {
      throw new Error(`extern_id (HubSpot contact ID) is required. Received: "${payload.extern_id}". Check RingCX tag name.`);
    }

    // Use "no_answer" as default disposition if none provided
    if (!payload.disposition) {
      console.log("No disposition provided, defaulting to 'no_answer'");
      payload.disposition = "no_answer";
    }

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

    // Verify the contact exists in HubSpot
    const contactExists = await verifyContactExists(contactId, hubspotAccessToken);

    if (!contactExists) {
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

    // Create call engagement in HubSpot
    const result = await createCallEngagement(payload, contactId, hubspotAccessToken);

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
