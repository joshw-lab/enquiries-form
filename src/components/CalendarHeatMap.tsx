'use client'

import { useState, useEffect } from 'react'
import { getCalendarHeatMap, DayData, HeatMapResponse } from '@/lib/calendar-api'

interface CalendarHeatMapProps {
  postcode: string
  onDaySelect: (date: string, dayData: DayData) => void
  onError?: (error: string) => void
}

export default function CalendarHeatMap({ postcode, onDaySelect, onError }: CalendarHeatMapProps) {
  const [loading, setLoading] = useState(false)
  const [heatMapData, setHeatMapData] = useState<HeatMapResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (postcode && postcode.length === 4) {
      fetchHeatMap()
    }
  }, [postcode])

  const fetchHeatMap = async () => {
    setLoading(true)
    setError(null)

    try {
      const data = await getCalendarHeatMap(postcode, 14)
      setHeatMapData(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load availability'
      setError(message)
      onError?.(message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 h-full">
        <div className="hs-spinner" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-center h-full flex flex-col items-center justify-center">
        <p className="text-sm" style={{ color: 'var(--hs-color-danger)' }}>
          {error}
        </p>
        <button
          onClick={fetchHeatMap}
          className="hs-button hs-button-primary mt-3"
          style={{ padding: '6px 12px', fontSize: '12px' }}
        >
          Try Again
        </button>
      </div>
    )
  }

  if (!heatMapData) {
    return (
      <div className="flex items-center justify-center p-4 text-center h-full">
        <p style={{ color: 'var(--hs-text-muted)' }} className="text-sm">
          Enter a postcode to view availability
        </p>
      </div>
    )
  }

  const { priority_breakdown, service_area_name, total_slots_available } = heatMapData

  // Flatten all days into a single list, ordered by date
  const allDays = [
    ...priority_breakdown.critical.days,
    ...priority_breakdown.urgent.days,
    ...priority_breakdown.warm.days,
    ...priority_breakdown.cooling.days,
  ]

  // Find first day with available slots
  const firstAvailableIndex = allDays.findIndex(d => d.available_count > 0)

  return (
    <div className="hs-heatmap-container">
      {/* Header */}
      <div className="hs-heatmap-header">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium" style={{ color: 'var(--hs-text-secondary)' }}>
            {service_area_name}
          </span>
          <span className="text-xs" style={{ color: 'var(--hs-text-muted)' }}>
            {total_slots_available} slots available
          </span>
        </div>
      </div>

      {/* Flat list of all days */}
      <div className="hs-heatmap-list">
        {allDays.map((day, index) => (
          <DayRow
            key={day.date}
            day={day}
            onSelect={onDaySelect}
            isFirstAvailable={index === firstAvailableIndex}
          />
        ))}
      </div>
    </div>
  )
}

interface DayRowProps {
  day: DayData
  onSelect: (date: string, dayData: DayData) => void
  isFirstAvailable?: boolean
}

function DayRow({ day, onSelect, isFirstAvailable }: DayRowProps) {
  const hasSlots = day.available_count > 0

  return (
    <button
      onClick={() => onSelect(day.date, day)}
      disabled={!hasSlots}
      className={`hs-day-row-flat ${isFirstAvailable ? 'hs-day-row-highlight' : ''}`}
    >
      <div className="hs-day-row-flat-date">
        <span className="hs-day-row-flat-weekday">{day.day_name}</span>
        <span className="hs-day-row-flat-daynum">{day.day_number}</span>
        <span className="hs-day-row-flat-month">{day.month_name}</span>
      </div>

      <div className="hs-day-row-flat-slots">
        {hasSlots ? (
          <>
            <span className="hs-day-row-flat-count">{day.available_count}</span>
            <span className="hs-day-row-flat-label">slots</span>
          </>
        ) : (
          <span className="hs-day-row-flat-none">-</span>
        )}
      </div>

      {hasSlots && (
        <svg className="hs-day-row-flat-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </button>
  )
}
