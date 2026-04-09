'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { DashboardTab, PipelineResponse, SyncResponse, CalendarResponse } from '@/lib/dashboard-types'
import PipelineView from './pipeline/PipelineView'
import QueueView from './QueueView'
import AgentLeadsRepModal from './AgentLeadsRepModal'

function perthDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

function formatDisplayDate(dateStr: string): string {
  const today = perthDate(new Date())
  if (dateStr === today) return 'Today'
  const d = new Date(dateStr + 'T12:00:00')
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (dateStr === perthDate(yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export default function OperationsDashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('region')) {
      return 'pipeline'
    }
    return 'activity'
  })
  const [clock, setClock] = useState('')
  const [lastFetched, setLastFetched] = useState<string | null>(null)
  const [leadsRepModalOpen, setLeadsRepModalOpen] = useState(false)
  const [isStale, setIsStale] = useState(false)
  const [advancedSearch, setAdvancedSearch] = useState(false)

  // Date navigation state (single day for default mode)
  const [selectedDate, setSelectedDate] = useState(() => perthDate(new Date()))

  // Data state
  const [pipelineData, setPipelineData] = useState<PipelineResponse | null>(null)
  const [syncData, setSyncData] = useState<SyncResponse | null>(null)
  const [calendarData, setCalendarData] = useState<CalendarResponse | null>(null)

  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const todayStr = perthDate(new Date())
  const isToday = selectedDate === todayStr

  function navigateDate(direction: -1 | 1) {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + direction)
    const newDate = perthDate(d)
    // Don't go into the future
    if (newDate > todayStr) return
    setSelectedDate(newDate)
  }

  // Snap to Activity when Pipeline becomes unavailable
  useEffect(() => {
    if ((!isToday || advancedSearch) && activeTab === 'pipeline') {
      setActiveTab('activity')
    }
  }, [isToday, advancedSearch, activeTab])

  // Clock tick
  useEffect(() => {
    const tick = () => {
      setClock(
        new Date().toLocaleTimeString('en-AU', {
          timeZone: 'Australia/Perth',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Fetch data
  const fetchDashboardData = useCallback(async () => {
    try {
      const [pipeRes, syncRes, calRes] = await Promise.all([
        fetch('/api/pipeline').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/sync').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/calendar').then((r) => (r.ok ? r.json() : null)),
      ])

      if (pipeRes) setPipelineData(pipeRes)
      if (syncRes) setSyncData(syncRes)
      if (calRes) setCalendarData(calRes)
      setLastFetched(new Date().toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Perth',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }))
      setIsStale(false)
    } catch {
      setIsStale(true)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchDashboardData()
  }, [fetchDashboardData])

  // Auto-refresh (60s) — only on Pipeline/Sync tabs
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current)
      refreshTimerRef.current = null
    }

    if (activeTab === 'pipeline') {
      refreshTimerRef.current = setInterval(fetchDashboardData, 60_000)
    }

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [activeTab, fetchDashboardData])

  async function handleLogout() {
    const { signOut } = await import('next-auth/react')
    signOut({ callbackUrl: '/reports/login' })
  }

  return (
    <div className="min-h-screen bg-[#f3f4f6]" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", fontSize: '13px' }}>
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-7 py-3 flex items-center justify-between">
        {/* Left: Title + Live chip + time */}
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-[#111827] tracking-tight">Call Reports</h1>
          <div className="flex items-center gap-1.5 bg-green-50 border border-green-300 text-green-600 rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" />
            {isStale ? 'Stale' : 'Live'}
          </div>
          {lastFetched && (
            <span className="text-[11px] text-gray-400">{lastFetched}</span>
          )}

          {/* Tab toggle — sits right of Live/time */}
          <div className="flex bg-gray-100 rounded-lg p-0.5 ml-2">
            <button
              onClick={() => setActiveTab('activity')}
              className={`px-4 py-1.5 rounded-md text-[12px] font-medium cursor-pointer transition-all ${
                activeTab === 'activity'
                  ? 'bg-white text-[#111827] shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Activity
            </button>
            {(() => {
              const pipelineDisabled = !isToday || advancedSearch
              return (
                <button
                  onClick={() => !pipelineDisabled && setActiveTab('pipeline')}
                  className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                    pipelineDisabled
                      ? 'text-gray-300 cursor-default'
                      : activeTab === 'pipeline'
                        ? 'bg-white text-[#111827] shadow-sm cursor-pointer'
                        : 'text-gray-500 hover:text-gray-700 cursor-pointer'
                  }`}
                  title={pipelineDisabled ? 'Only available for today' : undefined}
                >
                  Pipeline
                </button>
              )
            })()}
          </div>
        </div>

        {/* Center: Date navigation (only visible on Activity tab) */}
        {activeTab === 'activity' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateDate(-1)}
              className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 cursor-pointer transition-colors"
              title="Previous day"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-2 min-w-[120px] justify-center">
              <span className="text-sm font-semibold text-[#111827]">{formatDisplayDate(selectedDate)}</span>
              {!isToday && (
                <span className="text-[10px] text-gray-400">{selectedDate}</span>
              )}
            </div>
            <button
              onClick={() => navigateDate(1)}
              disabled={isToday}
              className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next day"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* Advanced Search toggle */}
            <button
              onClick={() => setAdvancedSearch(!advancedSearch)}
              className={`ml-3 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all border ${
                advancedSearch
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Advanced
            </button>
          </div>
        )}

        {/* Right: Actions */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLeadsRepModalOpen(true)}
            className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md px-2.5 py-1 cursor-pointer hover:bg-gray-50 transition-colors"
          >
            Sync Leads Rep
          </button>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-7 py-5 max-w-[1560px] mx-auto">
        {activeTab === 'pipeline' && (
          <PipelineView
            data={pipelineData}
            calendarData={calendarData}
            syncData={syncData}
            onRefresh={fetchDashboardData}
          />
        )}
        {activeTab === 'activity' && (
          <QueueView
            selectedDate={selectedDate}
            advancedSearch={advancedSearch}
          />
        )}
      </div>

      <AgentLeadsRepModal open={leadsRepModalOpen} onClose={() => setLeadsRepModalOpen(false)} />
    </div>
  )
}
