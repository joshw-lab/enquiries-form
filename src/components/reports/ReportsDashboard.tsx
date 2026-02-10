'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSupabase } from '@/lib/supabase'
import {
  fetchSubmissions,
  fetchUserLookup,
  extractAgentList,
  type FormSubmission,
  type Filters as FiltersType,
} from '@/lib/reports-queries'
import Filters from './Filters'
import StatsCards from './StatsCards'
import { type StatsCardFilter } from './StatsCards'
import DispositionTable from './DispositionTable'
import DispositionChart from './DispositionChart'
import CallRecordsTable from './CallRecordsTable'
import CallRecordingsModal from './CallRecordingsModal'

export default function ReportsDashboard() {
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [agents, setAgents] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const userLookupRef = useRef<Record<string, string>>({})

  // Filter state
  const [selectedAgent, setSelectedAgent] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Recordings modal state
  const [recordingsModalOpen, setRecordingsModalOpen] = useState(false)
  const [recordingsModalTitle, setRecordingsModalTitle] = useState('')
  const [recordingsModalFilters, setRecordingsModalFilters] = useState<
    FiltersType & { disposition?: string }
  >({})

  // Set default to last 30 days on mount
  useEffect(() => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - 30)
    setStartDate(start.toISOString().split('T')[0])
    setEndDate(end.toISOString().split('T')[0])
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

    const result = await fetchSubmissions(supabase, filters, userLookupRef.current)

    if (result.error) {
      setError(result.error)
    } else {
      setSubmissions(result.data)
    }

    // Also fetch all (unfiltered by agent) for the agent list
    const allResult = await fetchSubmissions(supabase, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }, userLookupRef.current)
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
        <button
          onClick={handleLogout}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Sign out
        </button>
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
    </div>
  )
}
