'use client'

import { useState, useEffect } from 'react'
import { getSupabase } from '@/lib/supabase'
import {
  FormSubmission,
  getDispositionLabel,
  getDispositionColor,
  type CallRecording,
} from '@/lib/reports-queries'

const HUBSPOT_PORTAL_ID = '5877625'

interface CallRecordsTableProps {
  submissions: FormSubmission[]
  onListenClick?: (disposition?: string, title?: string) => void
}

const PAGE_SIZE = 25

export default function CallRecordsTable({ submissions, onListenClick }: CallRecordsTableProps) {
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [recordingsMap, setRecordingsMap] = useState<Record<string, CallRecording>>({})

  const totalPages = Math.ceil(submissions.length / PAGE_SIZE)
  const pageData = submissions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Fetch call recordings matching current page contacts by contact ID + time window
  useEffect(() => {
    async function loadRecordings() {
      const supabase = getSupabase()
      if (!supabase || pageData.length === 0) return

      // Widen to ±60 min: call_start can be well before form submission
      // (agent talks to contact, then fills out booking details)
      const timestamps = pageData.map((s) => new Date(s.created_at).getTime())
      const minTime = new Date(Math.min(...timestamps) - 3600000).toISOString()
      const maxTime = new Date(Math.max(...timestamps) + 600000).toISOString()

      const { data, error } = await supabase
        .from('call_recordings')
        .select('*')
        .gte('call_start', minTime)
        .lte('call_start', maxTime)

      if (error || !data) return

      const map: Record<string, CallRecording> = {}
      for (const rec of data as CallRecording[]) {
        // Index by hubspot_contact_id (primary key for matching)
        if (rec.hubspot_contact_id) {
          const key = rec.hubspot_contact_id
          if (!map[key] || new Date(rec.call_start) > new Date(map[key].call_start)) {
            map[key] = rec
          }
        }
        // Also index by phone_number as fallback for submissions without contact_id
        if (rec.phone_number) {
          const phoneKey = rec.phone_number
          if (!map[phoneKey] || new Date(rec.call_start) > new Date(map[phoneKey].call_start)) {
            map[phoneKey] = rec
          }
        }
      }
      setRecordingsMap(map)
    }

    loadRecordings()
  }, [page, submissions])

  function findRecording(submission: FormSubmission): CallRecording | null {
    // Try matching by HubSpot contact ID first, then fall back to phone number
    const candidates = [
      submission.submitted_by?.contact_id,
      submission.contact?.phone,
    ].filter(Boolean) as string[]

    for (const key of candidates) {
      const rec = recordingsMap[key]
      if (!rec) continue

      // Verify call started within 30 min before submission (or 5 min after)
      const subTime = new Date(submission.created_at).getTime()
      const recTime = new Date(rec.call_start).getTime()
      const diff = subTime - recTime // positive = call started before submission (expected)
      if (diff < -5 * 60 * 1000 || diff > 30 * 60 * 1000) continue

      return rec
    }

    return null
  }

  if (submissions.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        No call records found for the selected filters.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Call Records ({submissions.length})
        </h3>
        <div className="flex items-center gap-3">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Prev
              </button>
              <span className="text-gray-500">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Date/Time</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agent</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Contact</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Phone</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Disposition</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Notes</th>
              <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">HubSpot</th>
              <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">GDrive</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((s) => {
              const fd = s.form_data || {}
              const recording = findRecording(s)
              const agent = s.agent_name && s.agent_name !== 'Unknown' ? s.agent_name : recording?.agent_name || s.agent_name || '-'
              const contactName = s.contact?.name || `${(fd.firstName as string) || ''} ${(fd.lastName as string) || ''}`.trim() || '-'
              const phone = s.contact?.phone || (fd.phoneNumber as string) || '-'
              const disposition = s.disposition || (fd.disposition as string) || 'unknown'
              const notes = (fd.notes as string) || ''
              const timestamp = new Date(s.created_at).toLocaleString('en-AU', {
                timeZone: 'Australia/Perth',
                day: '2-digit',
                month: '2-digit',
                year: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              })
              const isExpanded = expandedId === s.id

              // HubSpot sync status — check for call engagement or contact ID
              const hubspotCallId = s.hubspot_call_id || recording?.hubspot_call_id
              const hubspotContactId = s.hubspot_contact_id || recording?.hubspot_contact_id || s.submitted_by?.contact_id
              // Always link to contact record (reliable) — call engagement is visible in contact's Calls tab
              const hubspotUrl = hubspotContactId
                ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${hubspotContactId}`
                : null
              const hasSynced = hubspotCallId || hubspotContactId

              // GDrive backup status
              const hasGDrive = recording?.backup_status === 'uploaded' && recording?.gdrive_file_url
              const gdriveUrl = recording?.gdrive_file_url
              const gdriveStatus = recording
                ? recording.backup_status === 'uploaded' ? 'uploaded'
                : recording.backup_status === 'pending' || recording.backup_status === 'downloading' ? 'pending'
                : recording.backup_status === 'failed' ? 'failed'
                : 'none'
                : null

              return (
                <tr
                  key={s.id}
                  className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : s.id)}
                >
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{timestamp}</td>
                  <td className="px-4 py-2">{agent}</td>
                  <td className="px-4 py-2">{contactName}</td>
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{phone}</td>
                  <td className="px-4 py-2">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: getDispositionColor(disposition) }}
                    >
                      {getDispositionLabel(disposition)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 max-w-xs truncate" title={notes || undefined}>
                    {notes || '-'}
                  </td>

                  {/* HubSpot sync status */}
                  <td className="px-4 py-2 text-center">
                    {hasSynced && hubspotUrl ? (
                      <a
                        href={hubspotUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-green-700"
                        title={hubspotCallId ? "Call logged — view contact in HubSpot" : "Contact synced — view in HubSpot"}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {hubspotCallId ? 'Call Logged' : 'Synced'}
                      </a>
                    ) : hasSynced ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {hubspotCallId ? 'Call Logged' : 'Synced'}
                      </span>
                    ) : recording ? (
                      <span className="text-[10px] text-amber-500" title="Webhook received but no HubSpot call ID">Pending</span>
                    ) : (
                      <span className="text-[10px] text-red-400" title="No matching call record found">Missing</span>
                    )}
                  </td>

                  {/* GDrive backup status */}
                  <td className="px-4 py-2 text-center">
                    {hasGDrive && gdriveUrl ? (
                      <a
                        href={gdriveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-green-700"
                        title="View recording in Google Drive"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Backed up
                      </a>
                    ) : gdriveStatus === 'pending' ? (
                      <span className="text-[10px] text-amber-500" title="Recording backup in progress">Pending</span>
                    ) : gdriveStatus === 'failed' ? (
                      <span className="text-[10px] text-red-400" title="Recording backup failed">Failed</span>
                    ) : gdriveStatus === 'none' ? (
                      <span className="text-[10px] text-gray-400" title="No recording available for this call">No file</span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
