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
import { getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'

interface CallTimelineChartProps {
  chartCalls: ChartCall[]
}

// Group dispositions for cleaner chart lines
const DISPOSITION_GROUPS: Record<string, string[]> = {
  'Booked Test': ['Booked Test', 'book_water_test'],
  'Needs Call Back': ['Needs Call Back', 'call_back'],
  'Not Interested': ['Not interested', 'not_interested', 'Hang Up', 'Do Not Call'],
  'No Answer': ['No Answer', 'Left Voicemail', 'Busy', 'no_answer'],
  'Other': ['Other Departments', 'Not Qualified', 'Wrong Number', 'other_department', 'unable_to_service', 'wrong_number'],
}

const TOTAL_KEY = 'Total Calls'

const GROUP_COLORS: Record<string, string> = {
  'Booked Test': '#22c55e',
  'Needs Call Back': '#f59e0b',
  'Not Interested': '#ef4444',
  'No Answer': '#3b82f6',
  'Other': '#94a3b8',
  [TOTAL_KEY]: '#111827',
}

function getGroup(disposition: string): string {
  for (const [group, values] of Object.entries(DISPOSITION_GROUPS)) {
    if (values.includes(disposition)) return group
  }
  return 'Other'
}

// Generate 30-min time slots from 6am to 8pm Perth time for a given date
function generateFixedSlots(dateStr: string): string[] {
  const slots: string[] = []
  // Parse any date from the calls to get the correct calendar day in Perth
  const ref = new Date(dateStr)
  // Get Perth date string (YYYY-MM-DD)
  const perthDate = ref.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
  const [y, m, d] = perthDate.split('-').map(Number)

  // Build slots from 06:00 to 20:00 Perth time
  // Perth is UTC+8, so 06:00 AWST = 22:00 UTC previous day
  for (let h = 6; h <= 20; h++) {
    for (let min = 0; min < 60; min += 30) {
      if (h === 20 && min > 0) break // stop at 20:00
      const utc = new Date(Date.UTC(y, m - 1, d, h - 8, min))
      slots.push(utc.toISOString())
    }
  }
  return slots
}

// Get current time label in Perth timezone
function getNowLabel(): string {
  return new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Perth',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

// Get current Perth hour as a number (e.g. 14.5 for 2:30pm)
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

export default function CallTimelineChart({ chartCalls }: CallTimelineChartProps) {
  // Track current time for the "now" indicator — update every minute
  const [nowLabel, setNowLabel] = useState(getNowLabel)
  const [nowHour, setNowHour] = useState(getPerthHourNow)
  useEffect(() => {
    const id = setInterval(() => {
      setNowLabel(getNowLabel())
      setNowHour(getPerthHourNow())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  const { chartData, groups } = useMemo(() => {
    // Use today in Perth as default if no calls
    const refDate = chartCalls.length > 0
      ? chartCalls[0].callStart
      : new Date().toISOString()

    // Generate fixed 6am–8pm slots
    const slots = generateFixedSlots(refDate)

    // Track which groups appear in the data
    const activeGroups = new Set<string>()

    // Bucket calls into 30-min slots by disposition group
    const buckets: Record<string, Record<string, number>> = {}
    for (const slot of slots) {
      buckets[slot] = {}
    }

    for (const call of chartCalls) {
      const callTime = new Date(call.callStart)
      // Find the slot this call belongs to
      const slotTime = new Date(callTime)
      slotTime.setMinutes(Math.floor(slotTime.getMinutes() / 30) * 30, 0, 0)
      const slotKey = slotTime.toISOString()

      const group = getGroup(call.disposition)
      activeGroups.add(group)

      if (!buckets[slotKey]) buckets[slotKey] = {}
      buckets[slotKey][group] = (buckets[slotKey][group] || 0) + 1
    }

    // Order groups: Booked first (green on top), then others
    const groupOrder = ['Booked Test', 'Needs Call Back', 'No Answer', 'Not Interested', 'Other']
    const groups = groupOrder.filter((g) => activeGroups.has(g))
    // If no calls yet, still show all default groups so chart renders
    const displayGroups = groups.length > 0 ? groups : groupOrder

    // Current time boundary — slots after "now" should have no data
    const currentPerthHour = getPerthHourNow()

    // Build chart data — only populate slots up to current time
    const chartData = slots.map((slot) => {
      const slotLabel = new Date(slot).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Perth',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
      // Get Perth hour for this slot
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
        // Future slots get null so lines stop at current time
        const val = isFuture ? null : (buckets[slot]?.[group] || 0)
        row[group] = val
        if (typeof val === 'number') slotTotal += val
      }
      row[TOTAL_KEY] = isFuture ? null : slotTotal
      return row
    })

    return { chartData, groups: displayGroups }
  }, [chartCalls, nowHour])

  const [cumulative, setCumulative] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set(['No Answer', TOTAL_KEY]))

  // Build cumulative version of chart data (running totals)
  const displayData = useMemo(() => {
    if (!cumulative) return chartData
    const totals: Record<string, number> = {}
    return chartData.map((row) => {
      const cumRow: Record<string, string | number | null> = { time: row.time, label: row.label }
      for (const key of [...groups, TOTAL_KEY]) {
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

  // Find the closest slot label to current time for the ReferenceLine
  const nowRefLabel = useMemo(() => {
    if (chartData.length === 0) return null
    // Find the last slot that is at or before current time
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
  }, [chartData, nowHour])

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[#111827]">Call Outcomes Timeline</h3>
        <button
          onClick={() => setCumulative((v) => !v)}
          className={`text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
            cumulative
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
          }`}
        >
          {cumulative ? 'Cumulative' : 'Per interval'}
        </button>
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
            minTickGap={40}
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
              const order = ['Booked Test', 'Needs Call Back', 'No Answer', 'Not Interested', 'Other']
              return order.indexOf(item.dataKey as string)
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any, name: any) => [String(value ?? 0), String(name ?? '')]) as any}
          />
          {groups.map((group) => (
            <Area
              key={group}
              type="monotone"
              dataKey={group}
              stroke={hidden.has(group) ? 'transparent' : GROUP_COLORS[group]}
              strokeWidth={2}
              fill={hidden.has(group) ? 'transparent' : `url(#gradient-${group.replace(/\s/g, '')})`}
              dot={false}
              activeDot={hidden.has(group) ? false : { r: 3, strokeWidth: 0 }}
              hide={hidden.has(group)}
              connectNulls={false}
            />
          ))}
          <Area
            type="monotone"
            dataKey={TOTAL_KEY}
            stroke={hidden.has(TOTAL_KEY) ? 'transparent' : GROUP_COLORS[TOTAL_KEY]}
            strokeWidth={2}
            strokeDasharray="4 2"
            fill="none"
            dot={false}
            activeDot={hidden.has(TOTAL_KEY) ? false : { r: 3, strokeWidth: 0 }}
            hide={hidden.has(TOTAL_KEY)}
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
        {[...groups, TOTAL_KEY].map((group) => (
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
