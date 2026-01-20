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

  // Parse query params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const contact_id = params.get('contact_id')
    const name = params.get('name')
    const phone = params.get('phone')
    const email = params.get('email')
    const postcode = params.get('postcode')

    if (contact_id || name || phone || email) {
      setContactInfo({
        contact_id: contact_id || '',
        name: name || '',
        phone: phone || '',
        email: email || '',
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
    <div className="min-h-screen bg-gray-50 p-4 md:p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Contact Info Header */}
        {contactInfo && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Contact Information
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {contactInfo.contact_id && (
                <div>
                  <span className="text-xs text-gray-500">Contact ID</span>
                  <p className="font-medium text-gray-900">{contactInfo.contact_id}</p>
                </div>
              )}
              {contactInfo.name && (
                <div>
                  <span className="text-xs text-gray-500">Name</span>
                  <p className="font-medium text-gray-900">{contactInfo.name}</p>
                </div>
              )}
              {contactInfo.phone && (
                <div>
                  <span className="text-xs text-gray-500">Phone</span>
                  <p className="font-medium text-gray-900">{contactInfo.phone}</p>
                </div>
              )}
              {contactInfo.email && (
                <div>
                  <span className="text-xs text-gray-500">Email</span>
                  <p className="font-medium text-gray-900">{contactInfo.email}</p>
                </div>
              )}
            </div>
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
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-3 bg-gray-50 border-b border-gray-200">
                <h3 className="font-medium text-gray-900">Service Area Map</h3>
              </div>
              <iframe
                src={convertMapViewerToEmbed(postcodeZone.map_url)}
                width="100%"
                height="350"
                style={{ border: 0 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <h3 className="font-medium text-gray-900">Available Appointments</h3>
                <a
                  href={postcodeZone.calendar_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
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
                height="500"
                style={{ border: 0 }}
                frameBorder="0"
                scrolling="no"
              />
            </div>
          </div>
        )}

        {/* Disposition Buttons */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
            Call Disposition
          </h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => handleDispositionClick('book_water_test')}
              className={`px-5 py-3 rounded-lg font-medium transition-all ${
                formData.disposition === 'book_water_test'
                  ? 'bg-green-600 text-white ring-2 ring-green-600 ring-offset-2'
                  : 'bg-green-500 text-white hover:bg-green-600'
              }`}
            >
              Book Water Test
            </button>

            <button
              onClick={() => handleDispositionClick('call_back')}
              className={`px-5 py-3 rounded-lg font-medium transition-all ${
                formData.disposition === 'call_back'
                  ? 'bg-yellow-500 text-white ring-2 ring-yellow-500 ring-offset-2'
                  : 'bg-yellow-400 text-gray-900 hover:bg-yellow-500'
              }`}
            >
              Call Back
            </button>

            <button
              onClick={() => handleDispositionClick('not_interested')}
              className={`px-5 py-3 rounded-lg font-medium transition-all ${
                formData.disposition === 'not_interested'
                  ? 'bg-orange-600 text-white ring-2 ring-orange-600 ring-offset-2'
                  : 'bg-orange-500 text-white hover:bg-orange-600'
              }`}
            >
              Not Interested
            </button>

            <button
              onClick={() => handleDispositionClick('cross_department')}
              className={`px-5 py-3 rounded-lg font-medium transition-all ${
                formData.disposition === 'cross_department'
                  ? 'bg-blue-700 text-white ring-2 ring-blue-700 ring-offset-2'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              Cross Department
            </button>

            <button
              onClick={() => handleDispositionClick('not_compatible')}
              className={`px-5 py-3 rounded-lg font-medium transition-all ${
                formData.disposition === 'not_compatible'
                  ? 'bg-gray-900 text-white ring-2 ring-gray-900 ring-offset-2'
                  : 'bg-gray-800 text-white hover:bg-gray-900'
              }`}
            >
              Not Compatible
            </button>
          </div>
        </div>

        {/* Conditional Fields */}
        {formData.disposition && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
            {/* Book Water Test Fields */}
            {formData.disposition === 'book_water_test' && (
              <>
                <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                  Book Water Test Details
                </h3>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Appointment Date *
                    </label>
                    <input
                      type="date"
                      value={formData.appointmentDate}
                      onChange={(e) => setFormData(prev => ({ ...prev, appointmentDate: e.target.value }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Time Slot *
                    </label>
                    <select
                      value={formData.timeSlot}
                      onChange={(e) => setFormData(prev => ({ ...prev, timeSlot: e.target.value as 'AM' | 'PM' | '' }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                    >
                      <option value="">Select time slot</option>
                      <option value="AM">AM (8:00 - 12:00)</option>
                      <option value="PM">PM (12:00 - 5:00)</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Address *
                  </label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                    placeholder="Full appointment address"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                  />
                </div>
              </>
            )}

            {/* Call Back Fields */}
            {formData.disposition === 'call_back' && (
              <>
                <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                  Call Back Details
                </h3>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Callback Date *
                    </label>
                    <input
                      type="date"
                      value={formData.callbackDate}
                      onChange={(e) => setFormData(prev => ({ ...prev, callbackDate: e.target.value }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Callback Time *
                    </label>
                    <input
                      type="time"
                      value={formData.callbackTime}
                      onChange={(e) => setFormData(prev => ({ ...prev, callbackTime: e.target.value }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Not Interested Fields */}
            {formData.disposition === 'not_interested' && (
              <>
                <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                  Not Interested Details
                </h3>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason *
                  </label>
                  <select
                    value={formData.notInterestedReason}
                    onChange={(e) => setFormData(prev => ({ ...prev, notInterestedReason: e.target.value }))}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
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
                <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                  Cross Department Details
                </h3>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Department *
                  </label>
                  <select
                    value={formData.department}
                    onChange={(e) => setFormData(prev => ({ ...prev, department: e.target.value }))}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
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
                <h3 className="font-medium text-gray-900 pb-2 border-b border-gray-200">
                  Not Compatible Details
                </h3>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason *
                  </label>
                  <select
                    value={formData.notCompatibleReason}
                    onChange={(e) => setFormData(prev => ({ ...prev, notCompatibleReason: e.target.value }))}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Additional notes..."
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 resize-none"
              />
            </div>

            {/* Submit Button */}
            <div className="pt-4">
              <button
                onClick={handleSubmit}
                disabled={!isFormValid()}
                className={`w-full py-3 px-6 rounded-lg font-medium transition-all ${
                  isFormValid()
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
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
