'use client'

import { useState, useEffect, useCallback } from 'react'
import type { PipelineResponse, CalendarResponse, SyncResponse, Region, ServiceAreaCalendar, TodayLead } from '@/lib/dashboard-types'
import RegionCardCompact from './RegionCardCompact'
import RegionDetailView from './RegionDetailView'

interface PipelineViewProps {
  data: PipelineResponse | null
  calendarData: CalendarResponse | null
  syncData: SyncResponse | null
  onRefresh: () => void
}

export default function PipelineView({ data, calendarData, syncData, onRefresh }: PipelineViewProps) {
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    return (params.get('region') as Region) || null
  })
  const [todayLeads, setTodayLeads] = useState<TodayLead[]>([])

  // Fetch today's leads once (shared across all region views)
  useEffect(() => {
    fetch('/api/today-leads')
      .then((r) => r.ok ? r.json() : { leads: [] })
      .then((d) => setTodayLeads(d.leads ?? []))
      .catch(() => setTodayLeads([]))
  }, [])

  // Sync selectedRegion with URL via pushState
  const selectRegion = useCallback((region: Region | null) => {
    setSelectedRegion(region)
    const url = region
      ? `${window.location.pathname}?region=${region}`
      : window.location.pathname
    window.history.pushState({ region }, '', url)
  }, [])

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const region = e.state?.region ?? null
      setSelectedRegion(region)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Group service-area calendars by region
  const calendarByRegion: Record<string, ServiceAreaCalendar[]> = {}
  if (calendarData?.serviceAreas) {
    for (const sa of calendarData.serviceAreas) {
      if (!calendarByRegion[sa.region]) calendarByRegion[sa.region] = []
      calendarByRegion[sa.region].push(sa)
    }
  }

  // Merge calendar data into pipeline regions — aggregate across service areas
  const regions = data?.regions.map((r) => {
    const areas = calendarByRegion[r.region]
    if (areas && areas.length > 0) {
      const slots72h = { booked: 0, total: 0 }
      const slots7d = { booked: 0, total: 0 }
      for (const a of areas) {
        slots72h.booked += a.data.slots72h.booked
        slots72h.total += a.data.slots72h.total
        slots7d.booked += a.data.slots7d.booked
        slots7d.total += a.data.slots7d.total
      }
      return {
        ...r,
        calendar: { slots72h, slots7d, daily: areas[0].data.daily },
        serviceAreaCalendars: areas,
      }
    }
    return r
  }) ?? []

  const selectedData = selectedRegion
    ? regions.find((r) => r.region === selectedRegion) ?? null
    : null

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-500">
        Loading pipeline data...
      </div>
    )
  }

  // Detail view — replaces overview when a region is selected
  if (selectedData && selectedRegion) {
    return (
      <RegionDetailView
        data={selectedData}
        syncCampaigns={syncData?.campaigns.filter((c) => c.region === selectedRegion) ?? []}
        todayLeads={todayLeads.filter((l) => l.region === selectedRegion)}
        onBack={() => selectRegion(null)}
        onSelectRegion={(region) => selectRegion(region)}
      />
    )
  }

  // Overview grid
  return (
    <div>
      {/* Section heading */}
      <div className="flex items-center gap-2.5 mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        {regions.length} Regions
        <span className="flex-1 h-px bg-gray-300" />
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {regions.map((r) => (
          <RegionCardCompact
            key={r.region}
            data={r}
            isSelected={false}
            onClick={() => selectRegion(r.region)}
          />
        ))}
      </div>
    </div>
  )
}
