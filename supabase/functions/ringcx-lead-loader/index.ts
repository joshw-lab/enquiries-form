import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// RingCX API Configuration
const RINGCX_ACCOUNT_ID = "44510001";
const RINGCX_API_BASE = "https://ringcx.ringcentral.com/voice/api/v1";

/**
 * HubSpot List Membership Webhook Payload
 * Triggered when a contact is added to a list
 */
interface HubSpotListWebhookPayload {
  subscriptionType: string;
  portalId: number;
  objectId: number; // Contact ID
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  eventId: number;
  subscriptionId: number;
  attemptNumber: number;
}

/**
 * Lead data to send to RingCX
 */
interface RingCXLeadData {
  externId: string; // HubSpot contact ID
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
 * Get RingCentral access token with automatic refresh
 */
async function getRingCentralAccessToken(
  supabaseClient: ReturnType<typeof createClient>
): Promise<{ token: string | null; error?: string }> {
  try {
    // Fetch current auth state
    const { data: authData, error: fetchError } = await supabaseClient
      .from("ringcentral_auth")
      .select("*")
      .single();

    if (fetchError || !authData) {
      console.error("Failed to fetch RingCentral auth:", fetchError);
      return { token: null, error: "RingCentral auth not configured" };
    }

    // Check if access token needs refresh (expires in < 5 minutes)
    const now = new Date();
    const expiresAt = new Date(authData.rc_access_token_expires_at);
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();
    const fiveMinutes = 5 * 60 * 1000;

    if (timeUntilExpiry < fiveMinutes) {
      console.log("Access token expired or expiring soon, refreshing...");

      // Refresh the token
      const credentials = btoa(`${authData.rc_client_id}:${authData.rc_client_secret}`);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: authData.rc_refresh_token,
      });

      const response = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Token refresh failed:", errorText);
        return { token: null, error: "Failed to refresh RingCentral token" };
      }

      const tokenData = await response.json();
      const newExpiresAt = new Date(now.getTime() + (tokenData.expires_in * 1000));

      // Update database with new tokens
      await supabaseClient
        .from("ringcentral_auth")
        .update({
          rc_access_token: tokenData.access_token,
          rc_refresh_token: tokenData.refresh_token,
          rc_access_token_expires_at: newExpiresAt.toISOString(),
          last_refreshed_at: now.toISOString(),
        })
        .eq("id", authData.id);

      console.log("Token refreshed successfully");
      return { token: tokenData.access_token };
    }

    return { token: authData.rc_access_token };
  } catch (error) {
    console.error("Error getting RingCentral access token:", error);
    return { token: null, error: error.message };
  }
}

/**
 * Fetch contact data from HubSpot
 */
async function getHubSpotContact(
  contactId: string,
  accessToken: string
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
      "ringcx_campaignid",
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
async function pushLeadToRingCX(
  campaignId: string,
  leadData: RingCXLeadData,
  accessToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${campaignId}/leadLoader/direct`;

    console.log(`Pushing lead to RingCX: ${url}`);
    console.log("Lead data:", JSON.stringify(leadData, null, 2));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(leadData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("RingCX Lead Loader failed:", errorText);
      return { success: false, error: errorText };
    }

    const result = await response.json();
    console.log("Lead pushed successfully:", result);
    return { success: true };
  } catch (error) {
    console.error("RingCX API error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Format phone number to E.164 format
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

// Main handler
serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: HubSpotListWebhookPayload = await req.json();

    console.log("Received HubSpot list webhook:", JSON.stringify(payload, null, 2));

    // Validate required fields
    if (!payload.objectId) {
      throw new Error("objectId (contact ID) is required");
    }

    const contactId = payload.objectId.toString();

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

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

    // Fetch contact from HubSpot
    console.log(`Fetching contact ${contactId} from HubSpot...`);
    const contactResult = await getHubSpotContact(contactId, hubspotAccessToken);

    if (!contactResult.success || !contactResult.contact) {
      return new Response(
        JSON.stringify({
          success: false,
          error: contactResult.error || "Failed to fetch contact from HubSpot",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        }
      );
    }

    const contact = contactResult.contact;
    const properties = contact.properties;

    // Get campaign ID from contact properties
    const campaignId = properties.ringcx_campaignid;
    if (!campaignId) {
      console.warn(`Contact ${contactId} has no ringcx_campaignid property`);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Contact does not have a RingCX Campaign ID (ringcx_campaignid)",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    console.log(`Contact has campaign ID: ${campaignId}`);

    // Get RingCentral access token
    const { token: ringcxAccessToken, error: tokenError } = await getRingCentralAccessToken(
      supabaseClient
    );

    if (!ringcxAccessToken) {
      console.error("Failed to get RingCX access token:", tokenError);
      return new Response(
        JSON.stringify({
          success: false,
          error: tokenError || "Failed to get RingCX access token",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // Build lead data for RingCX
    const leadData: RingCXLeadData = {
      externId: contactId, // HubSpot contact ID for reference
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

    // Push lead to RingCX
    const result = await pushLeadToRingCX(campaignId, leadData, ringcxAccessToken);

    if (!result.success) {
      // Log failure to database
      await supabaseClient.from("error_log").insert({
        source: "ringcx-lead-loader",
        error_message: result.error || "Failed to push lead to RingCX",
        error_details: {
          contactId,
          campaignId,
          error: result.error,
        },
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Failed to push lead to RingCX",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // Log success
    console.log(`Successfully pushed contact ${contactId} to RingCX campaign ${campaignId}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Lead pushed to RingCX successfully",
        contactId: contactId,
        campaignId: campaignId,
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
        details: error.stack,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      }
    );
  }
});
