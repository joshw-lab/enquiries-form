'use client'

import { useMemo, useState, useEffect } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import type { ChartCall } from '@/lib/dashboard-types'

interface CallTimelineChartProps {
  chartCalls: ChartCall[]
  dateFrom?: string
  dateTo?: string
  onDirectionChange?: (direction: string) => void
}

// Single-leg booking dispositions
const SINGLE_LEG_DISPOSITIONS = new Set([
  'booked_test_single_leg', 'booked_single_leg', 'single_leg',
  'Single Leg', 'Booked Test Single Leg',
])

// Full (non-single-leg) booking dispositions
const BOOKED_TEST_DISPOSITIONS = new Set([
  'Booked Test', 'book_water_test', 'booked_test', 'booked_water_test', 'booked',
])

// Group dispositions for cleaner chart lines
const DISPOSITION_GROUPS: Record<string, string[]> = {
  'Needs Call Back': ['Needs Call Back', 'call_back'],
  'Not Interested': ['Not interested', 'not_interested', 'Hang Up', 'Do Not Call'],
  'No Answer': ['No Answer', 'Left Voicemail', 'Busy', 'no_answer'],
  'Other': ['Other Departments', 'Not Qualified', 'Wrong Number', 'other_department', 'unable_to_service', 'wrong_number'],
}

const TOTAL_KEY = 'Total Calls'
const TOTAL_BOOKED_KEY = 'Total Booked'
const BOOKED_KEY = 'Booked Test'
const SINGLE_LEG_KEY = 'Single Leg'
const INBOUND_KEY = 'Inbound'
const OUTBOUND_KEY = 'Outbound'

const GROUP_COLORS: Record<string, string> = {
  [BOOKED_KEY]: '#22c55e',
  [SINGLE_LEG_KEY]: '#86efac',
  [TOTAL_BOOKED_KEY]: '#15803d',
  'Needs Call Back': '#f59e0b',
  'Not Interested': '#ef4444',
  'No Answer': '#3b82f6',
  'Other': '#94a3b8',
  [TOTAL_KEY]: '#111827',
  [INBOUND_KEY]: '#8b5cf6',
  [OUTBOUND_KEY]: '#0ea5e9',
}

function getGroup(disposition: string): string {
  if (SINGLE_LEG_DISPOSITIONS.has(disposition)) return SINGLE_LEG_KEY
  if (BOOKED_TEST_DISPOSITIONS.has(disposition)) return BOOKED_KEY
  for (const [group, values] of Object.entries(DISPOSITION_GROUPS)) {
    if (values.includes(disposition)) return group
  }
  return 'Other'
}

// Generate 30-min time slots from 6am to 8pm Perth time for a given date
function generateFixedSlots(dateStr: string): string[] {
  const slots: string[] = []
  const ref = new Date(dateStr)
  const perthDate = ref.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
  const [y, m, d] = perthDate.split('-').map(Number)

  for (let h = 6; h <= 20; h++) {
    for (let min = 0; min < 60; min += 30) {
      if (h === 20 && min > 0) break
      const utc = new Date(Date.UTC(y, m - 1, d, h - 8, min))
      slots.push(utc.toISOString())
    }
  }
  return slots
}

// Generate daily slots between two dates (inclusive)
function generateDailySlots(fromStr: string, toStr: string): string[] {
  const slots: string[] = []
  const from = new Date(fromStr + 'T12:00:00')
  const to = new Date(toStr + 'T12:00:00')
  const current = new Date(from)
  while (current <= to) {
    slots.push(current.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' }))
    current.setDate(current.getDate() + 1)
  }
  return slots
}

function getNowLabel(): string {
  return new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Perth',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function getPerthHourNow(): number {
  const now = new Date()
  const perthStr = now.toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Perth',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const [h, m] = perthStr.split(':').map(Number)
  return h + m / 60
}

function getPerthDateStr(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

const GROUP_ORDER = [TOTAL_BOOKED_KEY, BOOKED_KEY, SINGLE_LEG_KEY, 'Needs Call Back', 'No Answer', 'Not Interested', 'Other']

export default function CallTimelineChart({ chartCalls, dateFrom, dateTo, onDirectionChange }: CallTimelineChartProps) {
  const [directionFilter, setDirectionFilter] = useState<'' | 'INBOUND' | 'OUTBOUND'>('')
  const [nowLabel, setNowLabel] = useState(getNowLabel)
  const [nowHour, setNowHour] = useState(getPerthHourNow)
  useEffect(() => {
    const id = setInterval(() => {
      setNowLabel(getNowLabel())
      setNowHour(getPerthHourNow())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // Filter calls by direction if set
  const filteredCalls = useMemo(() => {
    if (!directionFilter) return chartCalls
    return chartCalls.filter((c) => c.callDirection === directionFilter)
  }, [chartCalls, directionFilter])

  // Determine if this is a multi-day range
  const isMultiDay = dateFrom && dateTo && dateFrom !== dateTo

  // === MULTI-DAY MODE: bucket calls by date ===
  const multiDayResult = useMemo(() => {
    if (!isMultiDay) return null

    const daySlots = generateDailySlots(dateFrom, dateTo)
    const activeGroups = new Set<string>()
    const buckets: Record<string, Record<string, number>> = {}
    for (const slot of daySlots) {
      buckets[slot] = {}
    }

    // Direction buckets from ALL calls (not filtered)
    const dirBuckets: Record<string, { inbound: number; outbound: number }> = {}
    for (const slot of daySlots) {
      dirBuckets[slot] = { inbound: 0, outbound: 0 }
    }

    for (const call of chartCalls) {
      const dayKey = getPerthDateStr(call.callStart)
      // Direction counts from full dataset
      if (!dirBuckets[dayKey]) dirBuckets[dayKey] = { inbound: 0, outbound: 0 }
      if (call.callDirection === 'INBOUND') dirBuckets[dayKey].inbound++
      else if (call.callDirection === 'OUTBOUND') dirBuckets[dayKey].outbound++
    }

    for (const call of filteredCalls) {
      const dayKey = getPerthDateStr(call.callStart)
      const group = getGroup(call.disposition)
      activeGroups.add(group)
      if (!buckets[dayKey]) buckets[dayKey] = {}
      buckets[dayKey][group] = (buckets[dayKey][group] || 0) + 1
    }

    // Add Total Booked as a computed group if any booking type exists
    if (activeGroups.has(BOOKED_KEY) || activeGroups.has(SINGLE_LEG_KEY)) {
      activeGroups.add(TOTAL_BOOKED_KEY)
    }

    const groups = GROUP_ORDER.filter((g) => activeGroups.has(g))
    const displayGroups = groups.length > 0 ? groups : GROUP_ORDER

    const chartData = daySlots.map((slot) => {
      const d = new Date(slot + 'T12:00:00')
      const label = d.toLocaleDateString('en-AU', {
        timeZone: 'Australia/Perth',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })

      const row: Record<string, string | number | null> = {
        time: slot,
        label,
      }
      let slotTotal = 0
      for (const group of displayGroups) {
        if (group === TOTAL_BOOKED_KEY) continue // computed below
        const val = buckets[slot]?.[group] || 0
        row[group] = val
        slotTotal += val
      }
      // Compute Total Booked = Booked Test + Single Leg
      if (displayGroups.includes(TOTAL_BOOKED_KEY)) {
        row[TOTAL_BOOKED_KEY] = (buckets[slot]?.[BOOKED_KEY] || 0) + (buckets[slot]?.[SINGLE_LEG_KEY] || 0)
      }
      row[TOTAL_KEY] = slotTotal
      row[INBOUND_KEY] = dirBuckets[slot]?.inbound || 0
      row[OUTBOUND_KEY] = dirBuckets[slot]?.outbound || 0
      return row
    })

    return { chartData, groups: displayGroups }
  }, [isMultiDay, dateFrom, dateTo, filteredCalls, chartCalls])

  // === SINGLE-DAY MODE: 30-min time slots ===
  const singleDayResult = useMemo(() => {
    if (isMultiDay) return null

    const refDate = filteredCalls.length > 0
      ? filteredCalls[0].callStart
      : new Date().toISOString()

    const slots = generateFixedSlots(refDate)
    const activeGroups = new Set<string>()
    const buckets: Record<string, Record<string, number>> = {}
    for (const slot of slots) {
      buckets[slot] = {}
    }

    // Direction buckets from ALL calls (not filtered)
    const dirBuckets: Record<string, { inbound: number; outbound: number }> = {}
    for (const slot of slots) {
      dirBuckets[slot] = { inbound: 0, outbound: 0 }
    }

    for (const call of chartCalls) {
      const callTime = new Date(call.callStart)
      const slotTime = new Date(callTime)
      slotTime.setMinutes(Math.floor(slotTime.getMinutes() / 30) * 30, 0, 0)
      const slotKey = slotTime.toISOString()
      if (!dirBuckets[slotKey]) dirBuckets[slotKey] = { inbound: 0, outbound: 0 }
      if (call.callDirection === 'INBOUND') dirBuckets[slotKey].inbound++
      else if (call.callDirection === 'OUTBOUND') dirBuckets[slotKey].outbound++
    }

    for (const call of filteredCalls) {
      const callTime = new Date(call.callStart)
      const slotTime = new Date(callTime)
      slotTime.setMinutes(Math.floor(slotTime.getMinutes() / 30) * 30, 0, 0)
      const slotKey = slotTime.toISOString()

      const group = getGroup(call.disposition)
      activeGroups.add(group)

      if (!buckets[slotKey]) buckets[slotKey] = {}
      buckets[slotKey][group] = (buckets[slotKey][group] || 0) + 1
    }

    // Add Total Booked as a computed group if any booking type exists
    if (activeGroups.has(BOOKED_KEY) || activeGroups.has(SINGLE_LEG_KEY)) {
      activeGroups.add(TOTAL_BOOKED_KEY)
    }

    const groups = GROUP_ORDER.filter((g) => activeGroups.has(g))
    const displayGroups = groups.length > 0 ? groups : GROUP_ORDER
    const currentPerthHour = getPerthHourNow()

    const chartData = slots.map((slot) => {
      const slotLabel = new Date(slot).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Perth',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
      const perthTime = new Date(slot).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Perth',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      const [sh, sm] = perthTime.split(':').map(Number)
      const slotHour = sh + sm / 60
      const isFuture = slotHour > currentPerthHour

      const row: Record<string, string | number | null> = {
        time: slot,
        label: slotLabel,
      }
      let slotTotal = 0
      for (const group of displayGroups) {
        if (group === TOTAL_BOOKED_KEY) continue // computed below
        const val = isFuture ? null : (buckets[slot]?.[group] || 0)
        row[group] = val
        if (typeof val === 'number') slotTotal += val
      }
      // Compute Total Booked = Booked Test + Single Leg
      if (displayGroups.includes(TOTAL_BOOKED_KEY)) {
        if (isFuture) {
          row[TOTAL_BOOKED_KEY] = null
        } else {
          row[TOTAL_BOOKED_KEY] = (buckets[slot]?.[BOOKED_KEY] || 0) + (buckets[slot]?.[SINGLE_LEG_KEY] || 0)
        }
      }
      row[TOTAL_KEY] = isFuture ? null : slotTotal
      row[INBOUND_KEY] = isFuture ? null : (dirBuckets[slot]?.inbound || 0)
      row[OUTBOUND_KEY] = isFuture ? null : (dirBuckets[slot]?.outbound || 0)
      return row
    })

    return { chartData, groups: displayGroups }
  }, [isMultiDay, filteredCalls, chartCalls, nowHour])

  const { chartData, groups } = isMultiDay ? multiDayResult! : singleDayResult!

  const [cumulative, setCumulative] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set(['No Answer', TOTAL_KEY, BOOKED_KEY, SINGLE_LEG_KEY]))

  // Build cumulative version of chart data (running totals)
  const displayData = useMemo(() => {
    if (!cumulative) return chartData
    const totals: Record<string, number> = {}
    return chartData.map((row) => {
      const cumRow: Record<string, string | number | null> = { time: row.time, label: row.label }
      for (const key of [...groups, TOTAL_KEY, INBOUND_KEY, OUTBOUND_KEY]) {
        if (row[key] === null) {
          cumRow[key] = null
        } else {
          totals[key] = (totals[key] || 0) + (row[key] as number || 0)
          cumRow[key] = totals[key]
        }
      }
      return cumRow
    })
  }, [chartData, groups, cumulative])

  const toggleGroup = (group: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  // "Now" reference line — only for single-day mode
  const nowRefLabel = useMemo(() => {
    if (isMultiDay || chartData.length === 0) return null
    let closest: string | null = null
    for (const row of chartData) {
      const perthTime = new Date(row.time as string).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Perth',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      const [sh, sm] = perthTime.split(':').map(Number)
      const slotHour = sh + sm / 60
      if (slotHour <= nowHour) closest = row.label as string
    }
    return closest
  }, [isMultiDay, chartData, nowHour])

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[#111827]">Call Outcomes Timeline</h3>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full border border-gray-300 overflow-hidden">
            {([['', 'All'], ['INBOUND', 'Inbound'], ['OUTBOUND', 'Outbound']] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => { setDirectionFilter(val as '' | 'INBOUND' | 'OUTBOUND'); onDirectionChange?.(val) }}
                className={`text-[11px] px-2.5 py-1 cursor-pointer transition-colors ${
                  directionFilter === val
                    ? 'bg-gray-900 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setCumulative((v) => !v)}
            className={`text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
              cumulative
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
            }`}
          >
            {cumulative ? 'Cumulative' : isMultiDay ? 'Per day' : 'Per interval'}
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={displayData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
          <defs>
            {groups.map((group) => (
              <linearGradient key={group} id={`gradient-${group.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GROUP_COLORS[group]} stopOpacity={0.3} />
                <stop offset="100%" stopColor={GROUP_COLORS[group]} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval="preserveStartEnd"
            minTickGap={isMultiDay ? 20 : 40}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
              padding: '8px 12px',
            }}
            labelStyle={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}
            itemSorter={(item) => {
              return GROUP_ORDER.indexOf(item.dataKey as string)
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any, name: any) => [String(value ?? 0), String(name ?? '')]) as any}
          />
          {groups.filter((g) => g !== TOTAL_BOOKED_KEY).map((group) => (
            <Area
              key={group}
              type="monotone"
              dataKey={group}
              stroke={hidden.has(group) ? 'transparent' : GROUP_COLORS[group]}
              strokeWidth={2}
              fill={hidden.has(group) ? 'transparent' : `url(#gradient-${group.replace(/\s/g, '')})`}
              dot={isMultiDay ? !hidden.has(group) : false}
              activeDot={hidden.has(group) ? false : { r: 3, strokeWidth: 0 }}
              hide={hidden.has(group)}
              connectNulls={false}
            />
          ))}
          {/* Total Booked — dashed aggregate line */}
          {groups.includes(TOTAL_BOOKED_KEY) && (
            <Area
              type="monotone"
              dataKey={TOTAL_BOOKED_KEY}
              stroke={hidden.has(TOTAL_BOOKED_KEY) ? 'transparent' : GROUP_COLORS[TOTAL_BOOKED_KEY]}
              strokeWidth={2}
              strokeDasharray="4 2"
              fill={hidden.has(TOTAL_BOOKED_KEY) ? 'transparent' : `url(#gradient-${TOTAL_BOOKED_KEY.replace(/\s/g, '')})`}
              dot={isMultiDay ? !hidden.has(TOTAL_BOOKED_KEY) : false}
              activeDot={hidden.has(TOTAL_BOOKED_KEY) ? false : { r: 3, strokeWidth: 0 }}
              hide={hidden.has(TOTAL_BOOKED_KEY)}
              connectNulls={false}
            />
          )}
          {/* Total Calls — dashed aggregate line */}
          <Area
            type="monotone"
            dataKey={TOTAL_KEY}
            stroke={hidden.has(TOTAL_KEY) ? 'transparent' : GROUP_COLORS[TOTAL_KEY]}
            strokeWidth={2}
            strokeDasharray="4 2"
            fill="none"
            dot={isMultiDay ? !hidden.has(TOTAL_KEY) : false}
            activeDot={hidden.has(TOTAL_KEY) ? false : { r: 3, strokeWidth: 0 }}
            hide={hidden.has(TOTAL_KEY)}
            connectNulls={false}
          />
          {/* Inbound / Outbound comparison lines */}
          <Area
            type="monotone"
            dataKey={INBOUND_KEY}
            stroke={hidden.has(INBOUND_KEY) ? 'transparent' : GROUP_COLORS[INBOUND_KEY]}
            strokeWidth={2}
            fill="none"
            dot={isMultiDay ? !hidden.has(INBOUND_KEY) : false}
            activeDot={hidden.has(INBOUND_KEY) ? false : { r: 3, strokeWidth: 0 }}
            hide={hidden.has(INBOUND_KEY)}
            connectNulls={false}
          />
          <Area
            type="monotone"
            dataKey={OUTBOUND_KEY}
            stroke={hidden.has(OUTBOUND_KEY) ? 'transparent' : GROUP_COLORS[OUTBOUND_KEY]}
            strokeWidth={2}
            fill="none"
            dot={isMultiDay ? !hidden.has(OUTBOUND_KEY) : false}
            activeDot={hidden.has(OUTBOUND_KEY) ? false : { r: 3, strokeWidth: 0 }}
            hide={hidden.has(OUTBOUND_KEY)}
            connectNulls={false}
          />
          {nowRefLabel && (
            <ReferenceLine
              x={nowRefLabel}
              stroke="#6b7280"
              strokeDasharray="4 3"
              strokeWidth={1}
              label={{
                value: 'Now',
                position: 'top',
                fill: '#6b7280',
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      {/* Legend (clickable to toggle) */}
      <div className="flex items-center gap-4 mt-2 justify-center">
        {[...groups, TOTAL_KEY, INBOUND_KEY, OUTBOUND_KEY].map((group) => (
          <button
            key={group}
            onClick={() => toggleGroup(group)}
            className="flex items-center gap-1.5 cursor-pointer"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-full transition-opacity"
              style={{
                backgroundColor: GROUP_COLORS[group],
                opacity: hidden.has(group) ? 0.25 : 1,
              }}
            />
            <span
              className="text-[11px] transition-opacity"
              style={{
                color: hidden.has(group) ? '#d1d5db' : '#6b7280',
                textDecoration: hidden.has(group) ? 'line-through' : 'none',
              }}
            >
              {group}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
