'use client'

import { useState, useEffect } from 'react'
import { getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'

const HUBSPOT_PORTAL_ID = '5877625'

interface TimelineEvent {
  id: string
  type: 'loaded' | 'moved' | 'call' | 'disposition' | 'form'
  timestamp: string
  title: string
  description: string
  metadata: Record<string, unknown>
}

interface RoutingState {
  current_tier: string
  current_campaign_id: string
  lead_date: string
  hot_campaign_id: string | null
  new_campaign_id: string | null
  old_campaign_id: string | null
  moved_to_new_at: string | null
  moved_to_old_at: string | null
}

interface LeadTimelineModalProps {
  contactId: string
  contactName?: string | null
  open: boolean
  onClose: () => void
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0s'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

const EVENT_CONFIG: Record<string, { dot: string; bg: string; label: string }> = {
  loaded:      { dot: 'bg-green-500',  bg: 'bg-green-50 border-green-200 text-green-800',  label: 'Loaded' },
  moved:       { dot: 'bg-orange-500', bg: 'bg-orange-50 border-orange-200 text-orange-800', label: 'Moved' },
  call:        { dot: 'bg-blue-500',   bg: 'bg-blue-50 border-blue-200 text-blue-800',    label: 'Call' },
  disposition: { dot: 'bg-purple-500', bg: 'bg-purple-50 border-purple-200 text-purple-800', label: 'Disposition' },
  form:        { dot: 'bg-pink-500',   bg: 'bg-pink-50 border-pink-200 text-pink-800',    label: 'Form' },
}

const TIER_BADGE: Record<string, string> = {
  HOT: 'bg-red-100 text-red-700 border-red-200',
  NEW: 'bg-blue-100 text-blue-700 border-blue-200',
  OLD: 'bg-gray-100 text-gray-600 border-gray-200',
}

export default function LeadTimelineModal({ contactId, contactName, open, onClose }: LeadTimelineModalProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [routing, setRouting] = useState<RoutingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !contactId) return
    setLoading(true)
    setError('')

    fetch(`/api/lead-timeline?contactId=${encodeURIComponent(contactId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch timeline (${res.status})`)
        return res.json()
      })
      .then((data) => {
        setEvents(data.events || [])
        setRouting(data.routing || null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, contactId])

  if (!open) return null

  const hubspotUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`
  const displayName = contactName || contactId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <a
                href={hubspotUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base font-semibold text-blue-600 hover:text-blue-700 hover:underline"
              >
                {displayName}
              </a>
              {routing && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${TIER_BADGE[routing.current_tier] || TIER_BADGE.OLD}`}>
                  {routing.current_tier}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Contact {contactId}
              {routing?.lead_date && (
                <span> &middot; Lead date: {formatDateTime(routing.lead_date)}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Routing summary strip */}
        {routing && (
          <div className="px-6 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-4 text-[11px]">
            <span className="text-gray-500">Pipeline:</span>
            <span className={`px-1.5 py-0.5 rounded border font-medium ${routing.moved_to_new_at ? 'bg-gray-50 text-gray-400 border-gray-200 line-through' : TIER_BADGE.HOT}`}>
              HOT {routing.hot_campaign_id}
            </span>
            <span className="text-gray-300">&rarr;</span>
            <span className={`px-1.5 py-0.5 rounded border font-medium ${routing.moved_to_old_at ? 'bg-gray-50 text-gray-400 border-gray-200 line-through' : routing.moved_to_new_at && !routing.moved_to_old_at ? TIER_BADGE.NEW : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
              NEW {routing.new_campaign_id}
            </span>
            {routing.old_campaign_id && (
              <>
                <span className="text-gray-300">&rarr;</span>
                <span className={`px-1.5 py-0.5 rounded border font-medium ${routing.moved_to_old_at ? TIER_BADGE.OLD : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                  OLD {routing.old_campaign_id}
                </span>
              </>
            )}
          </div>
        )}

        {/* Timeline */}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">Loading timeline...</div>
          ) : events.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">No events found for this contact.</div>
          ) : (
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-[7px] top-3 bottom-3 w-0.5 bg-gray-200" />

              <div className="space-y-4">
                {events.map((event) => {
                  const config = EVENT_CONFIG[event.type] || EVENT_CONFIG.loaded
                  const meta = event.metadata
                  const audioUrl = (meta.storageUrl as string) || (meta.gdriveFileId ? `/api/recording?id=${meta.gdriveFileId}` : null)

                  return (
                    <div key={event.id} className="relative flex gap-3">
                      {/* Dot */}
                      <div className={`relative z-10 flex-shrink-0 w-4 h-4 rounded-full ${config.dot} mt-0.5 ring-2 ring-white`} />

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${config.bg}`}>
                            {config.label}
                          </span>
                          <span className="text-xs font-medium text-gray-900">{event.title}</span>
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5">{event.description}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">
                          {formatDateTime(event.timestamp)} &middot; {timeAgo(event.timestamp)}
                        </div>

                        {/* Call-specific: disposition badge + audio */}
                        {event.type === 'call' && (
                          <div className="flex items-center gap-2 mt-1.5">
                            {meta.disposition && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
                                style={{ backgroundColor: getDispositionColor(meta.disposition as string) }}
                              >
                                {getDispositionLabel(meta.disposition as string)}
                              </span>
                            )}
                            {meta.durationSeconds && (
                              <span className="text-[11px] text-gray-600 font-medium tabular-nums">
                                {formatDuration(meta.durationSeconds as number)}
                              </span>
                            )}
                            {audioUrl && (
                              <audio controls preload="none" className="h-7" style={{ width: '200px' }}>
                                <source src={audioUrl} />
                              </audio>
                            )}
                          </div>
                        )}

                        {/* Form-specific: disposition badge */}
                        {event.type === 'form' && meta.disposition && (
                          <div className="mt-1">
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
                              style={{ backgroundColor: getDispositionColor(meta.disposition as string) }}
                            >
                              {getDispositionLabel(meta.disposition as string)}
                            </span>
                          </div>
                        )}

                        {/* Loaded-specific: priority badge */}
                        {event.type === 'loaded' && meta.dialPriority && (
                          <div className="mt-1">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              meta.dialPriority === 'IMMEDIATE'
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-gray-50 text-gray-500 border-gray-200'
                            }`}>
                              {meta.dialPriority as string}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">{events.length} event{events.length !== 1 ? 's' : ''}</span>
          <a
            href={hubspotUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
          >
            Open in HubSpot &rarr;
          </a>
        </div>
      </div>
    </div>
  )
}
