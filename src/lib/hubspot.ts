/**
 * HubSpot API Integration Library
 * Maps form fields to HubSpot contact properties
 */

// HubSpot API base URL
const HUBSPOT_API_BASE = 'https://api.hubapi.com'

// Types for form data (matching DispositionForm)
export type DispositionType =
  | 'book_water_test'
  | 'call_back'
  | 'not_interested'
  | 'other_department'
  | 'unable_to_service'
  | 'no_answer'
  | 'wrong_number'

export type ListClassification = 'amberlist' | 'greylist' | 'blacklist' | ''

export interface FormSubmissionData {
  disposition: DispositionType
  postcode: string

  // Book Water Test fields
  firstName: string
  lastName: string
  phoneNumber: string
  streetAddress: string
  city: string
  stateRegion: string
  postalCode: string
  emailAddress: string
  homeOwner: 'yes' | 'no' | ''
  mainsWater: 'yes' | 'no' | ''
  peopleInHouse: string
  propertyType: string
  partnerName: string
  referred: 'yes' | 'no' | ''
  referrersName: string
  strata: 'yes' | 'no' | ''
  waterConcerns: string[]
  leadStatus: 'SL' | 'DL' | ''
  dateOfBookingCall: string
  waterTestDay: string
  waterTestDate: string
  waterTestTime: string
  leadsRep: string
  availableFrom: string
  howDidYouFindUs: string

  // Call Back fields
  callBackSubType: string
  followUpDate: string
  wantsFollowedUp: 'yes' | 'no' | ''

  // Not Interested fields
  notInterestedSubType: string
  listClassification: ListClassification
  advisedNotInterestedReason: string

  // Other Department fields
  otherDepartment: string
  createIsDeal: 'yes' | 'no' | ''
  notesForInternalSales: string

  // Unable to Service fields
  unableToServiceSubType: string
  waterSource: string

  // No Answer fields
  noAnswerSubType: string

  // Wrong Number fields
  wrongNumberSubType: string

  // Common
  notes: string
  timestamp: string
  contactInfo?: {
    contact_id: string
    name: string
    phone: string
    email: string
  } | null
}

/**
 * HubSpot Contact Property Mappings
 * Maps our form fields to HubSpot internal property names
 *
 * These property names are verified against the CHF HubSpot portal (47417644)
 */
export const HUBSPOT_FIELD_MAPPINGS = {
  // Standard HubSpot contact properties
  firstName: 'firstname',
  lastName: 'lastname',
  phoneNumber: 'phone',
  emailAddress: 'email',
  streetAddress: 'address',
  city: 'city',
  stateRegion: 'state',
  postalCode: 'zip',

  // CHF Custom Properties (verified from HubSpot portal 47417644 via Strata)
  homeOwner: 'n1__home_owner_',                           // "1. Home Owner" - enumeration/radio
  mainsWater: 'n1__mains_water_',                         // "1. Mains water?" - enumeration/radio
  peopleInHouse: 'n1__number_of_people_in_the_house',     // "1. Number of people in the house" - enumeration/select
  propertyType: 'type_of_property',                       // "1. Type of Property" - enumeration/select
  partnerName: 'partners_name',                           // "1. Partners Name" - string/text
  referred: 'n1__referred_',                              // "1. Referred?" - enumeration/radio
  referrersName: 'n1__referrers_name',                    // "1. Referrers Name" - string/text
  strata: 'n1__strata',                                   // "1. Strata" - enumeration/radio
  waterConcerns: 'water_concerns',                        // "1. Water Concerns" - enumeration/checkbox
  leadStatus: 'hs_lead_status',                           // "Lead Status" - enumeration/radio
  dateOfBookingCall: 'date_water_test_booked',            // "Date Water Test Booked" - date
  waterTestDay: 'water_test_day',                         // "2. Water Test Day" - enumeration/select
  waterTestDate: 'water_test_date',                       // "2. Water Test Date" - date
  waterTestTime: 'water_test_time',                       // "2. Water Test Time" - enumeration/select
  leadsRep: 'leads_rep',                                  // "Leads Rep" - enumeration/select
  availableFrom: 'available_from',                        // "Available From" - enumeration/select
  howDidYouFindUs: 'n1__how_did_you_find_out_about_us_',  // "1. How did you find out about us?" - enumeration/select

  // Call Back fields
  followUpDate: 'follow_up_date',                         // "Follow up date" - date
  wantsFollowedUp: 'wants_followed_up__call_back',        // "Wants followed up (Call Back)" - booleancheckbox

  // List classification fields (verified from HubSpot portal)
  amberlist: 'n1__amberlist___not_ready_now',             // "1. Amberlist - Not ready now" - booleancheckbox
  greylist: 'n1__greylist___advised_not_interested',      // "1. Greylist - Advised Not Interested" - booleancheckbox
  blacklist: 'n1__blacklist___do_not_contact',            // "1. Blacklist - Do Not Contact" - booleancheckbox
  advisedNotInterestedReason: 'new_advised_not_interested__classification_', // "1. Advised Not Interested (Specify reason)" - enumeration/select

  // Contact owner mapping
  contactOwner: 'hubspot_owner_id',

  // Notes
  notes: 'notes_last_contacted',                          // "Notes / Last Contacted" - string/textarea
} as const

/**
 * Contact Owner IDs - Map names to HubSpot owner IDs
 * These should be configured based on your HubSpot portal's user IDs
 */
export const CONTACT_OWNERS = {
  enquiries: process.env.HUBSPOT_OWNER_ENQUIRIES || '',
  shannonWatson: process.env.HUBSPOT_OWNER_SHANNON_WATSON || '',
  chfPromotions: process.env.HUBSPOT_OWNER_CHF_PROMOTIONS || '',
} as const

/**
 * Convert boolean-style form values to HubSpot format
 */
function toHubSpotBoolean(value: 'yes' | 'no' | ''): boolean | null {
  if (value === 'yes') return true
  if (value === 'no') return false
  return null
}

/**
 * Convert date string to Unix timestamp (milliseconds)
 */
function toHubSpotDate(dateString: string): number | null {
  if (!dateString) return null
  const date = new Date(dateString)
  // HubSpot expects dates at midnight UTC
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Build HubSpot contact properties from form data based on disposition type
 */
export function buildHubSpotProperties(data: FormSubmissionData): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {}

  // Always include basic contact info if available
  if (data.firstName) properties[HUBSPOT_FIELD_MAPPINGS.firstName] = data.firstName
  if (data.lastName) properties[HUBSPOT_FIELD_MAPPINGS.lastName] = data.lastName
  if (data.phoneNumber) properties[HUBSPOT_FIELD_MAPPINGS.phoneNumber] = data.phoneNumber
  if (data.emailAddress) properties[HUBSPOT_FIELD_MAPPINGS.emailAddress] = data.emailAddress

  // Add notes with timestamp
  if (data.notes) {
    const noteWithTimestamp = `[${new Date(data.timestamp).toLocaleString()}] ${data.notes}`
    properties[HUBSPOT_FIELD_MAPPINGS.notes] = noteWithTimestamp
  }

  switch (data.disposition) {
    case 'book_water_test':
      return buildBookWaterTestProperties(data, properties)
    case 'call_back':
      return buildCallBackProperties(data, properties)
    case 'not_interested':
      return buildNotInterestedProperties(data, properties)
    case 'other_department':
      return buildOtherDepartmentProperties(data, properties)
    case 'unable_to_service':
      return buildUnableToServiceProperties(data, properties)
    case 'no_answer':
      return buildNoAnswerProperties(data, properties)
    case 'wrong_number':
      return buildWrongNumberProperties(data, properties)
    default:
      return properties
  }
}

/**
 * Build properties for Book Water Test disposition
 */
function buildBookWaterTestProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Address fields
  if (data.streetAddress) properties[HUBSPOT_FIELD_MAPPINGS.streetAddress] = data.streetAddress
  if (data.city) properties[HUBSPOT_FIELD_MAPPINGS.city] = data.city
  if (data.stateRegion) properties[HUBSPOT_FIELD_MAPPINGS.stateRegion] = data.stateRegion
  if (data.postalCode) properties[HUBSPOT_FIELD_MAPPINGS.postalCode] = data.postalCode

  // Property information
  const homeOwnerValue = toHubSpotBoolean(data.homeOwner)
  if (homeOwnerValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.homeOwner] = homeOwnerValue

  const mainsWaterValue = toHubSpotBoolean(data.mainsWater)
  if (mainsWaterValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.mainsWater] = mainsWaterValue

  if (data.peopleInHouse) properties[HUBSPOT_FIELD_MAPPINGS.peopleInHouse] = data.peopleInHouse
  if (data.propertyType) properties[HUBSPOT_FIELD_MAPPINGS.propertyType] = data.propertyType
  if (data.partnerName) properties[HUBSPOT_FIELD_MAPPINGS.partnerName] = data.partnerName

  const strataValue = toHubSpotBoolean(data.strata)
  if (strataValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.strata] = strataValue

  // Referral information
  const referredValue = toHubSpotBoolean(data.referred)
  if (referredValue !== null) properties[HUBSPOT_FIELD_MAPPINGS.referred] = referredValue
  if (data.referrersName) properties[HUBSPOT_FIELD_MAPPINGS.referrersName] = data.referrersName
  if (data.howDidYouFindUs) properties[HUBSPOT_FIELD_MAPPINGS.howDidYouFindUs] = data.howDidYouFindUs

  // Water concerns (multi-select - join as semicolon-separated)
  if (data.waterConcerns && data.waterConcerns.length > 0) {
    properties[HUBSPOT_FIELD_MAPPINGS.waterConcerns] = data.waterConcerns.join(';')
  }

  // Lead status
  if (data.leadStatus) properties[HUBSPOT_FIELD_MAPPINGS.leadStatus] = data.leadStatus

  // Booking details
  const bookingCallDate = toHubSpotDate(data.dateOfBookingCall)
  if (bookingCallDate) properties[HUBSPOT_FIELD_MAPPINGS.dateOfBookingCall] = bookingCallDate

  if (data.waterTestDay) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDay] = data.waterTestDay

  const waterTestDate = toHubSpotDate(data.waterTestDate)
  if (waterTestDate) properties[HUBSPOT_FIELD_MAPPINGS.waterTestDate] = waterTestDate

  if (data.waterTestTime) properties[HUBSPOT_FIELD_MAPPINGS.waterTestTime] = data.waterTestTime
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep
  if (data.availableFrom) properties[HUBSPOT_FIELD_MAPPINGS.availableFrom] = data.availableFrom

  // Contact Owner: Enquiries (for TL confirmation/assignee)
  if (CONTACT_OWNERS.enquiries) {
    properties[HUBSPOT_FIELD_MAPPINGS.contactOwner] = CONTACT_OWNERS.enquiries
  }

  return properties
}

/**
 * Build properties for Call Back disposition
 */
function buildCallBackProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Follow up date
  const followUpDate = toHubSpotDate(data.followUpDate)
  if (followUpDate) properties[HUBSPOT_FIELD_MAPPINGS.followUpDate] = followUpDate

  // Wants followed up
  const wantsFollowedUp = toHubSpotBoolean(data.wantsFollowedUp)
  if (wantsFollowedUp !== null) properties[HUBSPOT_FIELD_MAPPINGS.wantsFollowedUp] = wantsFollowedUp

  // Contact Owner: Shannon Watson
  if (CONTACT_OWNERS.shannonWatson) {
    properties[HUBSPOT_FIELD_MAPPINGS.contactOwner] = CONTACT_OWNERS.shannonWatson
  }

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep

  return properties
}

/**
 * Build properties for Not Interested disposition
 */
function buildNotInterestedProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // List classification
  if (data.listClassification === 'amberlist') {
    properties[HUBSPOT_FIELD_MAPPINGS.amberlist] = true
  } else if (data.listClassification === 'greylist') {
    properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true
  } else if (data.listClassification === 'blacklist') {
    properties[HUBSPOT_FIELD_MAPPINGS.blacklist] = true
  }

  // Advised not interested reason
  if (data.advisedNotInterestedReason) {
    properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = data.advisedNotInterestedReason
  }

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep

  return properties
}

/**
 * Build properties for Other Department (Transfer Call) disposition
 */
function buildOtherDepartmentProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // For Internal Sales transfer, we need to create a deal
  // This is handled separately via createInternalSalesDeal()
  // Here we just store the notes

  if (data.notesForInternalSales) {
    properties[HUBSPOT_FIELD_MAPPINGS.notes] = `[Internal Sales Notes] ${data.notesForInternalSales}`
  }

  return properties
}

/**
 * Build properties for Unable to Service disposition
 */
function buildUnableToServiceProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // List classification
  if (data.listClassification === 'amberlist') {
    properties[HUBSPOT_FIELD_MAPPINGS.amberlist] = true
  } else if (data.listClassification === 'greylist') {
    properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true
  } else if (data.listClassification === 'blacklist') {
    properties[HUBSPOT_FIELD_MAPPINGS.blacklist] = true
  }

  // Advised not interested reason
  if (data.advisedNotInterestedReason) {
    properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = data.advisedNotInterestedReason
  }

  // Water source (for water source sub-type)
  if (data.waterSource) {
    properties[HUBSPOT_FIELD_MAPPINGS.mainsWater] = false
    // Store water source in notes or a custom field
    const existingNotes = properties[HUBSPOT_FIELD_MAPPINGS.notes] || ''
    properties[HUBSPOT_FIELD_MAPPINGS.notes] = `${existingNotes} [Water Source: ${data.waterSource}]`.trim()
  }

  // Home owner (for non-homeowner sub-type)
  if (data.unableToServiceSubType === 'non_homeowner') {
    properties[HUBSPOT_FIELD_MAPPINGS.homeOwner] = false
  }

  // Property type (for incompatible dwelling sub-type)
  if (data.unableToServiceSubType === 'incompatible_dwelling' && data.propertyType) {
    properties[HUBSPOT_FIELD_MAPPINGS.propertyType] = data.propertyType
  }

  // Contact Owner: CHF Promotions
  if (CONTACT_OWNERS.chfPromotions) {
    properties[HUBSPOT_FIELD_MAPPINGS.contactOwner] = CONTACT_OWNERS.chfPromotions
  }

  // Leads Rep
  if (data.leadsRep) properties[HUBSPOT_FIELD_MAPPINGS.leadsRep] = data.leadsRep

  return properties
}

/**
 * Build properties for No Answer disposition
 */
function buildNoAnswerProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // The "Number of Times Contacted" is updated by HubSpot automation
  // We just need to log the call attempt

  const attemptType = data.noAnswerSubType === 'voicemail' ? 'Voicemail left' : 'No answer'
  const existingNotes = properties[HUBSPOT_FIELD_MAPPINGS.notes] || ''
  properties[HUBSPOT_FIELD_MAPPINGS.notes] = `${existingNotes} [Call Attempt: ${attemptType}]`.trim()

  return properties
}

/**
 * Build properties for Wrong Number disposition
 */
function buildWrongNumberProperties(
  data: FormSubmissionData,
  properties: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  // Set greylist (no response to email automation)
  properties[HUBSPOT_FIELD_MAPPINGS.greylist] = true
  properties[HUBSPOT_FIELD_MAPPINGS.advisedNotInterestedReason] = 'Grey - No response to email'

  // Contact Owner: CHF Promotions
  if (CONTACT_OWNERS.chfPromotions) {
    properties[HUBSPOT_FIELD_MAPPINGS.contactOwner] = CONTACT_OWNERS.chfPromotions
  }

  // Add note about wrong number type
  const wrongNumberType = data.wrongNumberSubType === 'wrong_person' ? 'Wrong Person' : 'Invalid Number'
  const existingNotes = properties[HUBSPOT_FIELD_MAPPINGS.notes] || ''
  properties[HUBSPOT_FIELD_MAPPINGS.notes] = `${existingNotes} [Unreachable: ${wrongNumberType}]`.trim()

  return properties
}

/**
 * HubSpot API Client Class
 */
export class HubSpotClient {
  private accessToken: string

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  /**
   * Make an authenticated request to HubSpot API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${HUBSPOT_API_BASE}${endpoint}`

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`HubSpot API error: ${response.status} ${response.statusText} - ${errorBody}`)
    }

    return response.json()
  }

  /**
   * Search for a contact by email or phone
   */
  async findContact(email?: string, phone?: string): Promise<{ id: string } | null> {
    if (!email && !phone) return null

    const filters = []
    if (email) {
      filters.push({
        propertyName: 'email',
        operator: 'EQ',
        value: email,
      })
    }

    try {
      const response = await this.request<{ results: Array<{ id: string }> }>(
        '/crm/v3/objects/contacts/search',
        {
          method: 'POST',
          body: JSON.stringify({
            filterGroups: [{ filters }],
            limit: 1,
          }),
        }
      )

      if (response.results && response.results.length > 0) {
        return { id: response.results[0].id }
      }

      // If no match by email, try phone
      if (phone && !email) {
        const phoneResponse = await this.request<{ results: Array<{ id: string }> }>(
          '/crm/v3/objects/contacts/search',
          {
            method: 'POST',
            body: JSON.stringify({
              filterGroups: [{
                filters: [{
                  propertyName: 'phone',
                  operator: 'EQ',
                  value: phone,
                }]
              }],
              limit: 1,
            }),
          }
        )

        if (phoneResponse.results && phoneResponse.results.length > 0) {
          return { id: phoneResponse.results[0].id }
        }
      }

      return null
    } catch (error) {
      console.error('Error searching for contact:', error)
      return null
    }
  }

  /**
   * Create a new contact
   */
  async createContact(properties: Record<string, string | number | boolean>): Promise<{ id: string }> {
    return this.request<{ id: string }>('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    })
  }

  /**
   * Update an existing contact
   */
  async updateContact(
    contactId: string,
    properties: Record<string, string | number | boolean>
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/crm/v3/objects/contacts/${contactId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    })
  }

  /**
   * Create or update a contact (upsert)
   */
  async upsertContact(
    data: FormSubmissionData
  ): Promise<{ id: string; created: boolean }> {
    const properties = buildHubSpotProperties(data)

    // Try to find existing contact
    const existingContact = await this.findContact(data.emailAddress, data.phoneNumber)

    if (existingContact) {
      await this.updateContact(existingContact.id, properties)
      return { id: existingContact.id, created: false }
    } else {
      const newContact = await this.createContact(properties)
      return { id: newContact.id, created: true }
    }
  }

  /**
   * Create an Internal Sales deal (for Other Department -> IS)
   */
  async createInternalSalesDeal(
    contactId: string,
    notes: string
  ): Promise<{ id: string }> {
    // Create the deal
    const deal = await this.request<{ id: string }>('/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          dealname: `Internal Sales Lead - ${new Date().toLocaleDateString()}`,
          pipeline: 'default', // Adjust to your IS pipeline
          dealstage: 'appointmentscheduled', // Adjust to your deal stage
          description: notes,
        },
      }),
    })

    // Associate deal with contact
    await this.request(
      `/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`,
      { method: 'PUT' }
    )

    return deal
  }

  /**
   * Log a call engagement
   */
  async logCallEngagement(
    contactId: string,
    disposition: string,
    notes: string,
    timestamp: string
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>('/crm/v3/objects/calls', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date(timestamp).getTime(),
          hs_call_title: `Enquiry Call - ${disposition.replace(/_/g, ' ')}`,
          hs_call_body: notes,
          hs_call_disposition: disposition,
          hs_call_status: 'COMPLETED',
        },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
          },
        ],
      }),
    })
  }
}

/**
 * Process a form submission and sync to HubSpot
 */
export async function processFormSubmission(
  data: FormSubmissionData,
  accessToken: string
): Promise<{
  success: boolean
  contactId?: string
  dealId?: string
  callId?: string
  error?: string
}> {
  const client = new HubSpotClient(accessToken)

  try {
    // 1. Create or update contact
    const { id: contactId, created } = await client.upsertContact(data)
    console.log(`Contact ${created ? 'created' : 'updated'}: ${contactId}`)

    // 2. Log call engagement
    const call = await client.logCallEngagement(
      contactId,
      data.disposition,
      data.notes || '',
      data.timestamp
    )
    console.log(`Call logged: ${call.id}`)

    // 3. Handle special cases
    let dealId: string | undefined

    // Create Internal Sales deal if applicable
    if (data.disposition === 'other_department' &&
        data.otherDepartment === 'is' &&
        data.createIsDeal === 'yes') {
      const deal = await client.createInternalSalesDeal(
        contactId,
        data.notesForInternalSales || data.notes || ''
      )
      dealId = deal.id
      console.log(`Internal Sales deal created: ${dealId}`)
    }

    return {
      success: true,
      contactId,
      dealId,
      callId: call.id,
    }
  } catch (error) {
    console.error('Error processing form submission:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
