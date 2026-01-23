'use client'

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { getSupabase, PostcodeZone } from '@/lib/supabase'
import { convertCalendarCidToEmbed } from '@/lib/url-utils'
import Toast from './Toast'
import CalendarHeatMap from './CalendarHeatMap'
import DaySlots from './DaySlots'
import { DayData, TimeSlot } from '@/lib/calendar-api'

// Dynamic import for MapLibre to avoid SSR issues
const ServiceAreaMap = dynamic(() => import('./ServiceAreaMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-gray-100">
      <div className="hs-spinner" />
    </div>
  )
})

type DispositionType = 'book_water_test' | 'call_back' | 'not_interested' | 'cross_department' | 'not_compatible' | null

interface ContactInfo {
  contact_id: string
  name: string
  phone: string
  email: string
  agent: string
}

interface FormData {
  disposition: DispositionType
  postcode: string
  // Book Water Test fields
  appointmentDate: string
  timeSlot: 'AM' | 'PM' | ''
  address: string
  // Call Back fields
  callbackDate: string
  callbackTime: string
  // Not Interested fields
  notInterestedReason: string
  // Cross Department fields
  department: string
  // Not Compatible fields
  notCompatibleReason: string
  // Common
  notes: string
}

const initialFormData: FormData = {
  disposition: null,
  postcode: '',
  appointmentDate: '',
  timeSlot: '',
  address: '',
  callbackDate: '',
  callbackTime: '',
  notInterestedReason: '',
  department: '',
  notCompatibleReason: '',
  notes: '',
}

const NOT_INTERESTED_REASONS = [
  'Already has a filtration system',
  'Renting - landlord decision',
  'Moving soon',
  'Financial reasons',
  'Not interested in water quality',
  'Bad timing',
  'Other',
]

const NOT_COMPATIBLE_REASONS = [
  'Tank water only',
  'Apartment - no access',
  'Commercial property',
  'Water supply incompatible',
  'Plumbing issues',
  'Other',
]

const DEPARTMENTS = [
  'Sales',
  'Service',
  'Billing',
  'Technical Support',
  'Complaints',
  'Other',
]

const DISPOSITION_TABS: { key: DispositionType; label: string; color: string }[] = [
  { key: 'book_water_test', label: 'Book Water Test', color: 'var(--hs-color-success)' },
  { key: 'call_back', label: 'Call Back', color: 'var(--hs-color-warning)' },
  { key: 'not_interested', label: 'Not Int', color: 'var(--hs-color-primary)' },
  { key: 'cross_department', label: 'Other Dept', color: 'var(--hs-color-secondary)' },
  { key: 'not_compatible', label: 'Incompat', color: 'var(--hs-gray-700)' },
]

// Australian postcode geocoding (approximate centroids)
const POSTCODE_COORDS: Record<string, [number, number]> = {
  // NSW
  '2000': [151.2093, -33.8688], // Sydney CBD
  '2010': [151.2150, -33.8800],
  '2020': [151.2200, -33.9000],
  '2100': [151.1800, -33.7900],
  '2200': [151.0300, -33.9200],
  // VIC
  '3000': [144.9631, -37.8136], // Melbourne CBD
  '3800': [145.1300, -37.9100],
  // QLD
  '4000': [153.0251, -27.4698], // Brisbane CBD
  '4217': [153.4300, -28.0200], // Gold Coast
  '4220': [153.4000, -28.0800],
  // WA
  '6000': [115.8605, -31.9505], // Perth CBD
  '6010': [115.7600, -31.9500],
  '6020': [115.7500, -31.8800],
  '6100': [115.9000, -31.9700],
  // SA
  '5000': [138.6007, -34.9285], // Adelaide CBD
  // ACT
  '2600': [149.1300, -35.2809], // Canberra
  '2601': [149.1244, -35.2835],
}

// Fallback geocoding based on state prefix
function getApproxCoordinates(postcode: string): [number, number] | null {
  // Check exact match first
  if (POSTCODE_COORDS[postcode]) {
    return POSTCODE_COORDS[postcode]
  }

  // Fallback to state capital based on prefix
  const prefix = postcode.charAt(0)
  switch (prefix) {
    case '2': return [151.2093, -33.8688] // NSW -> Sydney
    case '3': return [144.9631, -37.8136] // VIC -> Melbourne
    case '4': return [153.0251, -27.4698] // QLD -> Brisbane
    case '5': return [138.6007, -34.9285] // SA -> Adelaide
    case '6': return [115.8605, -31.9505] // WA -> Perth
    case '7': return [147.3272, -42.8821] // TAS -> Hobart
    case '0': return [130.8456, -12.4634] // NT -> Darwin
    default: return null
  }
}

export default function DispositionForm() {
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null)
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [postcodeZone, setPostcodeZone] = useState<PostcodeZone | null>(null)
  const [postcodeError, setPostcodeError] = useState<string | null>(null)
  const [isLoadingPostcode, setIsLoadingPostcode] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [mapCoordinates, setMapCoordinates] = useState<[number, number] | null>(null)
  const [serviceAreaInfo, setServiceAreaInfo] = useState<{ inArea: boolean; areaName: string | null } | null>(null)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [calendarView, setCalendarView] = useState<'heatmap' | 'dayslots'>('heatmap')
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null)
  const [selectedDayData, setSelectedDayData] = useState<DayData | null>(null)

  // Lookup postcode when 4 digits entered
  const lookupPostcode = useCallback(async (postcode: string) => {
    if (postcode.length !== 4) {
      setPostcodeZone(null)
      setPostcodeError(null)
      setMapCoordinates(null)
      setServiceAreaInfo(null)
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
        // Still show map even if not in database
      } else {
        setPostcodeZone(data)
      }

      // Get coordinates for map
      const coords = getApproxCoordinates(postcode)
      if (coords) {
        setMapCoordinates(coords)
      } else {
        setPostcodeError('Unable to locate postcode')
      }
    } catch {
      setPostcodeError('Error looking up postcode')
      setPostcodeZone(null)
    } finally {
      setIsLoadingPostcode(false)
    }
  }, [])

  // Parse query params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    const contact_id = params.get('contactID') || params.get('contact_id')
    const name = params.get('name')
    const phone = params.get('phone')
    const email = params.get('email')
    const postcode = params.get('postcode')
    const agent = params.get('agent')

    if (contact_id || name || phone || email || agent) {
      setContactInfo({
        contact_id: contact_id || '',
        name: name || '',
        phone: phone || '',
        email: email || '',
        agent: agent || '',
      })
    }

    // Pre-fill postcode if provided
    if (postcode && postcode.length === 4 && /^\d{4}$/.test(postcode)) {
      setFormData(prev => ({ ...prev, postcode }))
      lookupPostcode(postcode)
    }
  }, [lookupPostcode])

  const handlePostcodeLookup = () => {
    if (formData.postcode.length === 4) {
      lookupPostcode(formData.postcode)
    }
  }

  const handlePostcodeChange = (value: string) => {
    const numericValue = value.replace(/\D/g, '').slice(0, 4)
    setFormData(prev => ({ ...prev, postcode: numericValue }))
    setMapCoordinates(null)
    setServiceAreaInfo(null)
    // Reset calendar view when postcode changes
    setCalendarView('heatmap')
    setSelectedCalendarDate(null)
    setSelectedDayData(null)
  }

  const handlePostcodeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && formData.postcode.length === 4) {
      e.preventDefault()
      lookupPostcode(formData.postcode)
    }
  }

  const handleDispositionClick = (disposition: DispositionType) => {
    setFormData(prev => ({
      ...initialFormData,
      postcode: prev.postcode,
      disposition: disposition,
    }))
  }

  const handleServiceAreaCheck = useCallback((inArea: boolean, areaName: string | null) => {
    setServiceAreaInfo({ inArea, areaName })
    if (!inArea) {
      setPostcodeError('Postcode not in service area')
    } else {
      setPostcodeError(null)
    }
  }, [])

  const handleCalendarDaySelect = useCallback((date: string, dayData: DayData) => {
    setSelectedCalendarDate(date)
    setSelectedDayData(dayData)
    setCalendarView('dayslots')
  }, [])

  const handleCalendarBack = useCallback(() => {
    setSelectedCalendarDate(null)
    setSelectedDayData(null)
    setCalendarView('heatmap')
  }, [])

  const handleSlotSelect = useCallback((date: string, slot: 'AM' | 'PM', timeSlot: TimeSlot) => {
    setFormData(prev => ({
      ...prev,
      appointmentDate: date,
      timeSlot: slot,
      disposition: 'book_water_test',
    }))
    setToast({ message: `Slot selected: ${timeSlot.time} on ${date}`, type: 'success' })
  }, [])

  const handleSubmit = () => {
    const payload = {
      contactInfo,
      ...formData,
      serviceArea: serviceAreaInfo?.areaName,
      timestamp: new Date().toISOString(),
    }

    console.log('Form Submission Payload:', payload)
    setIsSubmitted(true)
    setToast({ message: 'Form submitted successfully!', type: 'success' })
  }

  const isFormValid = () => {
    if (!formData.disposition) return false

    switch (formData.disposition) {
      case 'book_water_test':
        return formData.appointmentDate && formData.timeSlot && formData.address
      case 'call_back':
        return formData.callbackDate && formData.callbackTime
      case 'not_interested':
        return formData.notInterestedReason !== ''
      case 'cross_department':
        return formData.department !== ''
      case 'not_compatible':
        return formData.notCompatibleReason !== ''
      default:
        return false
    }
  }

  // Thank you screen after submission
  if (isSubmitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--hs-background)' }}>
        <div className="hs-card p-8 text-center max-w-md">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--hs-color-success)' }}>
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--hs-text-primary)' }}>
            Outcome Recorded
          </h2>
          <p className="text-lg font-medium" style={{ color: 'var(--hs-color-secondary)' }}>
            Hit Mark As Complete To Trigger Next Call
          </p>
        </div>
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

  return (
    <div className="min-h-screen p-2" style={{ background: 'var(--hs-background)' }}>
      {/* Contact Info Header */}
      {contactInfo && (
        <div className="hs-card p-3 mb-2">
          <div className="flex flex-wrap gap-4 text-sm">
            {contactInfo.name && (
              <div className="hs-description-item">
                <label>Name</label>
                <span>{contactInfo.name}</span>
              </div>
            )}
            {contactInfo.phone && (
              <div className="hs-description-item">
                <label>Phone</label>
                <span>{contactInfo.phone}</span>
              </div>
            )}
            {contactInfo.email && (
              <div className="hs-description-item">
                <label>Email</label>
                <span>{contactInfo.email}</span>
              </div>
            )}
            {contactInfo.agent && (
              <div className="hs-description-item">
                <label>Agent</label>
                <span>{contactInfo.agent}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Three-Column Layout */}
      <div className="flex gap-2" style={{ height: 'calc(100vh - 100px)' }}>
        {/* Left Column - Postcode + Map */}
        <div className="w-[30%] flex flex-col gap-2">
          {/* Postcode Input */}
          <div className="hs-card p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={formData.postcode}
                onChange={(e) => handlePostcodeChange(e.target.value)}
                onKeyDown={handlePostcodeKeyDown}
                placeholder="Postcode"
                className={`hs-input flex-1 ${postcodeError ? 'error' : ''}`}
              />
              <button
                onClick={handlePostcodeLookup}
                disabled={formData.postcode.length !== 4 || isLoadingPostcode}
                className="hs-button hs-button-primary"
                style={{ minWidth: '44px', padding: '9px 12px' }}
              >
                {isLoadingPostcode ? (
                  <div className="hs-spinner" style={{ width: '16px', height: '16px' }} />
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                )}
              </button>
            </div>
            {postcodeError && (
              <p className="hs-error-text mt-1">{postcodeError}</p>
            )}
            {serviceAreaInfo?.inArea && serviceAreaInfo.areaName && (
              <p className="text-xs mt-1" style={{ color: 'var(--hs-color-success)' }}>
                Service Area: {serviceAreaInfo.areaName}
              </p>
            )}
          </div>

          {/* Map Display */}
          <div className="hs-card overflow-hidden flex-1">
            <div className="hs-tile-header">Service Area Map</div>
            <div style={{ height: 'calc(100% - 41px)' }}>
              <ServiceAreaMap
                coordinates={mapCoordinates}
                onServiceAreaCheck={handleServiceAreaCheck}
              />
            </div>
          </div>
        </div>

        {/* Middle Column - Calendar Heat Map */}
        <div className="w-[25%] flex flex-col">
          <div className="hs-card overflow-hidden flex-1 flex flex-col">
            <div className="hs-tile-header flex items-center justify-between">
              <span>
                {calendarView === 'heatmap' ? 'Available Appointments' :
                  `Slots for ${selectedCalendarDate ? new Date(selectedCalendarDate).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : ''}`}
              </span>
              <div className="flex items-center gap-2">
                {calendarView === 'dayslots' && (
                  <button
                    onClick={handleCalendarBack}
                    className="hs-link text-xs flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back
                  </button>
                )}
                {postcodeZone?.calendar_url && (
                  <a
                    href={postcodeZone.calendar_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hs-link text-xs flex items-center gap-1"
                  >
                    Open
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {formData.postcode.length !== 4 ? (
                <div className="flex items-center justify-center p-4 text-center h-full">
                  <p style={{ color: 'var(--hs-text-muted)' }} className="text-sm">
                    Enter a postcode to view available appointments
                  </p>
                </div>
              ) : calendarView === 'heatmap' ? (
                <CalendarHeatMap
                  postcode={formData.postcode}
                  onDaySelect={handleCalendarDaySelect}
                  onError={(error) => setToast({ message: error, type: 'error' })}
                />
              ) : selectedCalendarDate ? (
                <DaySlots
                  postcode={formData.postcode}
                  date={selectedCalendarDate}
                  onSlotSelect={handleSlotSelect}
                  onError={(error) => setToast({ message: error, type: 'error' })}
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Right Column - Disposition Form */}
        <div className="w-[45%] hs-card flex flex-col">
          {/* Tab Bar */}
          <div className="flex border-b" style={{ borderColor: 'var(--hs-border-color)' }}>
            {DISPOSITION_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleDispositionClick(tab.key)}
                className="flex-1 px-3 py-2.5 text-sm font-medium transition-all relative"
                style={{
                  backgroundColor: formData.disposition === tab.key ? tab.color : 'transparent',
                  color: formData.disposition === tab.key
                    ? (tab.key === 'call_back' ? 'var(--hs-gray-900)' : 'white')
                    : 'var(--hs-text-secondary)',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Form Content */}
          <div className="flex-1 p-4 overflow-auto">
            {!formData.disposition ? (
              <div className="h-full flex items-center justify-center text-center">
                <p style={{ color: 'var(--hs-text-muted)' }}>
                  Select a call outcome above to continue
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Form Title */}
                <h3 className="font-semibold text-lg" style={{ color: 'var(--hs-text-primary)' }}>
                  {DISPOSITION_TABS.find(t => t.key === formData.disposition)?.label.replace('Not Int', 'Not Interested').replace('Incompat', 'Not Compatible').replace('Other Dept', 'Cross Department')}
                </h3>

                {/* Book Water Test Fields */}
                {formData.disposition === 'book_water_test' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="hs-label">Appointment Date *</label>
                      <input
                        type="date"
                        value={formData.appointmentDate}
                        onChange={(e) => setFormData(prev => ({ ...prev, appointmentDate: e.target.value }))}
                        className="hs-input"
                      />
                    </div>
                    <div>
                      <label className="hs-label">Time Slot *</label>
                      <select
                        value={formData.timeSlot}
                        onChange={(e) => setFormData(prev => ({ ...prev, timeSlot: e.target.value as 'AM' | 'PM' | '' }))}
                        className="hs-input hs-select"
                      >
                        <option value="">Select time slot</option>
                        <option value="AM">AM (8:00 - 12:00)</option>
                        <option value="PM">PM (12:00 - 5:00)</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Address *</label>
                      <input
                        type="text"
                        value={formData.address}
                        onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                        placeholder="Full appointment address"
                        className="hs-input"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes..."
                        className="hs-input resize-none"
                      />
                    </div>
                  </div>
                )}

                {/* Call Back Fields */}
                {formData.disposition === 'call_back' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="hs-label">Callback Date *</label>
                      <input
                        type="date"
                        value={formData.callbackDate}
                        onChange={(e) => setFormData(prev => ({ ...prev, callbackDate: e.target.value }))}
                        className="hs-input"
                      />
                    </div>
                    <div>
                      <label className="hs-label">Callback Time *</label>
                      <input
                        type="time"
                        value={formData.callbackTime}
                        onChange={(e) => setFormData(prev => ({ ...prev, callbackTime: e.target.value }))}
                        className="hs-input"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes..."
                        className="hs-input resize-none"
                      />
                    </div>
                  </div>
                )}

                {/* Not Interested Fields */}
                {formData.disposition === 'not_interested' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="hs-label">Reason *</label>
                      <select
                        value={formData.notInterestedReason}
                        onChange={(e) => setFormData(prev => ({ ...prev, notInterestedReason: e.target.value }))}
                        className="hs-input hs-select"
                      >
                        <option value="">Select reason</option>
                        {NOT_INTERESTED_REASONS.map((reason) => (
                          <option key={reason} value={reason}>{reason}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes..."
                        className="hs-input resize-none"
                      />
                    </div>
                  </div>
                )}

                {/* Cross Department Fields */}
                {formData.disposition === 'cross_department' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="hs-label">Department *</label>
                      <select
                        value={formData.department}
                        onChange={(e) => setFormData(prev => ({ ...prev, department: e.target.value }))}
                        className="hs-input hs-select"
                      >
                        <option value="">Select department</option>
                        {DEPARTMENTS.map((dept) => (
                          <option key={dept} value={dept}>{dept}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes..."
                        className="hs-input resize-none"
                      />
                    </div>
                  </div>
                )}

                {/* Not Compatible Fields */}
                {formData.disposition === 'not_compatible' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="hs-label">Reason *</label>
                      <select
                        value={formData.notCompatibleReason}
                        onChange={(e) => setFormData(prev => ({ ...prev, notCompatibleReason: e.target.value }))}
                        className="hs-input hs-select"
                      >
                        <option value="">Select reason</option>
                        {NOT_COMPATIBLE_REASONS.map((reason) => (
                          <option key={reason} value={reason}>{reason}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="hs-label">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes..."
                        className="hs-input resize-none"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Submit Button */}
          {formData.disposition && (
            <div className="p-4 border-t" style={{ borderColor: 'var(--hs-border-color)' }}>
              <button
                onClick={handleSubmit}
                disabled={!isFormValid()}
                className="w-full py-3 px-6 rounded font-medium text-white transition-all"
                style={{
                  backgroundColor: isFormValid() ? 'var(--hs-color-secondary)' : 'var(--hs-gray-300)',
                  color: isFormValid() ? 'white' : 'var(--hs-text-muted)',
                  cursor: isFormValid() ? 'pointer' : 'not-allowed',
                }}
              >
                Confirm Outcome
              </button>
            </div>
          )}
        </div>
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
