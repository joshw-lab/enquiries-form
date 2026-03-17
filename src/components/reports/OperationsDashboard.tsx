'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { DashboardTab, PipelineResponse, SyncResponse, CalendarResponse } from '@/lib/dashboard-types'
import ReportsDashboard from './ReportsDashboard'
import PipelineView from './pipeline/PipelineView'
import SyncView from './SyncView'
import QueueView from './QueueView'

const LEFT_TABS: { id: DashboardTab; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'reports', label: 'Reports' },
  { id: 'pipeline', label: 'Pipeline' },
]

const RIGHT_TABS: { id: DashboardTab; label: string }[] = [
  { id: 'sync', label: 'Sync' },
]

export default function OperationsDashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('queue')
  const [clock, setClock] = useState('')
  const [lastFetched, setLastFetched] = useState<string | null>(null)
  const [isStale, setIsStale] = useState(false)

  // Data state
  const [pipelineData, setPipelineData] = useState<PipelineResponse | null>(null)
  const [syncData, setSyncData] = useState<SyncResponse | null>(null)
  const [calendarData, setCalendarData] = useState<CalendarResponse | null>(null)

  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

    if (activeTab === 'pipeline' || activeTab === 'sync') {
      refreshTimerRef.current = setInterval(fetchDashboardData, 60_000)
    }

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [activeTab, fetchDashboardData])

  // Sync badge count
  const syncIssueCount = syncData
    ? syncData.campaigns.filter((c) => c.delta !== 0).length
    : 0

  async function handleLogout() {
    await fetch('/api/reports/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    })
    window.location.href = '/reports/login'
  }

  return (
    <div className="min-h-screen bg-[#f3f4f6]" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", fontSize: '13px' }}>
      {/* Topbar */}
      <div className="bg-white border-b border-gray-200 px-7 py-3.5 flex items-center justify-between">
        <h1 className="text-lg font-bold text-[#111827] tracking-tight">Call Reports</h1>
        <div className="flex items-center gap-4">
          {/* Live chip */}
          <div className="flex items-center gap-1.5 bg-green-50 border border-green-300 text-green-600 rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" />
            {isStale ? 'Stale' : 'Live'}
          </div>
          {lastFetched && (
            <span className="text-[11px] text-gray-400">{lastFetched}</span>
          )}
          <span className="text-[11px] text-gray-400">{clock}</span>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Nav tabs */}
      <div className="bg-white border-b border-gray-200 px-7 flex justify-between">
        <div className="flex">
          {LEFT_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-[13px] font-medium cursor-pointer flex items-center gap-1.5 border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'text-[#111827] border-[#111827]'
                  : 'text-gray-400 border-transparent hover:text-gray-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex">
          {RIGHT_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-[13px] font-medium cursor-pointer flex items-center gap-1.5 border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'text-[#111827] border-[#111827]'
                  : 'text-gray-400 border-transparent hover:text-gray-500'
              }`}
            >
              {tab.label}
              {tab.id === 'sync' && syncIssueCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-px rounded-full bg-red-100 text-red-600">
                  {syncIssueCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="px-7 py-5 max-w-[1560px] mx-auto">
        {activeTab === 'pipeline' && (
          <PipelineView
            data={pipelineData}
            calendarData={calendarData}
            onRefresh={fetchDashboardData}
          />
        )}
        {activeTab === 'sync' && (
          <SyncView data={syncData} onRefresh={fetchDashboardData} />
        )}
        {activeTab === 'reports' && <ReportsDashboard />}
        {activeTab === 'queue' && <QueueView />}
      </div>
    </div>
  )
}
