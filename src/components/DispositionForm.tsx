'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSupabase, PostcodeZone } from '@/lib/supabase'
import { convertMapViewerToEmbed, convertCalendarCidToEmbed } from '@/lib/url-utils'
import { fetchLeadData, LeadData, mapLeadPropertiesToFormData } from '@/lib/lead-api'
import LeadInfoAccordion from './LeadInfoAccordion'
import Toast from './Toast'

// Main disposition types
type DispositionType =
  | 'book_water_test'
  | 'not_interested'
  | 'other_department'
  | 'unable_to_service'
  | 'wrong_number'
  | null

// Sub-types for each disposition
type CallBackSubType = '6_months_new_build' | 'same_day' | '3_days_plus' | ''
type NotInterestedSubType = 'refuse_dl' | 'price' | 'time_constraints' | 'needs_partner_check' | 'product_unnecessary' | 'consultation_unnecessary' | 'customer_complaint' | ''
type OtherDepartmentType = 'is' | 'service' | 'filters' | 'installs' | 'hr' | 'accounts' | 'marketing' | 'it' | 'direct_sales' | ''
type UnableToServiceSubType = 'water_source' | 'non_homeowner' | 'incompatible_dwelling' | 'mistaken_enquiry' | ''
type NoAnswerSubType = 'voicemail' | 'no_answer' | ''
type WrongNumberSubType = 'wrong_person' | 'invalid_number' | ''

// List classification
type ListClassification = 'amberlist' | 'greylist' | 'blacklist' | ''

// Lead status for Book Water Test
type LeadStatus = 'SL' | 'DL' | ''

interface ContactInfo {
  contact_id: string
  name: string
  phone: string
  email: string
  agent_id?: string
}

interface FormData {
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
  leadStatus: LeadStatus
  dateOfBookingCall: string
  waterTestDay: string
  waterTestDate: string
  waterTestTime: string
  leadsRep: string
  availableFrom: string
  reschedule: 'yes' | 'no' | ''
  howDidYouFindUs: string[]  // Changed to array for multi-select checkboxes

  // Call Back fields
  callBackSubType: CallBackSubType
  followUpDate: string
  wantsFollowedUp: 'yes' | 'no' | ''

  // Not Interested fields
  notInterestedSubType: NotInterestedSubType
  listClassification: ListClassification
  advisedNotInterestedReason: string

  // Other Department (Transfer Call) fields
  otherDepartment: OtherDepartmentType
  createIsDeal: 'yes' | 'no' | ''
  notesForInternalSales: string

  // Unable to Service fields
  unableToServiceSubType: UnableToServiceSubType
  waterSource: string

  // No Answer fields
  noAnswerSubType: NoAnswerSubType

  // Wrong Number fields
  wrongNumberSubType: WrongNumberSubType

  // Common
  notes: string
}

const initialFormData: FormData = {
  disposition: null,
  postcode: '',

  // Book Water Test
  firstName: '',
  lastName: '',
  phoneNumber: '',
  streetAddress: '',
  city: '',
  stateRegion: '',
  postalCode: '',
  emailAddress: '',
  homeOwner: '',
  mainsWater: '',
  peopleInHouse: '',
  propertyType: '',
  partnerName: '',
  referred: '',
  referrersName: '',
  strata: '',
  waterConcerns: [],
  leadStatus: '',
  dateOfBookingCall: '',
  waterTestDay: '',
  waterTestDate: '',
  waterTestTime: '',
  leadsRep: '',
  availableFrom: '',
  reschedule: '',
  howDidYouFindUs: [],  // Changed to empty array

  // Call Back
  callBackSubType: '',
  followUpDate: '',
  wantsFollowedUp: '',

  // Not Interested
  notInterestedSubType: '',
  listClassification: '',
  advisedNotInterestedReason: '',

  // Other Department
  otherDepartment: '',
  createIsDeal: '',
  notesForInternalSales: '',

  // Unable to Service
  unableToServiceSubType: '',
  waterSource: '',

  // No Answer
  noAnswerSubType: '',

  // Wrong Number
  wrongNumberSubType: '',

  // Common
  notes: '',
}

// Option arrays
const PROPERTY_TYPES = [
  'House',
  'Apartment',
  'Villa',
  'Unit',
  'Duplex',
  'Townhouse',
  'New Build',
]

const WATER_CONCERNS = [
  'Bad taste and odour',
  'Babies and bottled feeding',
  'Specific health concerns, (i.e.- asthma, eczema, crohn\'s, thyroid)',
  'Anti-aging',
  'Dry skin and hair',
  'Expensive bottled water costs',
  'Plastics (Nano/Micro)',
  'Chemical concerns (i.e.- THM\'s, fluoride, PFAS)',
  'Limescale and hard water damage',
  'Other',
]

const PEOPLE_IN_HOUSE_OPTIONS = [
  'Just myself & my kid/s',
  '2 Adults with no kids',
  'Live with a partner & kids',
  'Single Adult Only',
  'Other',
]

const WATER_TEST_TIMES = [
  '8:00:00 AM',
  '8:15:00 AM',
  '8:30:00 AM',
  '8:45:00 AM',
  '9:00:00 AM',
  '9:15:00 AM',
  '9:30:00 AM',
  '9:45:00 AM',
  '10:00:00 AM',
  '10:15:00 AM',
  '10:30:00 AM',
  '10:45:00 AM',
  '11:00:00 AM',
  '11:15:00 AM',
  '11:30:00 AM',
  '11:45:00 AM',
  '12:00:00 PM',
  '12:15:00 PM',
  '12:30:00 PM',
  '12:45:00 PM',
  '1:00:00 PM',
  '1:15:00 PM',
  '1:30:00 PM',
  '1:45:00 PM',
  '2:00:00 PM',
  '2:15:00 PM',
  '2:30:00 PM',
  '2:45:00 PM',
  '3:00:00 PM',
  '3:15:00 PM',
  '3:30:00 PM',
  '3:45:00 PM',
  '4:00:00 PM',
  '4:15:00 PM',
  '4:30:00 PM',
  '4:45:00 PM',
  '5:00:00 PM',
  '5:15:00 PM',
  '5:30:00 PM',
  '5:45:00 PM',
  '6:00:00 PM',
  '6:15:00 PM',
  '6:30:00 PM',
  '6:45:00 PM',
  '7:00:00 PM',
  '7:15:00 PM',
  '7:30:00 PM',
  '7:45:00 PM',
  '8:00:00 PM',
  '8:30:00 PM',
]

const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const HOW_DID_YOU_FIND_US = [
  'TV',
  'Friends / Family',
  'Influencer',
  'Podcast',
  'Radio',
  'Magazine / Newspaper',
  'Online',
  'The Block',
  'Shopping Centre / Home Show',
  'Other',
]

const AUSTRALIAN_STATES = [
  'NSW',
  'VIC',
  'QLD',
  'WA',
  'SA',
  'TAS',
  'ACT',
  'NT',
]

const WATER_SOURCES = [
  'Tank Water Only',
  'Bore Water',
  'Dam Water',
  'River/Creek Water',
  'Other Non-Mains',
]

const AVAILABLE_FROM_TIMES = [
  '9:00am',
  '9:30am',
  '10:00am',
  '10:30am',
  '11:00am',
  '11:30am',
  '12:00pm',
  '12:30pm',
  '1:00pm',
  '1:30pm',
  '2:00pm',
  '2:30pm',
  '3:00pm',
  '3:30pm',
  '4:00pm',
  '4:30pm',
  '5:00pm',
  '5:30pm',
  '6:00pm',
  '6:30pm',
  '7:00pm',
  'Any time',
]

const LEADS_REP_TEAM = [
  'Aleks Matlijoska',
  'Andrew Le',
  'Ankit Dallakoti',
  'Bradley Clarke',
  'Brendon Sharp',
  'Carla Haynes',
  'Dianne Waters',
  'Emily McCracken',
  'Engel Batterham',
  'Joe Mercuri',
  'Joshua Webster',
  'Marika Somerville',
  'Nicole Stewart',
  'Nicole Turner',
  'Phoenix Harvey',
  'Prince Magombedze',
  'Rebecca Heath',
  'Shannon Watson',
  'Shanon Li Seah',
  'Sean McNally',
  'Lucy Thompson',
  'Jack Coley',
  'Charlotte Withrow',
  'Remon Rabie',
  'Ivana Kasvosve',
  'Libby Holroyd',
  'Lucy Hook',
  'Kay Zoabi',
  'Sasha James',
  'Bethany Kelly',
  'Lauren Palmer',
  'Jamie Bailey',
  'Palak Walia',
  'Ebony Daley',
  'Jordan Stanley',
  'Lloyd Durandar',
  'Archie Gidden',
  'Sorcha Devlin',
  'Heidy Garcia',
  'Megan Harvey',
  'Bryce Haley',
  'Reuben Roberts-Hunt',
  'Abi Bishop',
  'Sadie Wright',
  'Joshua Davies',
]

const ADVISED_NOT_INTERESTED_REASONS = [
  'Has a System Already',
  'Financial Reasons',
  'Scheduling Issues (don\'t want to go ahead)',
  'Partner not interested',
  'No longer needed',
  'Went with a Competitor',
  'Selling/Moving House',
  'Time Wasters',
  'Hung Up',
  'Not Specified',
  'Other',
]

const OTHER_DEPARTMENTS: { value: OtherDepartmentType; label: string }[] = [
  { value: 'is', label: 'Internal Sales' },
  { value: 'service', label: 'Service' },
  { value: 'filters', label: 'Filters' },
  { value: 'installs', label: 'Installs' },
  { value: 'hr', label: 'HR' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'it', label: 'IT' },
  { value: 'direct_sales', label: 'Direct Sales' },
]

export default function DispositionForm() {
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null)
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [postcodeZone, setPostcodeZone] = useState<PostcodeZone | null>(null)
  const [postcodeError, setPostcodeError] = useState<string | null>(null)
  const [isLoadingPostcode, setIsLoadingPostcode] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [showValidation, setShowValidation] = useState(false)

  // Lead data state
  const [leadData, setLeadData] = useState<LeadData | null>(null)
  const [isLoadingLead, setIsLoadingLead] = useState(false)
  const [leadError, setLeadError] = useState<string | null>(null)

  // Lookup postcode when 4 digits entered
  const lookupPostcode = useCallback(async (postcode: string) => {
    if (postcode.length !== 4) {
      setPostcodeZone(null)
      setPostcodeError(null)
      return
    }

    const supabase = getSupabase()
    if (!supabase) {
      setPostcodeError('Database not configured')
      return
    }

    setIsLoadingPostcode(true)
    setPostcodeError(null)

    try {
      const { data, error } = await supabase
        .from('postcode_zones')
        .select('*')
        .eq('postcode_prefix', postcode)
        .single()

      if (error || !data) {
        setPostcodeZone(null)
        setPostcodeError('Postcode not in service area')
      } else {
        setPostcodeZone(data)
        setPostcodeError(null)
      }
    } catch {
      setPostcodeError('Error looking up postcode')
      setPostcodeZone(null)
    } finally {
      setIsLoadingPostcode(false)
    }
  }, [])

  // Parse query params on mount and fetch lead data if contact_id present
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const contact_id = params.get('contact_id') || params.get('contactID')
    const name = params.get('name')
    const phone = params.get('phone')
    const email = params.get('email')
    const postcode = params.get('postcode')
    const agent_id = params.get('agent')

    if (contact_id || name || phone || email) {
      setContactInfo({
        contact_id: contact_id || '',
        name: name || '',
        phone: phone || '',
        email: email || '',
        agent_id: agent_id || undefined,
      })

      // Pre-populate form fields from URL contact info (will be overridden by HubSpot data if available)
      const nameParts = (name || '').split(' ')
      setFormData(prev => ({
        ...prev,
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        phoneNumber: phone || '',
        emailAddress: email || '',
      }))
    }

    // Pre-populate postcode if provided
    if (postcode && postcode.length === 4 && /^\d{4}$/.test(postcode)) {
      setFormData(prev => ({ ...prev, postcode, postalCode: postcode }))
      lookupPostcode(postcode)
    }

    // Fetch full lead data from HubSpot if contact_id is present
    if (contact_id) {
      setIsLoadingLead(true)
      setLeadError(null)
      fetchLeadData(contact_id)
        .then(response => {
          if (response.success && response.contact) {
            setLeadData(response.contact)
            // Pre-populate form fields from HubSpot data
            const mappedData = mapLeadPropertiesToFormData(response.contact.rawProperties)
            setFormData(prev => ({
              ...prev,
              ...mappedData,
              // Keep postcode from URL if HubSpot doesn't have it
              postcode: mappedData.postalCode || prev.postcode,
            }))
            // Lookup postcode zone if we got a postal code
            if (mappedData.postalCode && mappedData.postalCode.length === 4) {
              lookupPostcode(mappedData.postalCode)
            }
          } else {
            setLeadError(response.error || 'Failed to load lead data')
          }
        })
        .catch(err => {
          console.error('Error fetching lead data:', err)
          setLeadError('Failed to load lead data')
        })
        .finally(() => {
          setIsLoadingLead(false)
        })
    }
  }, [lookupPostcode])

  const handlePostcodeChange = (value: string) => {
    const numericValue = value.replace(/\D/g, '').slice(0, 4)
    setFormData(prev => ({ ...prev, postcode: numericValue, postalCode: numericValue }))

    if (numericValue.length === 4) {
      lookupPostcode(numericValue)
    } else {
      setPostcodeZone(null)
      setPostcodeError(null)
    }
  }

  const handleDispositionClick = (disposition: DispositionType) => {
    setFormData(prev => ({
      ...initialFormData,
      // Preserve all pre-populated contact and property data from HubSpot
      postcode: prev.postcode,
      postalCode: prev.postalCode,
      firstName: prev.firstName,
      lastName: prev.lastName,
      phoneNumber: prev.phoneNumber,
      emailAddress: prev.emailAddress,
      streetAddress: prev.streetAddress,
      city: prev.city,
      stateRegion: prev.stateRegion,
      homeOwner: prev.homeOwner,
      mainsWater: prev.mainsWater,
      peopleInHouse: prev.peopleInHouse,
      propertyType: prev.propertyType,
      partnerName: prev.partnerName,
      referred: prev.referred,
      referrersName: prev.referrersName,
      strata: prev.strata,
      waterConcerns: prev.waterConcerns,
      leadStatus: prev.leadStatus,
      leadsRep: prev.leadsRep,
      howDidYouFindUs: prev.howDidYouFindUs,
      dateOfBookingCall: prev.dateOfBookingCall,
      waterTestDay: prev.waterTestDay,
      waterTestDate: prev.waterTestDate,
      waterTestTime: prev.waterTestTime,
      followUpDate: prev.followUpDate,
      wantsFollowedUp: prev.wantsFollowedUp,
      disposition: prev.disposition === disposition ? null : disposition,
    }))
  }

  const handleWaterConcernsChange = (concern: string) => {
    setFormData(prev => ({
      ...prev,
      waterConcerns: prev.waterConcerns.includes(concern)
        ? prev.waterConcerns.filter(c => c !== concern)
        : [...prev.waterConcerns, concern],
    }))
  }

  const handleHowDidYouFindUsChange = (source: string) => {
    setFormData(prev => ({
      ...prev,
      howDidYouFindUs: prev.howDidYouFindUs.includes(source)
        ? prev.howDidYouFindUs.filter(s => s !== source)
        : [...prev.howDidYouFindUs, source],
    }))
  }

  const handleSubmit = async () => {
    if (isSubmitting) return

    // Check if form is valid before submitting
    if (!isFormValid()) {
      setShowValidation(true)
      setToast({ message: 'Please fill in all required fields', type: 'error' })
      return
    }

    setIsSubmitting(true)
    setShowValidation(false)

    const payload = {
      ...formData,
      contactInfo,
      timestamp: new Date().toISOString(),
    }

    console.log('Form Submission Payload:', payload)

    // Get Supabase URL from environment
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey) {
      setToast({ message: 'Supabase not configured', type: 'error' })
      setIsSubmitting(false)
      return
    }

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/hubspot-form-submission`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify(payload),
      })

      const result = await response.json()

      if (result.success) {
        setToast({ message: 'Form submitted successfully to HubSpot!', type: 'success' })
        setShowValidation(false)
        // Reset form after successful submission
        setFormData(prev => ({
          ...initialFormData,
          postcode: prev.postcode,
          postalCode: prev.postalCode,
        }))
      } else {
        console.error('Submission error:', result.error)
        setToast({ message: `Submission failed: ${result.error}`, type: 'error' })
      }
    } catch (error) {
      console.error('Network error:', error)
      setToast({ message: 'Network error. Please try again.', type: 'error' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const isFormValid = () => {
    if (!formData.disposition) return false

    switch (formData.disposition) {
      case 'book_water_test':
        return (
          formData.firstName &&
          formData.lastName &&
          formData.phoneNumber &&
          formData.streetAddress &&
          formData.city &&
          formData.stateRegion &&
          formData.postalCode &&
          formData.homeOwner &&
          formData.mainsWater &&
          formData.peopleInHouse &&
          formData.propertyType &&
          formData.leadStatus &&
          formData.waterTestDate &&
          formData.waterTestTime
        )
      case 'not_interested':
        return formData.notInterestedSubType && formData.listClassification && formData.advisedNotInterestedReason
      case 'other_department':
        return formData.otherDepartment !== ''
      case 'unable_to_service':
        return formData.unableToServiceSubType && formData.listClassification
      case 'wrong_number':
        return formData.wrongNumberSubType !== ''
      default:
        return false
    }
  }

  const updateField = <K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  // Helper function to check if a field is invalid
  const isFieldInvalid = (fieldValue: any) => {
    return showValidation && !fieldValue
  }

  // Common select component styling
  const selectClass = "w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white"
  const inputClass = "w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
  const labelClass = "block text-sm font-medium text-gray-700 mb-1"

  // Styling for invalid fields
  const getFieldClass = (baseClass: string, fieldValue: any) => {
    if (isFieldInvalid(fieldValue)) {
      return `${baseClass} border-red-500 focus:ring-red-500 focus:border-red-500`
    }
    return baseClass
  }

  const getErrorLabelClass = (fieldValue: any) => {
    if (isFieldInvalid(fieldValue)) {
      return `${labelClass} text-red-600`
    }
    return labelClass
  }

  // Check if we have a contact with lead data to show sidebar
  const showSidebar = contactInfo?.contact_id

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Quick Contact Info Banner - Full Width */}
      {contactInfo && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2">
          <div className="max-w-[1800px] mx-auto flex flex-wrap items-center gap-4 text-sm">
            {contactInfo.name && (
              <span className="font-medium text-blue-900">{contactInfo.name}</span>
            )}
            {contactInfo.phone && (
              <span className="text-blue-700">
                <svg className="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                {contactInfo.phone}
              </span>
            )}
            {contactInfo.email && (
              <span className="text-blue-700">
                <svg className="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {contactInfo.email}
              </span>
            )}
            <div className="flex items-center gap-2">
              {contactInfo.contact_id && (
                <span className="text-blue-600 text-xs bg-blue-100 px-2 py-0.5 rounded">
                  ID: {contactInfo.contact_id}
                </span>
              )}
              {contactInfo.agent_id && (
                <span className="text-green-600 text-xs bg-green-100 px-2 py-0.5 rounded">
                  Agent: {contactInfo.agent_id}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Layout - Sidebar + Content */}
      <div className={`flex flex-col lg:flex-row ${showSidebar ? 'max-w-[1800px]' : 'max-w-4xl'} mx-auto`}>
        {/* Left Sidebar - Lead Information */}
        {showSidebar && (
          <aside className="lg:w-80 xl:w-96 flex-shrink-0 p-4 lg:h-[calc(100vh-48px)] lg:sticky lg:top-0">
            <div className="h-full">
              <LeadInfoAccordion
                leadData={leadData}
                isLoading={isLoadingLead}
                error={leadError}
                compact={true}
                defaultExpandedSections={['contact', 'property', 'waterAssessment']}
              />
            </div>
          </aside>
        )}

        {/* Right Main Content - Form */}
        <main className={`flex-1 p-4 md:p-6 space-y-4 ${showSidebar ? 'lg:border-l lg:border-gray-200' : ''}`}>
          {/* Disposition Buttons */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Call Disposition
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleDispositionClick('book_water_test')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  formData.disposition === 'book_water_test'
                    ? 'bg-green-600 text-white ring-2 ring-green-600 ring-offset-2'
                    : 'bg-green-500 text-white hover:bg-green-600'
                }`}
              >
                Book Water Test
              </button>

              <button
                onClick={() => handleDispositionClick('not_interested')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  formData.disposition === 'not_interested'
                    ? 'bg-orange-600 text-white ring-2 ring-orange-600 ring-offset-2'
                    : 'bg-orange-500 text-white hover:bg-orange-600'
                }`}
              >
                Not Interested
              </button>

              <button
                onClick={() => handleDispositionClick('other_department')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  formData.disposition === 'other_department'
                    ? 'bg-blue-700 text-white ring-2 ring-blue-700 ring-offset-2'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                Other Department
              </button>

              <button
                onClick={() => handleDispositionClick('unable_to_service')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  formData.disposition === 'unable_to_service'
                    ? 'bg-gray-700 text-white ring-2 ring-gray-700 ring-offset-2'
                    : 'bg-gray-600 text-white hover:bg-gray-700'
                }`}
              >
                Unable to Service
              </button>

              <button
                onClick={() => handleDispositionClick('wrong_number')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  formData.disposition === 'wrong_number'
                    ? 'bg-red-700 text-white ring-2 ring-red-700 ring-offset-2'
                    : 'bg-red-600 text-white hover:bg-red-700'
                }`}
              >
                Wrong Number
              </button>
            </div>
          </div>

          {/* Conditional Disposition Fields - Directly under buttons */}
          {formData.disposition && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-6">

              {/* ============================================ */}
              {/* BOOK WATER TEST FIELDS */}
              {/* ============================================ */}
              {formData.disposition === 'book_water_test' && (
                <>
                  <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                    Book Water Test
                  </h3>

                  {/* Contact Details Section */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Contact Details
                    </h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className={getErrorLabelClass(formData.firstName)}>First Name *</label>
                        <input
                          type="text"
                          value={formData.firstName}
                          onChange={(e) => updateField('firstName', e.target.value)}
                          className={getFieldClass(inputClass, formData.firstName)}
                        />
                        {isFieldInvalid(formData.firstName) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={getErrorLabelClass(formData.lastName)}>Last Name *</label>
                        <input
                          type="text"
                          value={formData.lastName}
                          onChange={(e) => updateField('lastName', e.target.value)}
                          className={getFieldClass(inputClass, formData.lastName)}
                        />
                        {isFieldInvalid(formData.lastName) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={getErrorLabelClass(formData.phoneNumber)}>Phone Number *</label>
                        <input
                          type="tel"
                          value={formData.phoneNumber}
                          onChange={(e) => updateField('phoneNumber', e.target.value)}
                          className={getFieldClass(inputClass, formData.phoneNumber)}
                        />
                        {isFieldInvalid(formData.phoneNumber) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={labelClass}>Email</label>
                        <input
                          type="email"
                          value={formData.emailAddress}
                          onChange={(e) => updateField('emailAddress', e.target.value)}
                          className={inputClass}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Address Section */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Address
                    </h4>
                    <div className="grid gap-4">
                      <div>
                        <label className={getErrorLabelClass(formData.streetAddress)}>Street Address *</label>
                        <input
                          type="text"
                          value={formData.streetAddress}
                          onChange={(e) => updateField('streetAddress', e.target.value)}
                          className={getFieldClass(inputClass, formData.streetAddress)}
                        />
                        {isFieldInvalid(formData.streetAddress) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div className="grid md:grid-cols-3 gap-4">
                        <div>
                          <label className={getErrorLabelClass(formData.city)}>City *</label>
                          <input
                            type="text"
                            value={formData.city}
                            onChange={(e) => updateField('city', e.target.value)}
                            className={getFieldClass(inputClass, formData.city)}
                          />
                          {isFieldInvalid(formData.city) && (
                            <p className="text-red-600 text-sm mt-1">Required</p>
                          )}
                        </div>
                        <div>
                          <label className={getErrorLabelClass(formData.stateRegion)}>State/Region *</label>
                          <select
                            value={formData.stateRegion}
                            onChange={(e) => updateField('stateRegion', e.target.value)}
                            className={getFieldClass(selectClass, formData.stateRegion)}
                          >
                            <option value="">Select state</option>
                            {AUSTRALIAN_STATES.map(state => (
                              <option key={state} value={state}>{state}</option>
                            ))}
                          </select>
                          {isFieldInvalid(formData.stateRegion) && (
                            <p className="text-red-600 text-sm mt-1">Required</p>
                          )}
                        </div>
                        <div>
                          <label className={getErrorLabelClass(formData.postalCode)}>Postal Code *</label>
                          <input
                            type="text"
                            value={formData.postalCode}
                            onChange={(e) => updateField('postalCode', e.target.value.replace(/\D/g, '').slice(0, 4))}
                            className={getFieldClass(inputClass, formData.postalCode)}
                          />
                          {isFieldInvalid(formData.postalCode) && (
                            <p className="text-red-600 text-sm mt-1">Required</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Fact Finding Section */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Fact Finding
                    </h4>

                    {/* Water Concerns - MOVED UP from later position */}
                    <div className="mb-4">
                      <label className={labelClass}>Customer&apos;s water concerns</label>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2">
                        {WATER_CONCERNS.map(concern => (
                          <label key={concern} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={formData.waterConcerns.includes(concern)}
                              onChange={() => handleWaterConcernsChange(concern)}
                              className="rounded text-blue-600"
                            />
                            <span className="text-sm text-gray-900">{concern}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className={getErrorLabelClass(formData.mainsWater)}>Mains Water *</label>
                        <div className={`flex gap-4 ${isFieldInvalid(formData.mainsWater) ? 'p-2 border-2 border-red-500 rounded-lg' : ''}`}>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="mainsWater"
                              value="yes"
                              checked={formData.mainsWater === 'yes'}
                              onChange={() => updateField('mainsWater', 'yes')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">Yes</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="mainsWater"
                              value="no"
                              checked={formData.mainsWater === 'no'}
                              onChange={() => updateField('mainsWater', 'no')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">No</span>
                          </label>
                        </div>
                        {isFieldInvalid(formData.mainsWater) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={getErrorLabelClass(formData.peopleInHouse)}>How many people in the house? *</label>
                        <select
                          value={formData.peopleInHouse}
                          onChange={(e) => updateField('peopleInHouse', e.target.value)}
                          className={getFieldClass(selectClass, formData.peopleInHouse)}
                        >
                          <option value="">Select</option>
                          {PEOPLE_IN_HOUSE_OPTIONS.map(num => (
                            <option key={num} value={num}>{num}</option>
                          ))}
                        </select>
                        {isFieldInvalid(formData.peopleInHouse) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={getErrorLabelClass(formData.propertyType)}>Type of Property *</label>
                        <select
                          value={formData.propertyType}
                          onChange={(e) => updateField('propertyType', e.target.value)}
                          className={getFieldClass(selectClass, formData.propertyType)}
                        >
                          <option value="">Select property type</option>
                          {PROPERTY_TYPES.map(type => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                        {isFieldInvalid(formData.propertyType) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                      <div>
                        <label className={labelClass}>Strata</label>
                        <div className="flex gap-4">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="strata"
                              value="yes"
                              checked={formData.strata === 'yes'}
                              onChange={() => updateField('strata', 'yes')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">Yes</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="strata"
                              value="no"
                              checked={formData.strata === 'no'}
                              onChange={() => updateField('strata', 'no')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">No</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <label className={getErrorLabelClass(formData.homeOwner)}>Home Owner *</label>
                        <div className={`flex gap-4 ${isFieldInvalid(formData.homeOwner) ? 'p-2 border-2 border-red-500 rounded-lg' : ''}`}>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="homeOwner"
                              value="yes"
                              checked={formData.homeOwner === 'yes'}
                              onChange={() => updateField('homeOwner', 'yes')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">Yes</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="homeOwner"
                              value="no"
                              checked={formData.homeOwner === 'no'}
                              onChange={() => updateField('homeOwner', 'no')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">No</span>
                          </label>
                        </div>
                        {isFieldInvalid(formData.homeOwner) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Booking Information Section - MERGED FROM APPOINTMENT DETAILS */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Booking Information
                    </h4>

                    <div className="grid md:grid-cols-2 gap-4">
                      {/* Lead Status - MOVED FROM TOP */}
                      <div>
                        <label className={getErrorLabelClass(formData.leadStatus)}>Lead Status *</label>
                        <div className={`flex gap-4 ${isFieldInvalid(formData.leadStatus) ? 'p-2 border-2 border-red-500 rounded-lg' : ''}`}>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="leadStatus"
                              value="SL"
                              checked={formData.leadStatus === 'SL'}
                              onChange={() => updateField('leadStatus', 'SL')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">SL (Single Leg)</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="leadStatus"
                              value="DL"
                              checked={formData.leadStatus === 'DL'}
                              onChange={() => updateField('leadStatus', 'DL')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">DL (Double Leg)</span>
                          </label>
                        </div>
                        {isFieldInvalid(formData.leadStatus) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>

                      {/* NEW FIELD: Date of booking call */}
                      <div>
                        <label className={labelClass}>Date of booking call</label>
                        <input
                          type="date"
                          value={formData.dateOfBookingCall}
                          onChange={(e) => updateField('dateOfBookingCall', e.target.value)}
                          className={inputClass}
                          placeholder="Today"
                        />
                      </div>

                      {/* NEW FIELD: Reschedule checkbox */}
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="reschedule"
                          checked={formData.reschedule === 'yes'}
                          onChange={(e) => updateField('reschedule', e.target.checked ? 'yes' : 'no')}
                          className="rounded text-blue-600"
                        />
                        <label htmlFor="reschedule" className="text-sm text-gray-700">
                          Reschedule
                        </label>
                      </div>

                      {/* NEW FIELD: Water Test Day */}
                      <div>
                        <label className={labelClass}>Water Test Day</label>
                        <select
                          value={formData.waterTestDay}
                          onChange={(e) => updateField('waterTestDay', e.target.value)}
                          className={selectClass}
                        >
                          <option value="">Select day</option>
                          {DAYS_OF_WEEK.map(day => (
                            <option key={day} value={day}>{day}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className={getErrorLabelClass(formData.waterTestDate)}>Water Test Date *</label>
                        <input
                          type="date"
                          value={formData.waterTestDate}
                          onChange={(e) => updateField('waterTestDate', e.target.value)}
                          className={getFieldClass(inputClass, formData.waterTestDate)}
                        />
                        {isFieldInvalid(formData.waterTestDate) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>

                      <div>
                        <label className={getErrorLabelClass(formData.waterTestTime)}>Water Test Time *</label>
                        <select
                          value={formData.waterTestTime}
                          onChange={(e) => updateField('waterTestTime', e.target.value)}
                          className={getFieldClass(selectClass, formData.waterTestTime)}
                        >
                          <option value="">Select time</option>
                          {WATER_TEST_TIMES.map(time => (
                            <option key={time} value={time}>{time}</option>
                          ))}
                        </select>
                        {isFieldInvalid(formData.waterTestTime) && (
                          <p className="text-red-600 text-sm mt-1">This field is required</p>
                        )}
                      </div>

                      {/* Partner Name - MOVED FROM PROPERTY INFO */}
                      <div>
                        <label className={labelClass}>Partner&apos;s Name</label>
                        <input
                          type="text"
                          value={formData.partnerName}
                          onChange={(e) => updateField('partnerName', e.target.value)}
                          className={inputClass}
                        />
                      </div>

                      {/* NEW FIELD: Available From */}
                      <div>
                        <label className={labelClass}>Available From</label>
                        <select
                          value={formData.availableFrom}
                          onChange={(e) => updateField('availableFrom', e.target.value)}
                          className={selectClass}
                        >
                          <option value="">Select time</option>
                          {AVAILABLE_FROM_TIMES.map(time => (
                            <option key={time} value={time}>{time}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Referral Section */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Referral
                    </h4>

                    {/* CONVERTED: How did you find us - Multi-select checkboxes */}
                    <div className="mb-4">
                      <label className={labelClass}>How did you hear about us?</label>
                      <p className="text-xs text-gray-500 mb-2">Check all relevant</p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2">
                        {HOW_DID_YOU_FIND_US.map(source => (
                          <label key={source} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={formData.howDidYouFindUs.includes(source)}
                              onChange={() => handleHowDidYouFindUsChange(source)}
                              className="rounded text-blue-600"
                            />
                            <span className="text-sm text-gray-900">{source}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>Has this person been referred?</label>
                        <div className="flex gap-4">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="referred"
                              value="yes"
                              checked={formData.referred === 'yes'}
                              onChange={() => updateField('referred', 'yes')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">Yes</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="referred"
                              value="no"
                              checked={formData.referred === 'no'}
                              onChange={() => updateField('referred', 'no')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">No</span>
                          </label>
                        </div>
                      </div>
                      {formData.referred === 'yes' && (
                        <div>
                          <label className={labelClass}>Who referred them?</label>
                          <input
                            type="text"
                            value={formData.referrersName}
                            onChange={(e) => updateField('referrersName', e.target.value)}
                            className={inputClass}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Notes Section */}
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Notes
                    </h4>
                    <div className="space-y-4">
                      <div>
                        <label className={labelClass}>Summarise Call</label>
                        <textarea
                          value={formData.notes}
                          onChange={(e) => updateField('notes', e.target.value)}
                          rows={3}
                          placeholder="Additional notes..."
                          className={`${inputClass} resize-none`}
                        />
                      </div>

                      {/* NEW FIELD: Leads Rep */}
                      <div>
                        <label className={labelClass}>Leads Rep</label>
                        <select
                          value={formData.leadsRep}
                          onChange={(e) => updateField('leadsRep', e.target.value)}
                          className={selectClass}
                        >
                          <option value="">Please Select</option>
                          {LEADS_REP_TEAM.map(rep => (
                            <option key={rep} value={rep}>{rep}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Submit Button */}
                  <div className="pt-4">
                    <button
                      onClick={handleSubmit}
                      disabled={!isFormValid() || isSubmitting}
                      className={`w-full py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                        isFormValid() && !isSubmitting
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? (
                        <>
                          <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Submitting to HubSpot...
                        </>
                      ) : (
                        'Submit Disposition'
                      )}
                    </button>
                  </div>
                </>
              )}

              {/* ============================================ */}
              {/* NOT INTERESTED FIELDS */}
              {/* ============================================ */}
              {formData.disposition === 'not_interested' && (
                <>
                  <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                    Not Interested Details
                  </h3>

                  <div>
                    <label className={labelClass}>Reason Type *</label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                      {[
                        { value: 'refuse_dl', label: 'Refuse DL' },
                        { value: 'price', label: 'Price' },
                        { value: 'time_constraints', label: 'Time Constraints' },
                        { value: 'needs_partner_check', label: 'Needs to Check with Partner' },
                        { value: 'product_unnecessary', label: 'Product Unnecessary' },
                        { value: 'consultation_unnecessary', label: 'Consultation Unnecessary' },
                        { value: 'customer_complaint', label: 'Customer Complaint' },
                      ].map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateField('notInterestedSubType', value as NotInterestedSubType)}
                          className={`p-2 border rounded-lg text-sm transition-all ${
                            formData.notInterestedSubType === value
                              ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-500'
                              : 'border-gray-300 hover:border-orange-400'
                          }`}
                        >
                          <span className="text-gray-900">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className={labelClass}>List Classification *</label>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'amberlist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'amberlist'
                            ? 'border-amber-500 bg-amber-50 ring-2 ring-amber-500'
                            : 'border-gray-300 hover:border-amber-400'
                        }`}
                      >
                        <span className="font-medium text-amber-700">Amberlist</span>
                        <p className="text-xs text-gray-500 mt-1">Not Ready Now - Call back in 3 months</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'greylist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'greylist'
                            ? 'border-gray-500 bg-gray-100 ring-2 ring-gray-500'
                            : 'border-gray-300 hover:border-gray-400'
                        }`}
                      >
                        <span className="font-medium text-gray-700">Greylist</span>
                        <p className="text-xs text-gray-500 mt-1">Advised Not Interested - Marketing only</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'blacklist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'blacklist'
                            ? 'border-gray-900 bg-gray-200 ring-2 ring-gray-900'
                            : 'border-gray-300 hover:border-gray-600'
                        }`}
                      >
                        <span className="font-medium text-gray-900">Blacklist</span>
                        <p className="text-xs text-gray-500 mt-1">Do Not Contact - Remove from all comms</p>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className={labelClass}>Advised Not Interested - Specify Reason *</label>
                    <select
                      value={formData.advisedNotInterestedReason}
                      onChange={(e) => updateField('advisedNotInterestedReason', e.target.value)}
                      className={selectClass}
                    >
                      <option value="">Select reason</option>
                      {ADVISED_NOT_INTERESTED_REASONS.map(reason => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                    </select>
                  </div>

                  {formData.listClassification && (
                    <p className="text-sm bg-gray-50 p-3 rounded-lg">
                      <strong>HubSpot Action: </strong>
                      {formData.listClassification === 'amberlist' && 'Automation will call customer back in 3 months'}
                      {formData.listClassification === 'greylist' && 'Customer remains on database for marketing only'}
                      {formData.listClassification === 'blacklist' && 'Customer removed from all forms of communication'}
                    </p>
                  )}

                  {/* Notes */}
                  <div className="border-t border-gray-200 pt-4">
                    <label className={labelClass}>Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => updateField('notes', e.target.value)}
                      rows={3}
                      placeholder="Additional notes..."
                      className={`${inputClass} resize-none`}
                    />
                  </div>

                  {/* Submit */}
                  <div className="pt-4">
                    <button
                      onClick={handleSubmit}
                      disabled={!isFormValid() || isSubmitting}
                      className={`w-full py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                        isFormValid() && !isSubmitting
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? 'Submitting...' : 'Submit Disposition'}
                    </button>
                  </div>
                </>
              )}

              {/* ============================================ */}
              {/* OTHER DEPARTMENT FIELDS */}
              {/* ============================================ */}
              {formData.disposition === 'other_department' && (
                <>
                  <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                    Other Department (Transfer Call)
                  </h3>

                  <div>
                    <label className={labelClass}>Department *</label>
                    <select
                      value={formData.otherDepartment}
                      onChange={(e) => updateField('otherDepartment', e.target.value as OtherDepartmentType)}
                      className={selectClass}
                    >
                      <option value="">Select department</option>
                      {OTHER_DEPARTMENTS.map(({ value, label }) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>

                  {formData.otherDepartment === 'is' && (
                    <>
                      <div>
                        <label className={labelClass}>Create Internal Sales Deal</label>
                        <div className="flex gap-4 mt-2">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="createIsDeal"
                              value="yes"
                              checked={formData.createIsDeal === 'yes'}
                              onChange={() => updateField('createIsDeal', 'yes')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">Yes</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="createIsDeal"
                              value="no"
                              checked={formData.createIsDeal === 'no'}
                              onChange={() => updateField('createIsDeal', 'no')}
                              className="text-blue-600"
                            />
                            <span className="text-gray-900">No</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>Notes for Internal Sales</label>
                        <textarea
                          value={formData.notesForInternalSales}
                          onChange={(e) => updateField('notesForInternalSales', e.target.value)}
                          rows={3}
                          placeholder="Enter notes for Internal Sales team..."
                          className={`${inputClass} resize-none`}
                        />
                      </div>
                      <p className="text-sm text-gray-500 bg-blue-50 p-3 rounded-lg">
                        <strong>HubSpot Action:</strong> Automation will create an Internal Sales deal.
                      </p>
                    </>
                  )}

                  {formData.otherDepartment && formData.otherDepartment !== 'is' && (
                    <p className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg">
                      Transfer call to {OTHER_DEPARTMENTS.find(d => d.value === formData.otherDepartment)?.label} department.
                    </p>
                  )}

                  {/* Notes */}
                  <div className="border-t border-gray-200 pt-4">
                    <label className={labelClass}>Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => updateField('notes', e.target.value)}
                      rows={3}
                      placeholder="Additional notes..."
                      className={`${inputClass} resize-none`}
                    />
                  </div>

                  {/* Submit */}
                  <div className="pt-4">
                    <button
                      onClick={handleSubmit}
                      disabled={!isFormValid() || isSubmitting}
                      className={`w-full py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                        isFormValid() && !isSubmitting
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? 'Submitting...' : 'Submit Disposition'}
                    </button>
                  </div>
                </>
              )}

              {/* ============================================ */}
              {/* UNABLE TO SERVICE FIELDS */}
              {/* ============================================ */}
              {formData.disposition === 'unable_to_service' && (
                <>
                  <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                    Unable to Service Details
                  </h3>

                  <div>
                    <label className={labelClass}>Reason *</label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                      {[
                        { value: 'water_source', label: 'Water Source', desc: 'Non-mains water' },
                        { value: 'non_homeowner', label: 'Non Homeowner', desc: 'Renting/leasing' },
                        { value: 'incompatible_dwelling', label: 'Incompatible Dwelling', desc: 'Property type issue' },
                        { value: 'mistaken_enquiry', label: 'Mistaken Enquiry', desc: 'Wrong company/service' },
                      ].map(({ value, label, desc }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateField('unableToServiceSubType', value as UnableToServiceSubType)}
                          className={`p-3 border rounded-lg text-left transition-all ${
                            formData.unableToServiceSubType === value
                              ? 'border-gray-700 bg-gray-100 ring-2 ring-gray-700'
                              : 'border-gray-300 hover:border-gray-500'
                          }`}
                        >
                          <span className="font-medium text-gray-900">{label}</span>
                          <p className="text-xs text-gray-500 mt-1">{desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {formData.unableToServiceSubType === 'water_source' && (
                    <div>
                      <label className={labelClass}>Water Source Type</label>
                      <select
                        value={formData.waterSource}
                        onChange={(e) => updateField('waterSource', e.target.value)}
                        className={selectClass}
                      >
                        <option value="">Select water source</option>
                        {WATER_SOURCES.map(source => (
                          <option key={source} value={source}>{source}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className={labelClass}>List Classification *</label>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'amberlist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'amberlist'
                            ? 'border-amber-500 bg-amber-50 ring-2 ring-amber-500'
                            : 'border-gray-300 hover:border-amber-400'
                        }`}
                      >
                        <span className="font-medium text-amber-700">Amberlist</span>
                        <p className="text-xs text-gray-500 mt-1">Not Ready Now</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'greylist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'greylist'
                            ? 'border-gray-500 bg-gray-100 ring-2 ring-gray-500'
                            : 'border-gray-300 hover:border-gray-400'
                        }`}
                      >
                        <span className="font-medium text-gray-700">Greylist</span>
                        <p className="text-xs text-gray-500 mt-1">Advised Not Interested</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateField('listClassification', 'blacklist')}
                        className={`p-3 border rounded-lg text-left transition-all ${
                          formData.listClassification === 'blacklist'
                            ? 'border-gray-900 bg-gray-200 ring-2 ring-gray-900'
                            : 'border-gray-300 hover:border-gray-600'
                        }`}
                      >
                        <span className="font-medium text-gray-900">Blacklist</span>
                        <p className="text-xs text-gray-500 mt-1">Do Not Contact</p>
                      </button>
                    </div>
                  </div>

                  <p className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg">
                    <strong>Contact Owner:</strong> CHF Promotions
                  </p>

                  {/* Notes */}
                  <div className="border-t border-gray-200 pt-4">
                    <label className={labelClass}>Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => updateField('notes', e.target.value)}
                      rows={3}
                      placeholder="Additional notes..."
                      className={`${inputClass} resize-none`}
                    />
                  </div>

                  {/* Submit */}
                  <div className="pt-4">
                    <button
                      onClick={handleSubmit}
                      disabled={!isFormValid() || isSubmitting}
                      className={`w-full py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                        isFormValid() && !isSubmitting
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? 'Submitting...' : 'Submit Disposition'}
                    </button>
                  </div>
                </>
              )}

              {/* ============================================ */}
              {/* WRONG NUMBER FIELDS */}
              {/* ============================================ */}
              {formData.disposition === 'wrong_number' && (
                <>
                  <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                    Wrong Number Details
                  </h3>

                  <div>
                    <label className={labelClass}>Type *</label>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => updateField('wrongNumberSubType', 'wrong_person')}
                        className={`p-4 border rounded-lg text-left transition-all ${
                          formData.wrongNumberSubType === 'wrong_person'
                            ? 'border-red-600 bg-red-50 ring-2 ring-red-600'
                            : 'border-gray-300 hover:border-red-400'
                        }`}
                      >
                        <span className="font-medium text-gray-900">Wrong Person</span>
                        <p className="text-xs text-gray-500 mt-1">Number belongs to different person</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateField('wrongNumberSubType', 'invalid_number')}
                        className={`p-4 border rounded-lg text-left transition-all ${
                          formData.wrongNumberSubType === 'invalid_number'
                            ? 'border-red-600 bg-red-50 ring-2 ring-red-600'
                            : 'border-gray-300 hover:border-red-400'
                        }`}
                      >
                        <span className="font-medium text-gray-900">Invalid Number</span>
                        <p className="text-xs text-gray-500 mt-1">Number does not exist or disconnected</p>
                      </button>
                    </div>
                  </div>

                  <p className="text-sm text-gray-500 bg-red-50 p-3 rounded-lg">
                    <strong>Outcome:</strong> Unreachable<br />
                    <strong>HubSpot Action:</strong> Automation will email the customer to ask for correct number.<br />
                    <strong>Contact Owner:</strong> CHF Promotions<br />
                    <strong>List Status:</strong> Greylist - No response to email
                  </p>

                  {/* Notes */}
                  <div className="border-t border-gray-200 pt-4">
                    <label className={labelClass}>Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => updateField('notes', e.target.value)}
                      rows={3}
                      placeholder="Additional notes..."
                      className={`${inputClass} resize-none`}
                    />
                  </div>

                  {/* Submit */}
                  <div className="pt-4">
                    <button
                      onClick={handleSubmit}
                      disabled={!isFormValid() || isSubmitting}
                      className={`w-full py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                        isFormValid() && !isSubmitting
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? 'Submitting...' : 'Submit Disposition'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Postcode Lookup */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Postcode
            </label>
            <input
              type="text"
              value={formData.postcode}
              onChange={(e) => handlePostcodeChange(e.target.value)}
              placeholder="Enter 4-digit postcode"
              className="w-full md:w-48 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
            />

            {isLoadingPostcode && (
              <p className="mt-2 text-sm text-gray-500">Looking up postcode...</p>
            )}

            {postcodeError && (
              <p className="mt-2 text-sm text-red-600 font-medium">{postcodeError}</p>
            )}
          </div>

          {/* Map & Calendar Embeds */}
          {postcodeZone && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-medium text-gray-900 text-sm">Service Area Map</h3>
                  <a
                    href={postcodeZone.map_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                  >
                    Open
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <iframe
                  src={convertMapViewerToEmbed(postcodeZone.map_url)}
                  width="100%"
                  height="250"
                  style={{ border: 0 }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>

              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-medium text-gray-900 text-sm">Available Appointments</h3>
                  <a
                    href={postcodeZone.calendar_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                  >
                    Open
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <iframe
                  src={convertCalendarCidToEmbed(postcodeZone.calendar_url)}
                  width="100%"
                  height="250"
                  style={{ border: 0 }}
                  frameBorder="0"
                  scrolling="no"
                />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Toast Notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
