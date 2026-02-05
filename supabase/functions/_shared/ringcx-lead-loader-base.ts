import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// RingCX API Configuration
export const RINGCX_ACCOUNT_ID = "44510001";
export const RINGCX_API_BASE = "https://ringcx.ringcentral.com/voice/api/v1";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * HubSpot List Membership Webhook Payload
 */
export interface HubSpotListWebhookPayload {
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
 * Get RingCentral access token with automatic refresh
 */
export async function getRingCentralAccessToken(
  supabaseClient: ReturnType<typeof createClient>
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
    const fiveMinutes = 5 * 60 * 1000;

    if (timeUntilExpiry < fiveMinutes) {
      console.log("Access token expired or expiring soon, refreshing...");

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
