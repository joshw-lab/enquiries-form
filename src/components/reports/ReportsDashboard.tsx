'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSupabase } from '@/lib/supabase'
import {
  fetchSubmissions,
  fetchUserLookup,
  fetchDialStats,
  extractAgentList,
  REPORT_TIMEZONE,
  type FormSubmission,
  type DialStats,
  type Filters as FiltersType,
} from '@/lib/reports-queries'
import Filters from './Filters'
import StatsCards from './StatsCards'
import { type StatsCardFilter } from './StatsCards'
import DispositionTable from './DispositionTable'
import DispositionChart from './DispositionChart'
import CallRecordsTable from './CallRecordsTable'
import CallRecordingsModal from './CallRecordingsModal'
import AgentLeadsRepModal from './AgentLeadsRepModal'

export default function ReportsDashboard() {
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [dialStats, setDialStats] = useState<DialStats | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const userLookupRef = useRef<Record<string, string>>({})
  const requestIdRef = useRef(0)

  // Filter state
  const [selectedAgent, setSelectedAgent] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Leads Rep modal state
  const [leadsRepModalOpen, setLeadsRepModalOpen] = useState(false)

  // Recordings modal state
  const [recordingsModalOpen, setRecordingsModalOpen] = useState(false)
  const [recordingsModalTitle, setRecordingsModalTitle] = useState('')
  const [recordingsModalFilters, setRecordingsModalFilters] = useState<
    FiltersType & { disposition?: string }
  >({})

  // Set default to today (Perth timezone)
  useEffect(() => {
    const fmt = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: REPORT_TIMEZONE })
    const today = fmt(new Date())
    setStartDate(today)
    setEndDate(today)
  }, [])

  // Load user lookup once on mount
  useEffect(() => {
    async function loadLookup() {
      const supabase = getSupabase()
      if (!supabase) return
      userLookupRef.current = await fetchUserLookup(supabase)
    }
    loadLookup()
  }, [])

  const loadData = useCallback(async () => {
    const supabase = getSupabase()
    if (!supabase) {
      setError('Supabase not configured')
      setLoading(false)
      return
    }

    // Increment request ID so stale fetches are ignored
    const thisRequest = ++requestIdRef.current

    setLoading(true)
    setError('')

    // Ensure user lookup is loaded
    if (Object.keys(userLookupRef.current).length === 0) {
      userLookupRef.current = await fetchUserLookup(supabase)
    }

    const filters: FiltersType = {}
    if (selectedAgent) filters.agent = selectedAgent
    if (startDate) filters.startDate = startDate
    if (endDate) filters.endDate = endDate

    // Fetch submissions and dial stats in parallel
    const [result, dialStatsResult, allResult] = await Promise.all([
      fetchSubmissions(supabase, filters, userLookupRef.current),
      fetchDialStats({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        agent: selectedAgent || undefined,
      }),
      // Also fetch all (unfiltered by agent) for the agent list
      fetchSubmissions(supabase, {
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      }, userLookupRef.current),
    ])

    // Ignore results if a newer request has been started
    if (thisRequest !== requestIdRef.current) return

    if (result.error) {
      setError(result.error)
    } else {
      setSubmissions(result.data)
    }

    if (!dialStatsResult.error) {
      setDialStats(dialStatsResult.data)
    } else {
      console.warn('Failed to load dial stats:', dialStatsResult.error)
    }

    if (!allResult.error) {
      setAgents(extractAgentList(allResult.data))
    }

    setLoading(false)
  }, [selectedAgent, startDate, endDate])

  // Reload data when filters change (but wait for initial date range to be set)
  useEffect(() => {
    if (startDate || endDate) {
      loadData()
    }
  }, [loadData, startDate, endDate])

  function handleStatsCardClick(filter: StatsCardFilter) {
    setRecordingsModalTitle(filter.label)
    setRecordingsModalFilters({
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      agent: selectedAgent || undefined,
      disposition: filter.disposition,
    })
    setRecordingsModalOpen(true)
  }

  function handleListenClick(disposition?: string, title?: string) {
    setRecordingsModalTitle(title || 'Call Recording')
    setRecordingsModalFilters({
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      agent: selectedAgent || undefined,
      disposition,
    })
    setRecordingsModalOpen(true)
  }

  async function handleLogout() {
    await fetch('/api/reports/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    })
    window.location.href = '/reports/login'
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Call Reports</h1>
          <p className="text-sm text-gray-500 mt-0.5">Disposition analytics and agent performance</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLeadsRepModalOpen(true)}
            className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors cursor-pointer"
          >
            Update Leads Reps
          </button>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4">
        <Filters
          agents={agents}
          selectedAgent={selectedAgent}
          startDate={startDate}
          endDate={endDate}
          onAgentChange={setSelectedAgent}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm text-gray-500">
          Loading reports...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Stats */}
          <StatsCards
            submissions={submissions}
            startDate={startDate}
            endDate={endDate}
            dialStats={dialStats}
            onCardClick={handleStatsCardClick}
          />

          {/* Chart + Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <DispositionChart submissions={submissions} />
            </div>
            <div>
              <DispositionTable submissions={submissions} />
            </div>
          </div>

          {/* Call Records */}
          <CallRecordsTable
            submissions={submissions}
            onListenClick={handleListenClick}
          />
        </div>
      )}

      {/* Recordings Modal */}
      <CallRecordingsModal
        open={recordingsModalOpen}
        onClose={() => setRecordingsModalOpen(false)}
        title={recordingsModalTitle}
        filters={recordingsModalFilters}
      />

      {/* Leads Rep Modal */}
      <AgentLeadsRepModal
        open={leadsRepModalOpen}
        onClose={() => setLeadsRepModalOpen(false)}
      />
    </div>
  )
}
