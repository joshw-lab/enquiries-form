'use client'

import { useState, useEffect } from 'react'
import { getDaySlots, DaySlotsResponse, TimeSlot } from '@/lib/calendar-api'

interface DaySlotsProps {
  postcode: string
  date: string
  onSlotSelect: (date: string, slot: 'AM' | 'PM', timeSlot: TimeSlot) => void
  onError?: (error: string) => void
}

export default function DaySlots({ postcode, date, onSlotSelect, onError }: DaySlotsProps) {
  const [loading, setLoading] = useState(false)
  const [slotsData, setSlotsData] = useState<DaySlotsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDaySlots()
  }, [postcode, date])

  const fetchDaySlots = async () => {
    setLoading(true)
    setError(null)

    try {
      const data = await getDaySlots(postcode, date)
      setSlotsData(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load slots'
      setError(message)
      onError?.(message)
    } finally {
      setLoading(false)
    }
  }

  const handleSlotClick = (slot: TimeSlot) => {
    // Determine AM/PM based on hour
    const period: 'AM' | 'PM' = slot.hour < 12 ? 'AM' : 'PM'
    onSlotSelect(date, period, slot)
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
          onClick={fetchDaySlots}
          className="hs-button hs-button-primary mt-3"
          style={{ padding: '6px 12px', fontSize: '12px' }}
        >
          Try Again
        </button>
      </div>
    )
  }

  if (!slotsData) return null

  const { grouped_by_period, total_slots, day_display } = slotsData

  return (
    <div className="hs-dayslots-container">
      {/* Clean Header */}
      <div className="hs-dayslots-header-clean">
        <div className="hs-dayslots-title-clean">{day_display}</div>
        <div className="hs-dayslots-subtitle">{total_slots} available slots</div>
      </div>

      {/* Slots Content */}
      <div className="hs-dayslots-content">
        {total_slots === 0 ? (
          <div className="hs-dayslots-empty">
            <p>No available slots for this day</p>
          </div>
        ) : (
          <>
            {/* Morning Slots */}
            {grouped_by_period.morning.length > 0 && (
              <SlotPeriod
                title="Morning"
                slots={grouped_by_period.morning}
                onSlotClick={handleSlotClick}
              />
            )}

            {/* Afternoon Slots */}
            {grouped_by_period.afternoon.length > 0 && (
              <SlotPeriod
                title="Afternoon"
                slots={grouped_by_period.afternoon}
                onSlotClick={handleSlotClick}
              />
            )}

            {/* Evening Slots */}
            {grouped_by_period.evening.length > 0 && (
              <SlotPeriod
                title="Evening"
                slots={grouped_by_period.evening}
                onSlotClick={handleSlotClick}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface SlotPeriodProps {
  title: string
  slots: TimeSlot[]
  onSlotClick: (slot: TimeSlot) => void
}

function SlotPeriod({ title, slots, onSlotClick }: SlotPeriodProps) {
  return (
    <div className="hs-slot-period">
      <div className="hs-slot-period-header-clean">
        <span>{title}</span>
        <span className="hs-slot-period-count">{slots.length} slots</span>
      </div>
      <div className="hs-slot-period-grid">
        {slots.map((slot) => (
          <button
            key={slot.event_id}
            onClick={() => onSlotClick(slot)}
            className="hs-slot-button-clean"
          >
            <span className="hs-slot-time-clean">{slot.time}</span>
            <span className="hs-slot-cta-clean">Book</span>
          </button>
        ))}
      </div>
    </div>
  )
}
