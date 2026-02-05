import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// HubSpot API base URL
const HUBSPOT_API_BASE = "https://api.hubapi.com";

// Type definitions
type DispositionType =
  | "book_water_test"
  | "call_back"
  | "not_interested"
  | "other_department"
  | "unable_to_service"
  | "no_answer"
  | "wrong_number";

type ListClassification = "amberlist" | "greylist" | "blacklist" | "";

interface ContactInfo {
  contact_id: string;
  name: string;
  phone: string;
  email: string;
  agent_id?: string;
}

interface FormData {
  disposition: DispositionType;
  postcode: string;

  // Book Water Test fields
  firstName: string;
  lastName: string;
  phoneNumber: string;
  streetAddress: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  emailAddress: string;
  homeOwner: "yes" | "no" | "";
  mainsWater: "yes" | "no" | "";
  peopleInHouse: string;
  propertyType: string;
  partnerName: string;
  referred: "yes" | "no" | "";
  referrersName: string;
  strata: "yes" | "no" | "";
  waterConcerns: string[];
  leadStatus: "SL" | "DL" | "";
  dateOfBookingCall: string;
  waterTestDay: string;
  waterTestDate: string;
  waterTestTime: string;
  leadsRep: string;
  availableFrom: string;
  howDidYouFindUs: string;

  // Call Back fields
  callBackSubType: string;
  followUpDate: string;
  wantsFollowedUp: "yes" | "no" | "";

  // Not Interested fields
  notInterestedSubType: string;
  listClassification: ListClassification;
  advisedNotInterestedReason: string;

  // Other Department fields
  otherDepartment: string;
  createIsDeal: "yes" | "no" | "";
  notesForInternalSales: string;

  // Unable to Service fields
  unableToServiceSubType: string;
  waterSource: string;

  // No Answer fields
  noAnswerSubType: string;

  // Wrong Number fields
  wrongNumberSubType: string;

  // Common
  notes: string;
  timestamp: string;
  contactInfo?: ContactInfo | null;
}

/**
 * HubSpot Contact Property Mappings
 * Maps form fields to HubSpot internal property names
 * Verified against CHF HubSpot portal (47417644)
 */
const HUBSPOT_FIELD_MAPPINGS = {
  // Standard HubSpot contact properties
  firstName: "firstname",
  lastName: "lastname",
  phoneNumber: "phone",
  emailAddress: "email",
  streetAddress: "address",
  city: "city",
  stateRegion: "state",
  postalCode: "zip",

  // CHF Custom Properties
  homeOwner: "n1__home_owner_",
  mainsWater: "n1__mains_water_",
  peopleInHouse: "n1__number_of_people_in_the_house",
  propertyType: "type_of_property",
  partnerName: "partners_name",
  referred: "n1__referred_",
  referrersName: "n1__referrers_name",
  strata: "n1__strata",
  waterConcerns: "water_concerns",
  leadStatus: "hs_lead_status",
  dateOfBookingCall: "date_water_test_booked",
  waterTestDay: "water_test_day",
  waterTestDate: "water_test_date",
  waterTestTime: "water_test_time",
  leadsRep: "leads_rep",
  availableFrom: "available_from",
  howDidYouFindUs: "n1__how_did_you_find_out_about_us_",

  // Call Back fields
  followUpDate: "follow_up_date",
  wantsFollowedUp: "wants_followed_up__call_back",

  // List classification fields
  amberlist: "n1__amberlist___not_ready_now",
  greylist: "n1__greylist___advised_not_interested",
  blacklist: "n1__blacklist___do_not_contact",
  advisedNotInterestedReason: "new_advised_not_interested__classification_",

  // Contact owner mapping
  contactOwner: "hubspot_owner_id",

  // Notes
  notes: "notes_last_contacted",
} as const;

/**
 * Convert boolean-style form values to HubSpot format
 * HubSpot expects "Yes" or "No" as strings, not booleans
 */
function toHubSpotBoolean(value: "yes" | "no" | ""): string | null {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return null;
}

/**
 * Convert date string to Unix timestamp (milliseconds) for HubSpot
 */
function toHubSpotDate(dateString: string): number | null {
  if (!dateString) return null;
  const date = new Date(dateString);
  // HubSpot expects dates at midnight UTC
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Build HubSpot contact properties from form data based on disposition type
 */
function buildHubSpotProperties(
  data: FormData
): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {};

  // Always include basic contact info if available
  if (data.firstName) properties[HUBSPOT_FIELD_MAPPINGS.firstName] = data.firstName;
  if (data.lastName) properties[HUBSPOT_FIELD_MAPPINGS.lastName] = data.lastName;
  if (data.phoneNumber) properties[HUBSPOT_FIELD_MAPPINGS.phoneNumber] = data.phoneNumber;
  if (data.emailAddress) properties[HUBSPOT_FIELD_MAPPINGS.emailAddress] = data.emailAddress;

  // Notes are handled separately via engagement API (notes_last_contacted is read-only)
  // NEVER set properties[HUBSPOT_FIELD_MAPPINGS.notes] in any disposition builder

  switch (data.disposition) {
    case "book_water_test":
      return buildBookWaterTestProperties(data, properties);
    case "call_back":
      return buildCallBackProperties(data, properties);
    case "not_interested":
      return buildNotInterestedProperties(data, properties);
    case "other_department":
      return buildOtherDepartmentProperties(data, properties);
    case "unable_to_service":
      return buildUnableToServiceProperties(data, properties);
    case "no_answer":
      return buildNoAnswerProperties(data, properties);
    case "wrong_number":
      return buildWrongNumberProperties(data, properties);
    default:
      return properties;
  }
}

/**
 * Build properties for Book Water Test disposition
 */
function buildBookWaterTestProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Address fields
  if (data.streetAddress) properties[HUBSPOT_FIELD_MAPPINGS.streetAddress] = data.streetAddress;
  if (data.city) properties[HUBSPOT_FIELD_MAPPINGS.city] = data.city;
  if (data.stateRegion) properties[HUBSPOT_FIELD_MAPPINGS.stateRegion] = data.stateRegion;
  if (data.postalCode) properties[HUBSPOT_FIELD_MAPPINGS.postalCode] = data.postalCode;

  // Property information
  const homeOwnerValue = toHubSpotBoolean(data.homeOwner);
  if (homeOwnerValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.homeOwner] = homeOwnerValue;

  const mainsWaterValue = toHubSpotBoolean(data.mainsWater);
  if (mainsWaterValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.mainsWater] = mainsWaterValue;

  if (data.peopleInHouse) properties[HUBSPOT_FIELD_MAPPINGS.peopleInHouse] = data.peopleInHouse;
  if (data.propertyType) properties[HUBSPOT_FIELD_MAPPINGS.propertyType] = data.propertyType;
  if (data.partnerName) properties[HUBSPOT_FIELD_MAPPINGS.partnerName] = data.partnerName;

  const strataValue = toHubSpotBoolean(data.strata);
  if (strataValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.strata] = strataValue;

  // Referral information
  const referredValue = toHubSpotBoolean(data.referred);
  if (referredValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.referred] = referredValue;
  if (data.referrersName) properties[HUBSPOT_FIELD_MAPPINGS.referrersName] = data.referrersName;
  if (data.howDidYouFindUs) properties[HUBSPOT_FIELD_MAPPINGS.howDidYouFindUs] = data.howDidYouFindUs;

  // Water concerns (multi-select - join as semicolon-separated)
  if (data.waterConcerns && data.waterConcerns.length > 0) {
    properties[HUBSPOT_FIELD_MAPPINGS.waterConcerns] = data.waterConcerns.join(";");
  }

  // Lead status - Map SL/DL to HubSpot's internal values
  // SL (Single Leg) = IN_PROGRESS, DL (Double Leg) = OPEN
  if (data.leadStatus) {
    if (data.leadStatus === 'SL') {
      properties[HUBSPOT_FIELD_MAPPINGS.leadStatus] = 'IN_PROGRESS';
    } else if (data.leadStatus === 'DL') {
      properties[HUBSPOT_FIELD_MAPPINGS.leadStatus] = 'OPEN';
    }
  }

  // Booking details
  const bookingCallDate = toHubSpotDate(data.dateOfBookingCall);
  if (bookingCallDate) properties[HUBSPOT_FIELD_MAPPINGS.dateOfBookingCall] = bookingCallDate;

  if (data.waterTestDay) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDay] = data.waterTestDay;

  const waterTestDate = toHubSpotDate(data.waterTestDate);
  if (waterTestDate) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDate] = waterTestDate;

  // Water test time - already comes with seconds from form (e.g., "11:00:00 AM")
  if (data.waterTestTime) {
    properties[HUBSPOT_FIELD_MAPPINGS.waterTestTime] = data.waterTestTime;
  }
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep;
  if (data.availableFrom) properties[HUBSPOT_FIELD_MAPPINGS.availableFrom] = data.availableFrom;

  return properties;
}

/**
 * Build properties for Call Back disposition
 */
function buildCallBackProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Follow up date
  const followUpDate = toHubSpotDate(data.followUpDate);
  if (followUpDate) properties[HUBSPOT_FIELD_MAPPINGS.followUpDate] = followUpDate;

  // Wants followed up
  const wantsFollowedUp = toHubSpotBoolean(data.wantsFollowedUp);
  if (wantsFollowedUp !== null) properties[HUBSPOT_FIELD_MAPPINGS.wantsFollowedUp] = wantsFollowedUp;

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep;

  return properties;
}

/**
 * Build properties for Not Interested disposition
 */
function buildNotInterestedProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // List classification
  if (data.listClassification === "amberlist") {
    properties[HUBSPOT_FIELD_MAPPINGS.amberlist] = true;
  } else if (data.listClassification === "greylist") {
    properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true;
  } else if (data.listClassification === "blacklist") {
    properties[HUBSPOT_FIELD_MAPPINGS.blacklist] = true;
  }

  // Advised not interested reason
  if (data.advisedNotInterestedReason) {
    properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = data.advisedNotInterestedReason;
  }

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep;

  return properties;
}

/**
 * Build properties for Other Department (Transfer Call) disposition
 */
function buildOtherDepartmentProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Store notes for internal sales
  if (data.notesForInternalSales) {
    properties[HUBSPOT_FIELD_MAPPINGS.notes] = `[Internal Sales Notes] ${data.notesForInternalSales}`;
  }

  return properties;
}

/**
 * Build properties for Unable to Service disposition
 */
function buildUnableToServiceProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // List classification
  if (data.listClassification === "amberlist") {
    properties[HUBSPOT_FIELD_MAPPINGS.amberlist] = true;
  } else if (data.listClassification === "greylist") {
    properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true;
  } else if (data.listClassification === "blacklist") {
    properties[HUBSPOT_FIELD_MAPPINGS.blacklist] = true;
  }

  // Advised not interested reason
  if (data.advisedNotInterestedReason) {
    properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = data.advisedNotInterestedReason;
  }

  // Water source (for water source sub-type)
  if (data.waterSource) {
    properties[HUBSPOT_FIELD_MAPPINGS.mainsWater] = false;
    // Water source will be included in the note engagement
  }

  // Home owner (for non-homeowner sub-type)
  if (data.unableToServiceSubType === "non_homeowner") {
    properties[HUBSPOT_FIELD_MAPPINGS.homeOwner] = false;
  }

  // Property type (for incompatible dwelling sub-type)
  if (data.unableToServiceSubType === "incompatible_dwelling" && data.propertyType) {
    properties[HUBSPOT_FIELD_MAPPINGS.propertyType] = data.propertyType;
  }

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep;

  return properties;
}

/**
 * Build properties for No Answer disposition
 */
function buildNoAnswerProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // No properties to set - call attempt details will be in the note engagement
  return properties;
}

/**
 * Build properties for Wrong Number disposition
 */
function buildWrongNumberProperties(
  data: FormData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Set greylist (no response to email automation)
  properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true;
  properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = "GREY- No response to Emails";

  // Wrong number type will be included in the note engagement
  return properties;
}

/**
 * Update HubSpot contact via API
 */
async function updateHubSpotContact(
  contactId: string,
  properties: Record<string, string | number | boolean>,
  accessToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
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

    console.log("HubSpot contact updated successfully");
    return { success: true };
  } catch (error) {
    console.error("HubSpot API error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Search for a contact by email or phone
 */
async function findHubSpotContact(
  email: string | undefined,
  phone: string | undefined,
  accessToken: string
): Promise<string | null> {
  if (!email && !phone) return null;

  try {
    // Try email first
    if (email) {
      const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "email",
                  operator: "EQ",
                  value: email,
                },
              ],
            },
          ],
          limit: 1,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          return data.results[0].id;
        }
      }
    }

    // Try phone if no email match
    if (phone) {
      const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "phone",
                  operator: "EQ",
                  value: phone,
                },
              ],
            },
          ],
          limit: 1,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          return data.results[0].id;
        }
      }
    }

    return null;
  } catch (error) {
    console.error("Error searching for contact:", error);
    return null;
  }
}

/**
 * Create a new HubSpot contact
 */
async function createHubSpotContact(
  properties: Record<string, string | number | boolean>,
  accessToken: string
): Promise<{ success: boolean; contactId?: string; error?: string }> {
  try {
    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot create contact failed:", errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    console.log("HubSpot contact created:", data.id);
    return { success: true, contactId: data.id };
  } catch (error) {
    console.error("HubSpot create contact error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Build comprehensive note content from form data
 */
function buildNoteContent(data: FormData): string {
  const parts: string[] = [];

  // Add disposition-specific details
  switch (data.disposition) {
    case "book_water_test":
      parts.push("Disposition: Book Water Test");
      if (data.leadStatus) parts.push(`Lead Status: ${data.leadStatus}`);
      if (data.waterTestDate) parts.push(`Test Date: ${data.waterTestDate}`);
      if (data.waterTestTime) parts.push(`Test Time: ${data.waterTestTime}`);
      break;

    case "call_back":
      parts.push("Disposition: Call Back");
      if (data.callBackSubType === "reschedule") {
        parts.push("Reason: Reschedule");
      } else if (data.callBackSubType === "follow_up") {
        parts.push("Reason: Follow Up");
      }
      if (data.followUpDate) parts.push(`Follow Up Date: ${data.followUpDate}`);
      break;

    case "not_interested":
      parts.push("Disposition: Not Interested");
      if (data.advisedNotInterestedReason) parts.push(`Reason: ${data.advisedNotInterestedReason}`);
      if (data.listClassification === "amberlist") parts.push("List: Amberlist");
      else if (data.listClassification === "greylist") parts.push("List: Greylist");
      else if (data.listClassification === "blacklist") parts.push("List: Blacklist");
      break;

    case "other_department":
      parts.push("Disposition: Other Department");
      const deptMap: Record<string, string> = {
        is: "Internal Sales",
        service: "Service",
        filters: "Filters",
        installs: "Installs",
      };
      if (data.otherDepartment) parts.push(`Transferred to: ${deptMap[data.otherDepartment] || data.otherDepartment}`);
      if (data.notesForInternalSales) parts.push(`Notes: ${data.notesForInternalSales}`);
      break;

    case "unable_to_service":
      parts.push("Disposition: Unable to Service");
      if (data.unableToServiceSubType === "water_source") {
        parts.push("Reason: Non-Mains Water");
        if (data.waterSource) parts.push(`Water Source: ${data.waterSource}`);
      } else if (data.unableToServiceSubType === "non_homeowner") {
        parts.push("Reason: Non-Homeowner");
      } else if (data.unableToServiceSubType === "incompatible_dwelling") {
        parts.push("Reason: Incompatible Dwelling");
        if (data.propertyType) parts.push(`Property Type: ${data.propertyType}`);
      }
      if (data.advisedNotInterestedReason) parts.push(`Classification: ${data.advisedNotInterestedReason}`);
      break;

    case "no_answer":
      parts.push("Disposition: No Answer");
      const attemptType = data.noAnswerSubType === "voicemail" ? "Voicemail Left" : "No Answer";
      parts.push(`Call Attempt: ${attemptType}`);
      break;

    case "wrong_number":
      parts.push("Disposition: Wrong Number");
      const wrongNumberType = data.wrongNumberSubType === "wrong_person" ? "Wrong Person" : "Invalid Number";
      parts.push(`Unreachable: ${wrongNumberType}`);
      break;
  }

  // Add user notes if provided
  if (data.notes) {
    parts.push(`\nAgent Notes: ${data.notes}`);
  }

  return parts.join(" | ");
}

/**
 * Create a note engagement for a contact
 */
async function createNoteEngagement(
  contactId: string,
  noteContent: string,
  timestamp: string,
  accessToken: string,
  agentId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Convert timestamp to Unix milliseconds for HubSpot
    const timestampMs = new Date(timestamp).getTime();

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        properties: {
          hs_note_body: noteContent,
          hs_timestamp: timestampMs,
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 202, // Note to Contact association
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

    console.log("HubSpot note created successfully");
    return { success: true };
  } catch (error) {
    console.error("HubSpot create note error:", error);
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
    const payload: FormData = await req.json();
    console.log("Received payload:", JSON.stringify(payload, null, 2));

    // Validate required fields
    if (!payload.disposition) {
      throw new Error("Disposition is required");
    }

    console.log("Disposition validated:", payload.disposition);

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Insert submission record for audit trail
    const { data: submission, error: insertError } = await supabaseClient
      .from("hubspot_form_submissions")
      .insert({
        source: "web",
        submitted_by: payload.contactInfo || null,
        contact: {
          email: payload.emailAddress,
          phone: payload.phoneNumber,
          name: `${payload.firstName} ${payload.lastName}`.trim(),
        },
        form_data: payload,
        metadata: {
          submittedAt: payload.timestamp,
          disposition: payload.disposition,
        },
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      // Continue even if insert fails - HubSpot update is primary
    }

    // Build HubSpot properties
    const hubspotProperties = buildHubSpotProperties(payload);

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

    // Determine contact ID - either from contactInfo or search
    let contactId = payload.contactInfo?.contact_id;

    if (!contactId) {
      // Search for existing contact
      contactId = await findHubSpotContact(
        payload.emailAddress,
        payload.phoneNumber,
        hubspotAccessToken
      );
    }

    let hubspotResult;

    if (contactId) {
      // Update existing contact
      hubspotResult = await updateHubSpotContact(
        contactId,
        hubspotProperties,
        hubspotAccessToken
      );
    } else {
      // Create new contact
      const createResult = await createHubSpotContact(
        hubspotProperties,
        hubspotAccessToken
      );
      contactId = createResult.contactId;
      hubspotResult = createResult;
    }

    if (!hubspotResult.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: hubspotResult.error || "Failed to update HubSpot",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    // Always create note engagement for every disposition
    if (contactId) {
      // Format note with readable timestamp
      const noteTimestamp = new Date(payload.timestamp).toLocaleString('en-AU', {
        timeZone: 'Australia/Perth',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });

      // Build comprehensive note content from form data
      const dispositionNote = buildNoteContent(payload);

      // Include agent ID in note if available
      const agentPrefix = payload.contactInfo?.agent_id
        ? `[Agent: ${payload.contactInfo.agent_id}] `
        : '';
      const noteContent = `${agentPrefix}[${noteTimestamp}] ${dispositionNote}`;

      const noteResult = await createNoteEngagement(
        contactId,
        noteContent,
        payload.timestamp,
        hubspotAccessToken,
        payload.contactInfo?.agent_id
      );

      if (!noteResult.success) {
        console.warn("Failed to create note engagement:", noteResult.error);
        // Don't fail the entire request if note creation fails
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        submissionId: submission?.id,
        contactId: contactId,
        message: "Form submitted successfully to HubSpot",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error processing request:", error);
    console.error("Error stack:", error.stack);
    console.error("Payload received:", JSON.stringify(payload, null, 2));

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
