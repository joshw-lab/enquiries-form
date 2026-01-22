'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSupabase, PostcodeZone } from '@/lib/supabase'
import { convertMapViewerToEmbed, convertCalendarCidToEmbed } from '@/lib/url-utils'
import Toast from './Toast'

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

export default function DispositionForm() {
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null)
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [postcodeZone, setPostcodeZone] = useState<PostcodeZone | null>(null)
  const [postcodeError, setPostcodeError] = useState<string | null>(null)
  const [isLoadingPostcode, setIsLoadingPostcode] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

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

  // Parse query params on mount - supports both old and RingCentral format
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    // Support both formats:
    // Old: contact_id, name, phone, email
    // RingCentral: contactID, name, email, postcode, agent
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

  const handlePostcodeChange = (value: string) => {
    const numericValue = value.replace(/\D/g, '').slice(0, 4)
    setFormData(prev => ({ ...prev, postcode: numericValue }))

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
      postcode: prev.postcode,
      disposition: prev.disposition === disposition ? null : disposition,
    }))
  }

  const handleSubmit = () => {
    const payload = {
      contactInfo,
      ...formData,
      timestamp: new Date().toISOString(),
    }

    console.log('Form Submission Payload:', payload)
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

  return (
    <div className="min-h-screen p-4 md:p-6" style={{ background: 'var(--hs-background)' }}>
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Contact Info Header */}
        {contactInfo && (
          <div className="hs-card p-4">
            <h2 className="hs-section-header">Contact Information</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {contactInfo.contact_id && (
                <div className="hs-description-item">
                  <label>Contact ID</label>
                  <span>{contactInfo.contact_id}</span>
                </div>
              )}
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

        {/* Postcode Lookup */}
        <div className="hs-card p-4">
          <label className="hs-label">Postcode</label>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={formData.postcode}
              onChange={(e) => handlePostcodeChange(e.target.value)}
              placeholder="Enter 4-digit postcode"
              className={`hs-input w-48 ${postcodeError ? 'error' : ''}`}
            />
            {isLoadingPostcode && <div className="hs-spinner" />}
          </div>
          {postcodeError && (
            <p className="hs-error-text">{postcodeError}</p>
          )}
        </div>

        {/* Map & Calendar Embeds */}
        {postcodeZone && (
          <div className="space-y-4">
            <div className="hs-card overflow-hidden">
              <div className="hs-tile-header">Service Area Map</div>
              <iframe
                src={convertMapViewerToEmbed(postcodeZone.map_url)}
                width="100%"
                height="300"
                style={{ border: 0 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>

            <div className="hs-card overflow-hidden">
              <div className="hs-tile-header flex items-center justify-between">
                <span>Available Appointments</span>
                <a
                  href={postcodeZone.calendar_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hs-link text-sm flex items-center gap-1"
                >
                  Open in new tab
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
              <iframe
                src={convertCalendarCidToEmbed(postcodeZone.calendar_url)}
                width="100%"
                height="400"
                style={{ border: 0 }}
                frameBorder="0"
                scrolling="no"
              />
            </div>
          </div>
        )}

        {/* Disposition Buttons */}
        <div className="hs-card p-4">
          <h2 className="hs-section-header">Call Disposition</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleDispositionClick('book_water_test')}
              className={`px-4 py-2.5 rounded font-medium text-sm transition-all ${
                formData.disposition === 'book_water_test'
                  ? 'text-white shadow-md ring-2 ring-offset-2'
                  : 'text-white hover:opacity-90'
              }`}
              style={{
                backgroundColor: 'var(--hs-color-success)',
                ringColor: formData.disposition === 'book_water_test' ? 'var(--hs-color-success)' : undefined
              }}
            >
              Book Water Test
            </button>

            <button
              onClick={() => handleDispositionClick('call_back')}
              className={`px-4 py-2.5 rounded font-medium text-sm transition-all ${
                formData.disposition === 'call_back'
                  ? 'shadow-md ring-2 ring-offset-2'
                  : 'hover:opacity-90'
              }`}
              style={{
                backgroundColor: 'var(--hs-color-warning)',
                color: 'var(--hs-gray-900)',
                ringColor: formData.disposition === 'call_back' ? 'var(--hs-color-warning)' : undefined
              }}
            >
              Call Back
            </button>

            <button
              onClick={() => handleDispositionClick('not_interested')}
              className={`px-4 py-2.5 rounded font-medium text-sm transition-all ${
                formData.disposition === 'not_interested'
                  ? 'text-white shadow-md ring-2 ring-offset-2'
                  : 'text-white hover:opacity-90'
              }`}
              style={{
                backgroundColor: 'var(--hs-color-primary)',
                ringColor: formData.disposition === 'not_interested' ? 'var(--hs-color-primary)' : undefined
              }}
            >
              Not Interested
            </button>

            <button
              onClick={() => handleDispositionClick('cross_department')}
              className={`px-4 py-2.5 rounded font-medium text-sm transition-all ${
                formData.disposition === 'cross_department'
                  ? 'text-white shadow-md ring-2 ring-offset-2'
                  : 'text-white hover:opacity-90'
              }`}
              style={{
                backgroundColor: 'var(--hs-color-secondary)',
                ringColor: formData.disposition === 'cross_department' ? 'var(--hs-color-secondary)' : undefined
              }}
            >
              Cross Department
            </button>

            <button
              onClick={() => handleDispositionClick('not_compatible')}
              className={`px-4 py-2.5 rounded font-medium text-sm transition-all ${
                formData.disposition === 'not_compatible'
                  ? 'text-white shadow-md ring-2 ring-offset-2'
                  : 'text-white hover:opacity-90'
              }`}
              style={{
                backgroundColor: 'var(--hs-gray-700)',
                ringColor: formData.disposition === 'not_compatible' ? 'var(--hs-gray-700)' : undefined
              }}
            >
              Not Compatible
            </button>
          </div>
        </div>

        {/* Conditional Fields */}
        {formData.disposition && (
          <div className="hs-card p-4 space-y-4">
            {/* Book Water Test Fields */}
            {formData.disposition === 'book_water_test' && (
              <>
                <h3 className="font-semibold text-sm pb-2 border-b" style={{ color: 'var(--hs-text-primary)', borderColor: 'var(--hs-border-color)' }}>
                  Book Water Test Details
                </h3>
                <div className="grid md:grid-cols-2 gap-4">
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
                </div>
                <div>
                  <label className="hs-label">Address *</label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                    placeholder="Full appointment address"
                    className="hs-input"
                  />
                </div>
              </>
            )}

            {/* Call Back Fields */}
            {formData.disposition === 'call_back' && (
              <>
                <h3 className="font-semibold text-sm pb-2 border-b" style={{ color: 'var(--hs-text-primary)', borderColor: 'var(--hs-border-color)' }}>
                  Call Back Details
                </h3>
                <div className="grid md:grid-cols-2 gap-4">
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
                </div>
              </>
            )}

            {/* Not Interested Fields */}
            {formData.disposition === 'not_interested' && (
              <>
                <h3 className="font-semibold text-sm pb-2 border-b" style={{ color: 'var(--hs-text-primary)', borderColor: 'var(--hs-border-color)' }}>
                  Not Interested Details
                </h3>
                <div>
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
              </>
            )}

            {/* Cross Department Fields */}
            {formData.disposition === 'cross_department' && (
              <>
                <h3 className="font-semibold text-sm pb-2 border-b" style={{ color: 'var(--hs-text-primary)', borderColor: 'var(--hs-border-color)' }}>
                  Cross Department Details
                </h3>
                <div>
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
              </>
            )}

            {/* Not Compatible Fields */}
            {formData.disposition === 'not_compatible' && (
              <>
                <h3 className="font-semibold text-sm pb-2 border-b" style={{ color: 'var(--hs-text-primary)', borderColor: 'var(--hs-border-color)' }}>
                  Not Compatible Details
                </h3>
                <div>
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
              </>
            )}

            {/* Notes field - shown for all dispositions */}
            <div>
              <label className="hs-label">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Additional notes..."
                className="hs-input resize-none"
              />
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                onClick={handleSubmit}
                disabled={!isFormValid()}
                className="w-full py-2.5 px-6 rounded font-medium text-white transition-all hs-button hs-button-primary"
                style={{
                  backgroundColor: isFormValid() ? 'var(--hs-color-primary)' : 'var(--hs-gray-300)',
                  color: isFormValid() ? 'white' : 'var(--hs-text-muted)',
                  cursor: isFormValid() ? 'pointer' : 'not-allowed',
                }}
              >
                Submit Disposition
              </button>
            </div>
          </div>
        )}
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
