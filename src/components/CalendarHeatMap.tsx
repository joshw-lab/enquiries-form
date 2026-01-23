'use client'

import { useState, useEffect } from 'react'
import { getCalendarHeatMap, getDaySlots, DayData, HeatMapResponse, DaySlotsResponse, TimeSlot } from '@/lib/calendar-api'

interface CalendarHeatMapProps {
  postcode: string
  onSlotSelect: (date: string, slot: 'AM' | 'PM', timeSlot: TimeSlot) => void
  onError?: (error: string) => void
}

export default function CalendarHeatMap({ postcode, onSlotSelect, onError }: CalendarHeatMapProps) {
  const [loading, setLoading] = useState(false)
  const [heatMapData, setHeatMapData] = useState<HeatMapResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)
  const [slotsData, setSlotsData] = useState<DaySlotsResponse | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)

  useEffect(() => {
    if (postcode && postcode.length === 4) {
      fetchHeatMap()
    }
  }, [postcode])

  // Auto-expand first available day
  useEffect(() => {
    if (heatMapData && !expandedDate) {
      const { priority_breakdown } = heatMapData
      const availableDays = [
        ...priority_breakdown.critical.days,
        ...priority_breakdown.urgent.days,
        ...priority_breakdown.warm.days,
        ...priority_breakdown.cooling.days,
      ].filter(day => day.available_count > 0)

      if (availableDays.length > 0) {
        handleDayClick(availableDays[0].date)
      }
    }
  }, [heatMapData])

  const fetchHeatMap = async () => {
    setLoading(true)
    setError(null)
    setExpandedDate(null)
    setSlotsData(null)

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

  const handleDayClick = async (date: string) => {
    if (expandedDate === date) {
      // Collapse if already expanded
      setExpandedDate(null)
      setSlotsData(null)
      return
    }

    setExpandedDate(date)
    setSlotsLoading(true)
    setSlotsData(null)

    try {
      const data = await getDaySlots(postcode, date)
      setSlotsData(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load slots'
      onError?.(message)
    } finally {
      setSlotsLoading(false)
    }
  }

  const handleSlotClick = (slot: TimeSlot) => {
    if (!expandedDate) return
    const period: 'AM' | 'PM' = slot.hour < 12 ? 'AM' : 'PM'
    onSlotSelect(expandedDate, period, slot)
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

  // Flatten all days and filter out days with no availability
  const availableDays = [
    ...priority_breakdown.critical.days,
    ...priority_breakdown.urgent.days,
    ...priority_breakdown.warm.days,
    ...priority_breakdown.cooling.days,
  ].filter(day => day.available_count > 0)

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

      {/* List of days with availability */}
      <div className="hs-heatmap-list">
        {availableDays.length === 0 ? (
          <div className="flex items-center justify-center p-4 text-center h-full">
            <p style={{ color: 'var(--hs-text-muted)' }} className="text-sm">
              No available slots in the next 14 days
            </p>
          </div>
        ) : (
          availableDays.map((day, index) => (
            <DayAccordion
              key={day.date}
              day={day}
              isExpanded={expandedDate === day.date}
              isFirstAvailable={index === 0}
              onToggle={() => handleDayClick(day.date)}
              slotsData={expandedDate === day.date ? slotsData : null}
              slotsLoading={expandedDate === day.date && slotsLoading}
              onSlotClick={handleSlotClick}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface DayAccordionProps {
  day: DayData
  isExpanded: boolean
  isFirstAvailable: boolean
  onToggle: () => void
  slotsData: DaySlotsResponse | null
  slotsLoading: boolean
  onSlotClick: (slot: TimeSlot) => void
}

function DayAccordion({
  day,
  isExpanded,
  isFirstAvailable,
  onToggle,
  slotsData,
  slotsLoading,
  onSlotClick
}: DayAccordionProps) {
  return (
    <div className={`hs-day-accordion ${isFirstAvailable && !isExpanded ? 'hs-day-row-highlight' : ''}`}>
      {/* Day header row */}
      <button
        onClick={onToggle}
        className={`hs-day-row-flat ${isExpanded ? 'hs-day-row-expanded' : ''}`}
      >
        <div className="hs-day-row-flat-date">
          <span className="hs-day-row-flat-weekday">{day.day_name}</span>
          <span className="hs-day-row-flat-daynum">{day.day_number}</span>
          <span className="hs-day-row-flat-month">{day.month_name}</span>
        </div>

        <div className="hs-day-row-flat-slots">
          <span className="hs-day-row-flat-count">{day.available_count}</span>
          <span className="hs-day-row-flat-label">slots</span>
        </div>

        <svg
          className={`hs-day-row-flat-arrow ${isExpanded ? 'hs-day-row-flat-arrow-down' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded slots content */}
      {isExpanded && (
        <div className="hs-day-accordion-content">
          {slotsLoading ? (
            <div className="flex items-center justify-center p-4">
              <div className="hs-spinner-small" />
            </div>
          ) : slotsData ? (
            <div className="hs-slots-inline">
              {/* Afternoon slots */}
              {slotsData.grouped_by_period.afternoon.length > 0 && (
                <SlotGroup
                  title="Afternoon"
                  slots={slotsData.grouped_by_period.afternoon}
                  onSlotClick={onSlotClick}
                />
              )}

              {/* Evening slots */}
              {slotsData.grouped_by_period.evening.length > 0 && (
                <SlotGroup
                  title="Evening"
                  slots={slotsData.grouped_by_period.evening}
                  onSlotClick={onSlotClick}
                />
              )}

              {/* Morning slots */}
              {slotsData.grouped_by_period.morning.length > 0 && (
                <SlotGroup
                  title="Morning"
                  slots={slotsData.grouped_by_period.morning}
                  onSlotClick={onSlotClick}
                />
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

interface SlotGroupProps {
  title: string
  slots: TimeSlot[]
  onSlotClick: (slot: TimeSlot) => void
}

function SlotGroup({ title, slots, onSlotClick }: SlotGroupProps) {
  return (
    <div className="hs-slot-group-inline">
      <div className="hs-slot-group-header">
        <span>{title}</span>
        <span className="hs-slot-group-count">{slots.length} slots</span>
      </div>
      <div className="hs-slot-grid-inline">
        {slots.map((slot) => (
          <button
            key={slot.event_id}
            onClick={() => onSlotClick(slot)}
            className="hs-slot-button-inline"
          >
            <span className="hs-slot-time-inline">{slot.time}</span>
            <span className="hs-slot-cta-inline">Book</span>
          </button>
        ))}
      </div>
    </div>
  )
}
