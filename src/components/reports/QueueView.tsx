'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { QueuedLead, CompletedCall, QueueMetrics, QueueSummary, QueueResponse, QueueCampaign } from '@/lib/dashboard-types'
import { getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'
import QueueFilters, { type QueueFilterState } from './QueueFilters'

const HUBSPOT_PORTAL_ID = '5877625'
const PAGE_SIZES = [25, 50, 100]

function perthDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '0s'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hrs < 24) return remainMins > 0 ? `${hrs}h ${remainMins}m ago` : `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

interface PriorityBadgeInfo {
  label: string
  bg: string
  text: string
  border: string
  tooltip: string
}

function getPriorityBadge(priority: string, reason: string): PriorityBadgeInfo {
  if (priority === 'IMMEDIATE' && reason === 'reconversion') {
    return {
      label: 'Reconversion',
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      tooltip: 'Lead date is today but contact was created earlier',
    }
  }
  if (priority === 'IMMEDIATE' && reason === 'recontacted') {
    return {
      label: 'Re-contacted',
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      tooltip: 'Lead date is today and previously contacted',
    }
  }
  if (priority === 'IMMEDIATE') {
    return {
      label: 'Immediate',
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      tooltip: 'Immediate priority',
    }
  }
  if (reason === 'new_today') {
    return {
      label: 'New',
      bg: 'bg-green-50',
      text: 'text-green-700',
      border: 'border-green-200',
      tooltip: 'New lead created today',
    }
  }
  if (reason === 'aged_lead') {
    return {
      label: 'Standard',
      bg: 'bg-gray-50',
      text: 'text-gray-500',
      border: 'border-gray-200',
      tooltip: 'Standard queue position',
    }
  }
  return {
    label: 'Standard',
    bg: 'bg-gray-50',
    text: 'text-gray-400',
    border: 'border-gray-200',
    tooltip: 'Loaded before priority tracking',
  }
}

export default function QueueView() {
  const [leads, setLeads] = useState<QueuedLead[]>([])
  const [calls, setCalls] = useState<CompletedCall[]>([])
  const [leadsTotal, setLeadsTotal] = useState(0)
  const [callsTotal, setCallsTotal] = useState(0)
  const [leadsPage, setLeadsPage] = useState(1)
  const [callsPage, setCallsPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [metrics, setMetrics] = useState<QueueMetrics>({
    callsToday: 0,
    callsPerHour: 0,
    leadsPerHour: 0,
    connectRate: null,
    bookingRate: null,
    bookingsPerHour: 0,
    avgLeadToCallMinutes: null,
  })
  const [summary, setSummary] = useState<QueueSummary>({
    totalLoaded: 0,
    immediateCount: 0,
    normalCount: 0,
    calledCount: 0,
  })

  const [disposition, setDisposition] = useState('connected')
  const [playingCall, setPlayingCall] = useState<CompletedCall | null>(null)
  const [availableAgents, setAvailableAgents] = useState<string[]>([])
  const [availableCampaigns, setAvailableCampaigns] = useState<QueueCampaign[]>([])

  const [filters, setFilters] = useState<QueueFilterState>(() => {
    const today = new Date()
    return {
      from: perthDate(today),
      to: perthDate(today),
      campaignType: '',
      campaignId: '',
      priority: '',
      operator: '',
      search: '',
    }
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')

    const params = new URLSearchParams()
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    if (filters.campaignType) params.set('campaign_type', filters.campaignType)
    if (filters.campaignId) params.set('campaign_id', filters.campaignId)
    if (filters.priority) params.set('priority', filters.priority)
    if (filters.operator) params.set('operator', filters.operator)
    if (filters.search) params.set('search', filters.search)
    if (disposition === 'all') params.set('show_all', '1')
    else if (disposition && disposition !== 'connected') params.set('disposition', disposition)
    params.set('leads_page', String(leadsPage))
    params.set('calls_page', String(callsPage))
    params.set('pageSize', String(pageSize))

    try {
      const res = await fetch(`/api/queue?${params}`)
      if (!res.ok) throw new Error(`Failed to fetch (${res.status})`)
      const data: QueueResponse = await res.json()
      setLeads(data.leads)
      setCalls(data.calls)
      setLeadsTotal(data.leadsTotal)
      setCallsTotal(data.callsTotal)
      setMetrics(data.metrics)
      setSummary(data.summary)
      if (data.availableAgents) setAvailableAgents(data.availableAgents)
      if (data.availableCampaigns) setAvailableCampaigns(data.availableCampaigns)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [filters, leadsPage, callsPage, pageSize, disposition])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  function handleFilterChange(newFilters: QueueFilterState) {
    setFilters(newFilters)
    setLeadsPage(1)
    setCallsPage(1)
  }

  const leadsTotalPages = Math.ceil(leadsTotal / pageSize)
  const callsTotalPages = Math.ceil(callsTotal / pageSize)

  return (
    <div className="space-y-3">
      {/* Filter bar (top) */}
      <div className="bg-white border border-gray-200 rounded-xl px-5 py-3">
        <QueueFilters
          filters={filters}
          onChange={handleFilterChange}
          availableAgents={availableAgents}
          availableCampaigns={availableCampaigns}
        />
      </div>

      {/* Metrics strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        <MetricCard label="Calls Today" value={metrics.callsToday} />
        <MetricCard label="Calls / hr" value={metrics.callsPerHour} accent="blue" />
        <MetricCard label="Leads / hr" value={metrics.leadsPerHour} />
        <MetricCard
          label="Connected"
          value={metrics.connectRate !== null ? `${metrics.connectRate}%` : '-'}
          accent="green"
        />
        <MetricCard
          label="Booked"
          value={metrics.bookingRate !== null ? `${metrics.bookingRate}%` : '-'}
          accent="green"
        />
        <MetricCard label="Bookings / hr" value={metrics.bookingsPerHour} accent="green" />
        <MetricCard
          label="Avg Wait"
          value={metrics.avgLeadToCallMinutes !== null ? `${metrics.avgLeadToCallMinutes}m` : '-'}
        />
      </div>

      {/* Two-column layout: 33% queue / 67% completed */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
        {/* LEFT: Queue */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[#111827]">
                Queue ({leadsTotal.toLocaleString()})
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                {summary.immediateCount} priority
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <span>Rows:</span>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setLeadsPage(1); setCallsPage(1) }}
                  className="border border-gray-200 rounded px-1.5 py-0.5 text-[11px] bg-white"
                >
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {leadsTotalPages > 1 && (
                <Pagination page={leadsPage} totalPages={leadsTotalPages} onPageChange={setLeadsPage} />
              )}
            </div>
          </div>
          <div className="divide-y divide-gray-100 overflow-y-auto" style={{ maxHeight: '70vh' }}>
            {error ? (
              <div className="px-4 py-8 text-center text-sm text-red-600">{error}</div>
            ) : loading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">Loading queue...</div>
            ) : leads.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">No leads found.</div>
            ) : (
              leads.map((lead) => <QueueLeadRow key={lead.id} lead={lead} />)
            )}
          </div>
        </div>

        {/* RIGHT: Completed calls */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <select
              value={disposition}
              onChange={(e) => { setDisposition(e.target.value); setCallsPage(1) }}
              className="text-sm font-semibold text-[#111827] bg-white border-none outline-none cursor-pointer pr-1 appearance-none"
              style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236b7280\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right center', paddingRight: '16px' }}
            >
              <option value="connected">All connections ({callsTotal.toLocaleString()})</option>
              <option value="all">All dispositions</option>
              <option value="Booked Test">Booked Test</option>
              <option value="Needs Call Back">Call Back</option>
              <option value="Not interested">Not Interested</option>
              <option value="Other Departments">Other Dept</option>
              <option value="Not Qualified">Not Qualified</option>
              <option value="No Answer">No Answer</option>
              <option value="Left Voicemail">Voicemail</option>
              <option value="Wrong Number">Wrong Number</option>
              <option value="Hang Up">Hang Up</option>
              <option value="Do Not Call">Do Not Call</option>
              <option value="Busy">Busy</option>
            </select>
            {callsTotalPages > 1 && (
              <Pagination page={callsPage} totalPages={callsTotalPages} onPageChange={setCallsPage} />
            )}
          </div>
          <div className="divide-y divide-gray-100 overflow-y-auto" style={{ maxHeight: '70vh' }}>
            {error ? (
              <div className="px-4 py-8 text-center text-sm text-red-600">{error}</div>
            ) : loading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">Loading calls...</div>
            ) : calls.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">No calls found.</div>
            ) : (
              calls.map((call) => <CompletedCallRow key={call.id} call={call} onPlay={setPlayingCall} />)
            )}
          </div>
        </div>
      </div>

      {/* Recording playback modal */}
      {playingCall && (
        <RecordingModal call={playingCall} onClose={() => setPlayingCall(null)} />
      )}
    </div>
  )
}

function RecordingModal({ call, onClose }: { call: CompletedCall; onClose: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrl = call.gdriveFileId ? `/api/recording?id=${call.gdriveFileId}` : null
  const displayName = call.contactName || call.contactId || 'Unknown'
  const hubspotUrl = call.contactId
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${call.contactId}`
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              {hubspotUrl ? (
                <a href={hubspotUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-blue-600 hover:text-blue-700 hover:underline">
                  {displayName}
                </a>
              ) : (
                <div className="text-sm font-semibold text-[#111827]">{displayName}</div>
              )}
              <div className="text-[11px] text-gray-500">
                {formatDateTime(call.callStart)} &middot; {call.agentName || 'Unknown agent'}
              </div>
            </div>
            {call.disposition && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium text-white"
                style={{ backgroundColor: getDispositionColor(call.disposition) }}
              >
                {getDispositionLabel(call.disposition)}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg cursor-pointer">&#10005;</button>
        </div>

        {/* Audio player + duration */}
        <div className="px-5 py-4 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center gap-4 mb-3">
            <div className="text-2xl font-bold text-[#111827] tabular-nums">{formatDuration(call.callDuration)}</div>
            {call.gdriveFileId && (
              <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">Google Drive</span>
            )}
          </div>
          {audioUrl ? (
            <audio ref={audioRef} controls autoPlay className="w-full" style={{ height: '40px' }}>
              <source src={audioUrl} type="audio/mpeg" />
            </audio>
          ) : (
            <div className="text-[12px] text-gray-400 italic">No recording available</div>
          )}
        </div>

        {/* Notes */}
        {call.notes && (
          <div className="px-5 py-3">
            <div className="text-[10px] text-gray-400 font-medium uppercase mb-1">Notes</div>
            <div className="text-[12px] text-gray-600">{call.notes}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function QueueLeadRow({ lead }: { lead: QueuedLead }) {
  const badge = getPriorityBadge(lead.dialPriority, lead.priorityReason)
  const hubspotUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${lead.contactId}`

  return (
    <div className="px-3 py-1.5 hover:bg-gray-50/50 transition-colors">
      {/* Line 1: Name (time ago) — badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <a
            href={hubspotUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] font-medium text-blue-600 hover:text-blue-700 hover:underline truncate"
          >
            {lead.contactName || lead.contactId}
          </a>
          <span className="text-[10px] text-gray-400 flex-shrink-0">{timeAgo(lead.loadedAt)}</span>
        </div>
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 ${badge.bg} ${badge.text} ${badge.border}`}
          title={badge.tooltip}
        >
          {badge.label}
        </span>
      </div>
      {/* Line 2: Campaign | State Postcode | Lead/Create dates | Contacted */}
      <div className="flex items-center gap-2 text-[10px] text-gray-400">
        <span className="bg-slate-100 text-slate-600 px-1 py-0.5 rounded font-medium">{lead.campaignType}</span>
        {(lead.contactState || lead.contactPostcode) && (
          <span>{[lead.contactState, lead.contactPostcode].filter(Boolean).join(' ')}</span>
        )}
        {lead.priorityContext?.lead_date && <span>L:{lead.priorityContext.lead_date}</span>}
        {lead.priorityContext?.createdate && <span>C:{lead.priorityContext.createdate}</span>}
        <span>{lead.priorityContext?.num_contacted ?? 0}x contacted</span>
      </div>
    </div>
  )
}

function CompletedCallRow({ call, onPlay }: { call: CompletedCall; onPlay: (c: CompletedCall) => void }) {
  const hubspotUrl = call.contactId
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${call.contactId}`
    : null

  const displayName = call.contactName || call.contactId || 'Unknown'

  return (
    <div className="px-3 py-1.5 hover:bg-gray-50/50 transition-colors">
      {/* Line 1: Name (time ago) Agent — disposition + play */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {hubspotUrl ? (
            <a
              href={hubspotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] font-medium text-blue-600 hover:text-blue-700 hover:underline truncate"
            >
              {displayName}
            </a>
          ) : (
            <span className="text-[13px] font-medium text-[#111827] truncate">{displayName}</span>
          )}
          <span className="text-[10px] text-gray-400 flex-shrink-0">{timeAgo(call.callStart)}</span>
          <span className="text-[10px] text-gray-500">{call.agentName || ''}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {call.gdriveFileId && (
            <button
              onClick={() => onPlay(call)}
              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 hover:bg-blue-600 text-white cursor-pointer flex-shrink-0"
              title="Play recording"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9" /></svg>
            </button>
          )}
          {call.disposition && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
              style={{ backgroundColor: getDispositionColor(call.disposition) }}
            >
              {getDispositionLabel(call.disposition)}
            </span>
          )}
        </div>
      </div>
      {/* Line 2: Duration + notes */}
      <div className="flex items-center gap-2 text-[10px] text-gray-400">
        <span>{formatDuration(call.callDuration)}</span>
        {call.notes && (
          <span className="text-gray-500 truncate" title={call.notes}>{call.notes}</span>
        )}
      </div>
    </div>
  )
}

function MetricCard({ label, value, accent }: { label: string; value: number | string; accent?: 'amber' | 'green' | 'blue' }) {
  const accentClass = accent === 'amber'
    ? 'text-amber-600'
    : accent === 'green'
      ? 'text-green-600'
      : accent === 'blue'
        ? 'text-blue-600'
        : 'text-[#111827]'

  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
      <div className="text-[10px] text-gray-500 font-medium mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${accentClass}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
      >
        Prev
      </button>
      <span className="text-gray-500">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
      >
        Next
      </button>
    </div>
  )
}
