'use client'

import { useState, useRef, useEffect } from 'react'
import type { PipelineResponse, CalendarResponse, Region } from '@/lib/dashboard-types'
import RegionCard from './RegionCard'
import DrillPanel from './DrillPanel'

interface PipelineViewProps {
  data: PipelineResponse | null
  calendarData: CalendarResponse | null
  onRefresh: () => void
}

export default function PipelineView({ data, calendarData, onRefresh }: PipelineViewProps) {
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null)
  const drillRef = useRef<HTMLDivElement>(null)

  // Merge calendar data into pipeline regions if available
  const regions = data?.regions.map((r) => {
    if (calendarData?.regions[r.region]) {
      return { ...r, calendar: calendarData.regions[r.region] }
    }
    return r
  }) ?? []

  const selectedData = selectedRegion
    ? regions.find((r) => r.region === selectedRegion) ?? null
    : null

  // Scroll drill panel into view when opened
  useEffect(() => {
    if (selectedData && drillRef.current) {
      setTimeout(() => {
        drillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 50)
    }
  }, [selectedData])

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-500">
        Loading pipeline data...
      </div>
    )
  }

  return (
    <div>
      {/* Section heading */}
      <div className="flex items-center gap-2.5 mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        6 Regions
        <span className="flex-1 h-px bg-gray-300" />
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
        {regions.map((r) => (
          <RegionCard
            key={r.region}
            data={r}
            isSelected={selectedRegion === r.region}
            onClick={() => setSelectedRegion(selectedRegion === r.region ? null : r.region)}
          />
        ))}
      </div>

      {/* Drill panel */}
      {selectedData && (
        <div ref={drillRef}>
          <DrillPanel
            data={selectedData}
            onClose={() => setSelectedRegion(null)}
          />
        </div>
      )}
    </div>
  )
}
