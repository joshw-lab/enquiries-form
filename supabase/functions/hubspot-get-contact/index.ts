import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// HubSpot API base URL
const HUBSPOT_API_BASE = "https://api.hubapi.com";

/**
 * HubSpot Contact Properties to fetch
 * These map to the fields we want to display in the lead information panel
 */
const CONTACT_PROPERTIES = [
  // Standard HubSpot contact properties
  "firstname",
  "lastname",
  "phone",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "hs_timezone",

  // Lead Management
  "hs_lead_status",
  "lifecyclestage",
  "hubspot_owner_id",
  "leads_rep",
  "lead_source",
  "referring_business",
  "contact_priority",

  // RingCX Campaign IDs (state-based)
  "ringcx_campaignid_new",
  "ringcx_campaignid_newhitlist",
  "ringcx_campaignid_old",
  "ringcx_campaignid_oldhitlist",

  // Property Information
  "type_of_property",
  "n1__home_owner_",
  "n1__strata",
  "n1__number_of_people_in_the_house",
  "partners_name",

  // Water Assessment
  "n1__mains_water_",
  "water_source",
  "water_concerns",
  "water_test_date",
  "water_test_day",
  "water_test_time",
  "water_test_outcome",
  "send_eqt_email_campaign",

  // Appointment & Follow-up
  "appointment_template",
  "met_",
  "met_notes",
  "confirmed_via",
  "cancelled_via",
  "follow_up_date",
  "wants_followed_up__call_back",

  // Referrals
  "n1__referred_",
  "n1__referrers_name",
  "n1__how_did_you_find_out_about_us_",

  // Sales & Notes
  "create_internal_sales_deal",
  "notes_for_internal_sales",
  "notes_last_contacted",
  "compiled_notes",
  "createdate",
  "date_water_test_booked",
  "num_contacted_notes",

  // Status Flags
  "n1__amberlist___not_ready_now",
  "n1__greylist___advised_not_interested",
  "n1__blacklist___do_not_contact",
  "new_advised_not_interested__classification_",
];

/**
 * Map HubSpot property names to user-friendly field names
 */
const PROPERTY_LABELS: Record<string, string> = {
  // Contact Information
  firstname: "First Name",
  lastname: "Last Name",
  phone: "Phone Number",
  email: "Email",
  address: "Street Address",
  city: "City",
  state: "State/Region",
  zip: "Postal Code",
  hs_timezone: "Time Zone",

  // Lead Management
  hs_lead_status: "Lead Status",
  lifecyclestage: "Lifecycle Stage",
  hubspot_owner_id: "Contact Owner",
  leads_rep: "Leads Rep",
  lead_source: "Lead Source",
  referring_business: "Referring Business",
  contact_priority: "Contact Priority",

  // RingCX Campaign IDs
  ringcx_campaignid_new: "RingCX Campaign ID (New)",
  ringcx_campaignid_newhitlist: "RingCX Campaign ID (NewHitlist)",
  ringcx_campaignid_old: "RingCX Campaign ID (Old)",
  ringcx_campaignid_oldhitlist: "RingCX Campaign ID (OldHitlist)",

  // Property Information
  type_of_property: "Type of Property",
  n1__home_owner_: "Home Owner",
  n1__strata: "Strata",
  n1__number_of_people_in_the_house: "Number of People in House",
  partners_name: "Partner's Name",

  // Water Assessment
  n1__mains_water_: "Mains Water",
  water_source: "Water Source",
  water_concerns: "Water Concerns",
  water_test_date: "Water Test Date",
  water_test_day: "Water Test Day",
  water_test_time: "Water Test Time",
  water_test_outcome: "Water Test Outcome",
  send_eqt_email_campaign: "Send EQT Email Campaign",

  // Appointment & Follow-up
  appointment_template: "Appointment Template",
  met_: "Met?",
  met_notes: "Met Notes",
  confirmed_via: "Confirmed Via",
  cancelled_via: "Cancelled Via",
  follow_up_date: "Follow Up Date",
  wants_followed_up__call_back: "Wants Followed Up",

  // Referrals
  n1__referred_: "Referred?",
  n1__referrers_name: "Referrer's Name",
  n1__how_did_you_find_out_about_us_: "How Did You Find Us",

  // Sales & Notes
  create_internal_sales_deal: "Create Internal Sales Deal",
  notes_for_internal_sales: "Notes for Internal Sales",
  notes_last_contacted: "Initial Notes",
  compiled_notes: "Compiled Notes",
  createdate: "Create Date",
  date_water_test_booked: "Lead Date",
  num_contacted_notes: "Number of Contacted Notes",

  // Status Flags
  n1__amberlist___not_ready_now: "Amberlist",
  n1__greylist___advised_not_interested: "Greylist",
  n1__blacklist___do_not_contact: "Blacklist",
  new_advised_not_interested__classification_: "Not Interested Reason",
};

/**
 * Fetch contact from HubSpot by ID
 */
async function getHubSpotContact(
  contactId: string,
  accessToken: string
): Promise<{ success: boolean; contact?: Record<string, unknown>; error?: string }> {
  try {
    const propertiesParam = CONTACT_PROPERTIES.join(",");
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=${propertiesParam}`,
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
 * Format HubSpot properties for display
 */
function formatContactData(contact: Record<string, unknown>): Record<string, unknown> {
  const properties = contact.properties as Record<string, string | null>;
  const formatted: Record<string, unknown> = {
    id: contact.id,
    sections: {
      contact: {
        label: "Contact Details",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      leadManagement: {
        label: "Lead Management",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      property: {
        label: "Property Information",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      waterAssessment: {
        label: "Water Assessment",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      appointment: {
        label: "Appointment & Follow-up",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      referrals: {
        label: "Referrals",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      salesNotes: {
        label: "Sales & Notes",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
      statusFlags: {
        label: "Status & Classification",
        fields: {} as Record<string, { label: string; value: string | null }>,
      },
    },
  };

  // Define which properties belong to which section
  const sectionMapping: Record<string, string[]> = {
    contact: ["firstname", "lastname", "phone", "email", "address", "city", "state", "zip", "hs_timezone", "num_contacted_notes", "createdate"],
    leadManagement: ["hs_lead_status", "lifecyclestage", "hubspot_owner_id", "leads_rep", "lead_source", "referring_business", "contact_priority", "ringcx_campaignid_new", "ringcx_campaignid_newhitlist", "ringcx_campaignid_old", "ringcx_campaignid_oldhitlist"],
    property: ["type_of_property", "n1__home_owner_", "n1__strata", "n1__number_of_people_in_the_house", "partners_name"],
    waterAssessment: ["n1__mains_water_", "water_source", "water_concerns", "water_test_date", "water_test_day", "water_test_time", "water_test_outcome", "send_eqt_email_campaign"],
    appointment: ["appointment_template", "met_", "met_notes", "confirmed_via", "cancelled_via", "follow_up_date", "wants_followed_up__call_back"],
    referrals: ["n1__referred_", "n1__referrers_name", "n1__how_did_you_find_out_about_us_"],
    salesNotes: ["create_internal_sales_deal", "notes_for_internal_sales", "notes_last_contacted", "compiled_notes", "date_water_test_booked"],
    statusFlags: ["n1__amberlist___not_ready_now", "n1__greylist___advised_not_interested", "n1__blacklist___do_not_contact", "new_advised_not_interested__classification_"],
  };

  // Populate sections with formatted data
  for (const [sectionKey, propertyKeys] of Object.entries(sectionMapping)) {
    const section = (formatted.sections as Record<string, { fields: Record<string, unknown> }>)[sectionKey];
    for (const propKey of propertyKeys) {
      let value = properties[propKey];

      // Format boolean values
      if (value === "true") value = "Yes";
      else if (value === "false") value = "No";

      // Format dates (HubSpot returns timestamps in milliseconds)
      if (propKey.includes("date") && value && !isNaN(Number(value))) {
        const date = new Date(Number(value));
        value = date.toLocaleDateString("en-AU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
      }

      section.fields[propKey] = {
        label: PROPERTY_LABELS[propKey] || propKey,
        value: value || null,
      };
    }
  }

  // Add raw properties for form pre-population
  formatted.rawProperties = properties;

  return formatted;
}

// Main handler
serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get contact ID from query params or body
    let contactId: string | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      contactId = url.searchParams.get("contact_id") || url.searchParams.get("contactId");
    } else if (req.method === "POST") {
      const body = await req.json();
      contactId = body.contact_id || body.contactId;
    }

    if (!contactId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "contact_id is required",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
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

    // Fetch contact from HubSpot
    const result = await getHubSpotContact(contactId, hubspotAccessToken);

    if (!result.success || !result.contact) {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Failed to fetch contact from HubSpot",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        }
      );
    }

    // Format contact data for display
    const formattedContact = formatContactData(result.contact);

    return new Response(
      JSON.stringify({
        success: true,
        contact: formattedContact,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error processing request:", error);

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
