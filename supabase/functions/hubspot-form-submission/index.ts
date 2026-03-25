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
  singleLegReason: string;
  dateOfBookingCall: string;
  waterTestDay: string;
  waterTestDate: string;
  waterTestTime: string;
  leadsRep: string;
  availableFrom: string;
  howDidYouFindUs: string[];  // Changed to array for multi-select

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
  passthroughType: string;
  passthroughReason: string;
  createIsDeal: string;
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
  singleLegReason: "n1__lead_status_reason",
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

  // Internal Sales passthrough fields
  passthroughType: "passthrough_type",
  passthroughReason: "passthrough_reason",
  createIsDeal: "refer_to_internal_sales",
  notesForInternalSales: "notes_for_internal_sales",

  // Contact owner mapping
  contactOwner: "hubspot_owner_id",

  // Other Department routing
  forOtherDepartment: "for_other_department",

  // Notes
  notes: "notes_last_contacted",
  formNotes: "n0__form_notes",
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

  // Form notes — written to n0__form_notes for all dispositions
  if (data.notes) {
    properties[HUBSPOT_FIELD_MAPPINGS.formNotes] = data.notes;
  }

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

  // How did you find us - multi-select, join with semicolons
  if (data.howDidYouFindUs && data.howDidYouFindUs.length > 0) {
    properties[HUBSPOT_FIELD_MAPPINGS.howDidYouFindUs] = data.howDidYouFindUs.join(";");
  }

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

  // Single leg reason
  if (data.singleLegReason) {
    properties[HUBSPOT_FIELD_MAPPINGS.singleLegReason] = data.singleLegReason;
  }

  // Booking details — auto-set date of booking call from submission timestamp
  const bookingCallDate = toHubSpotDate(data.dateOfBookingCall) || toHubSpotDate(data.timestamp);
  if (bookingCallDate) properties[HUBSPOT_FIELD_MAPPINGS.dateOfBookingCall] = bookingCallDate;

  if (data.waterTestDay) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDay] = data.waterTestDay;

  const waterTestDate = toHubSpotDate(data.waterTestDate);
  if (waterTestDate) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDate] = waterTestDate;

  // Water test time - already comes with seconds from form (e.g., "11:00:00 AM")
  if (data.waterTestTime) {
    properties[HUBSPOT_FIELD_MAPPINGS.waterTestTime] = data.waterTestTime;
  }

  // New fields for HubSpot form alignment
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

  // List classification (amberlist for call backs)
  if (data.listClassification === "amberlist") {
    properties[HUBSPOT_FIELD_MAPPINGS.amberlist] = true;
  }

  // NOTE: Do NOT set advisedNotInterestedReason for Call Back
  // That field is only for "Not Interested" disposition
  // Amberlist reasons for Call Back are stored in notes only

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
  // Set for_other_department for all Other Department dispositions
  if (data.otherDepartment) {
    const deptLabels: Record<string, string> = {
      is: "Internal Sales",
      service: "Service",
      filters: "Filters",
      installs: "Installs",
      hr: "HR",
      accounts: "Accounts",
      marketing: "Marketing",
      it: "IT",
      direct_sales: "Direct Sales",
    };
    properties[HUBSPOT_FIELD_MAPPINGS.forOtherDepartment] = deptLabels[data.otherDepartment] || data.otherDepartment;
  }

  // Internal Sales specific fields
  if (data.otherDepartment === "is") {
    if (data.passthroughType) {
      // Normalize to HubSpot internal values — form may send label instead of value
      const passthroughTypeMap: Record<string, string> = {
        "Warm Transfer": "Warm Transfer",
        "Cold Transfer": "Cold Transfer",
        "Cold Transfer (No IS team available)": "Cold Transfer",
      };
      const normalizedType = passthroughTypeMap[data.passthroughType] || data.passthroughType;
      properties[HUBSPOT_FIELD_MAPPINGS.passthroughType] = normalizedType;
    }
    if (data.passthroughReason) {
      properties[HUBSPOT_FIELD_MAPPINGS.passthroughReason] = data.passthroughReason;
    }
    if (data.createIsDeal) {
      properties[HUBSPOT_FIELD_MAPPINGS.createIsDeal] = data.createIsDeal;
    }
    if (data.notesForInternalSales) {
      properties[HUBSPOT_FIELD_MAPPINGS.notesForInternalSales] = data.notesForInternalSales;
    }
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
    properties[HUBSPOT_FIELD_MAPPINGS.mainsWater] = "No";
    // Water source will be included in the note engagement
  }

  // Home owner (for non-homeowner sub-type)
  if (data.unableToServiceSubType === "non_homeowner") {
    properties[HUBSPOT_FIELD_MAPPINGS.homeOwner] = "No";
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
      if (data.singleLegReason) parts.push(`Single Leg Reason: ${data.singleLegReason}`);
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
      if (data.listClassification === "amberlist") {
        parts.push("List: Amberlist");
        // Include amberlist reason in notes (not stored in HubSpot property for Call Back)
        if (data.advisedNotInterestedReason) parts.push(`Amberlist Reason: ${data.advisedNotInterestedReason}`);
      }
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
        hr: "HR",
        accounts: "Accounts",
        marketing: "Marketing",
        it: "IT",
        direct_sales: "Direct Sales",
      };
      if (data.otherDepartment) parts.push(`Transferred to: ${deptMap[data.otherDepartment] || data.otherDepartment}`);
      if (data.passthroughType) parts.push(`Passthrough Type: ${data.passthroughType}`);
      if (data.passthroughReason) parts.push(`Passthrough Reason: ${data.passthroughReason}`);
      if (data.createIsDeal) parts.push(`IS Deal Type: ${data.createIsDeal}`);
      if (data.notesForInternalSales) parts.push(`IS Notes: ${data.notesForInternalSales}`);
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
 * Map form disposition to HubSpot call disposition GUID
 * GUIDs sourced from /hubspot call disposition IDs.csv
 */
function mapFormDispositionToHubSpot(disposition: DispositionType, leadStatus?: string): string {
  // Book Water Test with Single Leg gets its own GUID
  if (disposition === "book_water_test" && leadStatus === "SL") {
    return "0823d714-3974-4bb4-a65a-ecf3596f49ac"; // Booked Test - Single Leg
  }

  const dispositionMap: Record<DispositionType, string> = {
    book_water_test: "f72848b8-6063-4591-9832-a4e4604864f5",   // Booked Test
    call_back: "4aa8b662-f76e-4557-8a24-ffae50519382",          // Needs Call Back
    not_interested: "5e8c009f-db89-4e1a-9c9a-429b45faf0c0",     // Not interested
    other_department: "c5067c48-aaf1-4f67-9c56-6a749b666817",   // Other Departments
    unable_to_service: "109bdbfc-6552-40e0-8eb2-0e58c13208a1",  // Unable to Service
    no_answer: "73a0d17f-1163-4015-bdd5-ec830791da20",          // No answer
    wrong_number: "17b47fee-58de-441e-a44c-c6300d46f273",       // Wrong number
  };

  return dispositionMap[disposition] || "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // fallback: Connected
}

/**
 * Get human-readable disposition label
 */
function getDispositionLabel(disposition: DispositionType): string {
  const labels: Record<DispositionType, string> = {
    book_water_test: "Booked Test",
    call_back: "Call Back",
    not_interested: "Not Interested",
    other_department: "Other Department",
    unable_to_service: "Unable to Service",
    no_answer: "No Answer",
    wrong_number: "Wrong Number",
  };
  return labels[disposition] || disposition;
}

/**
 * Create a call engagement in HubSpot for the form submission.
 * This creates a proper call record (hs_calls object) so every disposition
 * has a trackable call engagement in HubSpot for reporting.
 */
async function createCallEngagement(
  contactId: string,
  data: FormData,
  noteContent: string,
  accessToken: string,
  hubspotOwnerId?: string | null
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    const timestampMs = new Date(data.timestamp).getTime();
    const hubspotDisposition = mapFormDispositionToHubSpot(data.disposition, data.leadStatus);
    const dispositionLabel = getDispositionLabel(data.disposition);

    // Format contact name
    const contactName = [data.firstName, data.lastName].filter(Boolean).join(" ") || "Unknown Contact";
    const phone = data.phoneNumber || "";

    // Get agent name from leadsRep field (set by agents for booked tests)
    // or fall back to contactInfo.agent_id (URL param from RingCX)
    const agentName = data.leadsRep || data.contactInfo?.agent_id || "";

    // Build call body — include agent name when available (matches webhook format)
    const callBodyParts = [
      agentName
        ? `Call from ${agentName} to ${contactName}${phone ? ` (${phone})` : ""}`
        : `Outbound call to ${contactName}${phone ? ` (${phone})` : ""}`,
      `<b>Disposition:</b> ${dispositionLabel}`,
    ];

    // Add disposition-specific details
    if (data.disposition === "book_water_test") {
      if (data.waterTestDate) callBodyParts.push(`<b>Test Date:</b> ${data.waterTestDate}`);
      if (data.waterTestTime) callBodyParts.push(`<b>Test Time:</b> ${data.waterTestTime}`);
      if (data.leadStatus) callBodyParts.push(`<b>Lead Status:</b> ${data.leadStatus === "SL" ? "Single Leg" : "Double Leg"}`);
    }

    if (data.notes) {
      callBodyParts.push("", `<b>Agent Notes:</b> ${data.notes}`);
    }

    const callPayload = {
      properties: {
        hs_timestamp: timestampMs,
        hs_activity_type: "Verification & Test Appointment Booking",
        hs_call_title: agentName
          ? `Outbound Call - ${dispositionLabel} (${agentName})`
          : `Outbound Call - ${dispositionLabel}`,
        hs_call_body: callBodyParts.join("<br>"),
        hs_call_direction: "OUTBOUND",
        hs_call_disposition: hubspotDisposition,
        hs_call_duration: 0,
        ...(phone && { hs_call_to_number: phone }),
        hs_call_status: "COMPLETED",
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

    console.log("Creating HubSpot call engagement from form submission:", JSON.stringify(callPayload, null, 2));

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
      console.error("HubSpot create call engagement failed:", errorText);
      return { success: false, error: errorText };
    }

    const result = await response.json();
    console.log("HubSpot call engagement created:", result.id);
    return { success: true, callId: result.id };
  } catch (error) {
    console.error("HubSpot create call engagement error:", error);
    return { success: false, error: error.message };
  }
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
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
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
        disposition: payload.disposition,
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

    // Auto-resolve leadsRep from agent_mappings if not manually set
    if (!payload.leadsRep && payload.contactInfo?.agent_id) {
      try {
        const agentId = payload.contactInfo.agent_id;
        // Try matching by agent_name first, then agent_extern_id
        const { data: agentMapping } = await supabaseClient
          .from("agent_mappings")
          .select("leads_rep, agent_name")
          .or(`agent_name.eq.${agentId},agent_extern_id.eq.${agentId}`)
          .limit(1)
          .maybeSingle();

        if (agentMapping) {
          payload.leadsRep = agentMapping.leads_rep || agentMapping.agent_name || agentId;
          console.log(`Auto-resolved leadsRep="${payload.leadsRep}" from agent_id="${agentId}"`);
        } else {
          // Fall back to using agent_id directly as leadsRep
          payload.leadsRep = agentId;
          console.log(`No agent mapping for "${agentId}", using agent_id as leadsRep`);
        }
      } catch (err) {
        console.warn("Error resolving leadsRep from agent_id:", err);
        // Fall back to agent_id
        payload.leadsRep = payload.contactInfo.agent_id;
      }
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

    if (contactId) {
      // Update existing contact — don't fail the whole submission if properties are rejected
      const updateResult = await updateHubSpotContact(
        contactId,
        hubspotProperties,
        hubspotAccessToken
      );
      if (!updateResult.success) {
        console.warn("Contact property update failed (continuing with engagements):", updateResult.error);
      }
    } else {
      // Create new contact — must succeed to have a contactId for engagements
      const createResult = await createHubSpotContact(
        hubspotProperties,
        hubspotAccessToken
      );
      if (!createResult.success || !createResult.contactId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: createResult.error || "Failed to create HubSpot contact",
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
          }
        );
      }
      contactId = createResult.contactId;
    }

    // Update form submission with HubSpot contact ID for sync tracking
    if (contactId && submission?.id) {
      const { error: updateError } = await supabaseClient
        .from("hubspot_form_submissions")
        .update({ hubspot_contact_id: contactId })
        .eq("id", submission.id);
      if (updateError) {
        console.warn("Failed to update submission with hubspot_contact_id:", updateError);
      }
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

      // Look up HubSpot owner ID from agent_mappings by agent name
      let hubspotOwnerId: string | null = null;
      if (payload.leadsRep) {
        try {
          const { data: agentMapping } = await supabaseClient
            .from("agent_mappings")
            .select("hubspot_owner_id")
            .eq("agent_name", payload.leadsRep)
            .not("hubspot_owner_id", "is", null)
            .limit(1)
            .maybeSingle();

          if (agentMapping?.hubspot_owner_id) {
            hubspotOwnerId = agentMapping.hubspot_owner_id;
            console.log(`Mapped agent "${payload.leadsRep}" to HubSpot owner ${hubspotOwnerId}`);
          } else {
            console.log(`No agent mapping found for "${payload.leadsRep}"`);
          }
        } catch (err) {
          console.warn("Error looking up agent mapping:", err);
        }
      }

      // Deduplication: Check if the RingCX webhook already created a call recording
      // for this contact within the last 15 minutes. If so, reuse that call ID
      // instead of creating a duplicate call engagement.
      let existingCallId: string | null = null;
      try {
        const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: recentRecording } = await supabaseClient
          .from("call_recordings")
          .select("hubspot_call_id")
          .eq("hubspot_contact_id", contactId)
          .not("hubspot_call_id", "is", null)
          .gte("call_start", windowStart)
          .order("call_start", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recentRecording?.hubspot_call_id) {
          existingCallId = recentRecording.hubspot_call_id;
          console.log(`🔄 Found recent RingCX call ${existingCallId} for contact ${contactId}. Skipping form call creation.`);
        }
      } catch (err) {
        console.warn("Error checking for recent call recordings:", err);
      }

      if (existingCallId) {
        // RingCX webhook already created a call — link it to this form submission
        if (submission?.id) {
          const { error: callIdUpdateError } = await supabaseClient
            .from("hubspot_form_submissions")
            .update({ hubspot_call_id: existingCallId })
            .eq("id", submission.id);
          if (callIdUpdateError) {
            console.warn("Failed to link existing call to submission:", callIdUpdateError);
          }
        }
      } else {
        // No existing RingCX call — create call engagement from form data
        const callResult = await createCallEngagement(
          contactId,
          payload,
          dispositionNote,
          hubspotAccessToken,
          hubspotOwnerId
        );

        if (callResult.success && callResult.callId) {
          console.log("Call engagement created:", callResult.callId);
          // Store the call engagement ID on the form submission
          if (submission?.id) {
            const { error: callIdUpdateError } = await supabaseClient
              .from("hubspot_form_submissions")
              .update({ hubspot_call_id: callResult.callId })
              .eq("id", submission.id);
            if (callIdUpdateError) {
              console.warn("Failed to update submission with hubspot_call_id:", callIdUpdateError);
            }
          }
        } else {
          console.warn("Failed to create call engagement:", callResult.error);
        }
      }

      // Trigger compiled_notes workflow ONLY for Book Water Test disposition
      // Must clear first then set to "Yes" — HubSpot workflows only fire on value change
      if (payload.disposition === "book_water_test") try {
        // Step 1: Clear the field
        await fetch(
          `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${hubspotAccessToken}`,
            },
            body: JSON.stringify({
              properties: {
                n0_ringcx_call_notes: "",
              },
            }),
          }
        );
        console.log(`Cleared n0_ringcx_call_notes for contact ${contactId}`);

        // Wait 20 seconds for HubSpot to register the clear before setting "Yes"
        await new Promise((resolve) => setTimeout(resolve, 20000));

        // Step 2: Set to "Yes" to trigger the workflow
        const triggerResponse = await fetch(
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
        if (!triggerResponse.ok) {
          console.error(`Failed to set n0_ringcx_call_notes: ${triggerResponse.status} ${await triggerResponse.text()}`);
        } else {
          console.log(`Set n0_ringcx_call_notes=Yes for contact ${contactId}`);
        }
      } catch (err) {
        console.error("Error setting n0_ringcx_call_notes:", err);
        // Non-fatal — don't fail the entire request
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
