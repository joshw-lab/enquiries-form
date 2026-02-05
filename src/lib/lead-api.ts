/**
 * Lead API - Functions for fetching lead/contact data from HubSpot via Supabase edge functions
 */

// Field definition for display
export interface LeadField {
  label: string
  value: string | null
}

// Section of lead information
export interface LeadSection {
  label: string
  fields: Record<string, LeadField>
}

// All sections of lead data
export interface LeadSections {
  contact: LeadSection
  leadManagement: LeadSection
  property: LeadSection
  waterAssessment: LeadSection
  appointment: LeadSection
  referrals: LeadSection
  salesNotes: LeadSection
  statusFlags: LeadSection
}

// Raw HubSpot properties for form pre-population
export interface RawLeadProperties {
  // Contact Information
  firstname?: string
  lastname?: string
  phone?: string
  email?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  hs_timezone?: string

  // Lead Management
  hs_lead_status?: string
  lifecyclestage?: string
  hubspot_owner_id?: string
  leads_rep?: string
  lead_source?: string
  referring_business?: string
  contact_priority?: string

  // RingCX Campaign IDs (state-based)
  ringcx_campaignid_new?: string
  ringcx_campaignid_newhitlist?: string
  ringcx_campaignid_old?: string
  ringcx_campaignid_oldhitlist?: string

  // Property Information
  type_of_property?: string
  n1__home_owner_?: string
  n1__strata?: string
  n1__number_of_people_in_the_house?: string
  partners_name?: string

  // Water Assessment
  n1__mains_water_?: string
  water_source?: string
  water_concerns?: string
  water_test_date?: string
  water_test_day?: string
  water_test_time?: string
  water_test_outcome?: string
  send_eqt_email_campaign?: string

  // Appointment & Follow-up
  appointment_template?: string
  met_?: string
  met_notes?: string
  confirmed_via?: string
  cancelled_via?: string
  follow_up_date?: string
  wants_followed_up__call_back?: string

  // Referrals
  n1__referred_?: string
  n1__referrers_name?: string
  n1__how_did_you_find_out_about_us_?: string

  // Sales & Notes
  create_internal_sales_deal?: string
  notes_for_internal_sales?: string
  notes_last_contacted?: string
  compiled_notes?: string
  createdate?: string
  date_water_test_booked?: string

  // Status Flags
  n1__amberlist___not_ready_now?: string
  n1__greylist___advised_not_interested?: string
  n1__blacklist___do_not_contact?: string
  new_advised_not_interested__classification_?: string
}

// Full lead data response
export interface LeadData {
  id: string
  sections: LeadSections
  rawProperties: RawLeadProperties
}

// API response wrapper
export interface LeadApiResponse {
  success: boolean
  contact?: LeadData
  error?: string
}

/**
 * Fetch lead data from HubSpot via Supabase edge function
 */
export async function fetchLeadData(contactId: string): Promise<LeadApiResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      success: false,
      error: 'Supabase not configured',
    }
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/hubspot-get-contact?contact_id=${encodeURIComponent(contactId)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
      }
    )

    const result = await response.json()

    if (!response.ok || !result.success) {
      return {
        success: false,
        error: result.error || 'Failed to fetch lead data',
      }
    }

    return {
      success: true,
      contact: result.contact as LeadData,
    }
  } catch (error) {
    console.error('Error fetching lead data:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    }
  }
}

/**
 * Convert raw HubSpot boolean string to yes/no/empty
 */
export function hubspotBoolToFormValue(value?: string): 'yes' | 'no' | '' {
  if (value === 'true') return 'yes'
  if (value === 'false') return 'no'
  return ''
}

/**
 * Convert raw HubSpot date timestamp to date string (YYYY-MM-DD)
 */
export function hubspotDateToFormValue(value?: string): string {
  if (!value || isNaN(Number(value))) return ''
  const date = new Date(Number(value))
  return date.toISOString().split('T')[0]
}

/**
 * Convert raw HubSpot water concerns string to array
 */
export function hubspotWaterConcernsToArray(value?: string): string[] {
  if (!value) return []
  return value.split(';').map(s => s.trim()).filter(Boolean)
}

// Lead status type to match form data
type LeadStatus = 'SL' | 'DL' | ''

/**
 * Map raw HubSpot properties to form data for pre-population
 */
export function mapLeadPropertiesToFormData(raw: RawLeadProperties): {
  firstName: string
  lastName: string
  phoneNumber: string
  emailAddress: string
  streetAddress: string
  city: string
  stateRegion: string
  postalCode: string
  homeOwner: 'yes' | 'no' | ''
  mainsWater: 'yes' | 'no' | ''
  peopleInHouse: string
  propertyType: string
  partnerName: string
  referred: 'yes' | 'no' | ''
  referrersName: string
  strata: 'yes' | 'no' | ''
  waterConcerns: string[]
  leadStatus: LeadStatus
  dateOfBookingCall: string
  waterTestDay: string
  waterTestDate: string
  waterTestTime: string
  leadsRep: string
  howDidYouFindUs: string[]  // Multi-select array
  followUpDate: string
  wantsFollowedUp: 'yes' | 'no' | ''
} {
  // Determine lead status with proper typing
  let leadStatus: LeadStatus = ''
  if (raw.hs_lead_status === 'SL') leadStatus = 'SL'
  else if (raw.hs_lead_status === 'DL') leadStatus = 'DL'

  return {
    firstName: raw.firstname || '',
    lastName: raw.lastname || '',
    phoneNumber: raw.phone || '',
    emailAddress: raw.email || '',
    streetAddress: raw.address || '',
    city: raw.city || '',
    stateRegion: raw.state || '',
    postalCode: raw.zip || '',
    homeOwner: hubspotBoolToFormValue(raw.n1__home_owner_),
    mainsWater: hubspotBoolToFormValue(raw.n1__mains_water_),
    peopleInHouse: raw.n1__number_of_people_in_the_house || '',
    propertyType: raw.type_of_property || '',
    partnerName: raw.partners_name || '',
    referred: hubspotBoolToFormValue(raw.n1__referred_),
    referrersName: raw.n1__referrers_name || '',
    strata: hubspotBoolToFormValue(raw.n1__strata),
    waterConcerns: hubspotWaterConcernsToArray(raw.water_concerns),
    leadStatus,
    dateOfBookingCall: hubspotDateToFormValue(raw.date_water_test_booked),
    waterTestDay: raw.water_test_day || '',
    waterTestDate: hubspotDateToFormValue(raw.water_test_date),
    waterTestTime: raw.water_test_time || '',
    leadsRep: raw.leads_rep || '',
    howDidYouFindUs: raw.n1__how_did_you_find_out_about_us_
      ? raw.n1__how_did_you_find_out_about_us_.split(';').map(s => s.trim()).filter(Boolean)
      : [],
    followUpDate: hubspotDateToFormValue(raw.follow_up_date),
    wantsFollowedUp: hubspotBoolToFormValue(raw.wants_followed_up__call_back),
  }
}
