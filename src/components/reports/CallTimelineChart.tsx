'use client'

import { useMemo, useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
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

const GROUP_COLORS: Record<string, string> = {
  'Booked Test': '#22c55e',
  'Needs Call Back': '#f59e0b',
  'Not Interested': '#ef4444',
  'No Answer': '#3b82f6',
  'Other': '#94a3b8',
}

function getGroup(disposition: string): string {
  for (const [group, values] of Object.entries(DISPOSITION_GROUPS)) {
    if (values.includes(disposition)) return group
  }
  return 'Other'
}

// Generate 30-min time slots for a full day
function generateSlots(from: string, to: string): string[] {
  const slots: string[] = []
  // Parse the earliest and latest call times to determine range
  const start = new Date(from)
  const end = new Date(to)

  // Round start down to nearest 30 min
  start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0)
  // Round end up to nearest 30 min
  end.setMinutes(Math.ceil(end.getMinutes() / 30) * 30, 0, 0)

  const cursor = new Date(start)
  while (cursor <= end) {
    slots.push(cursor.toISOString())
    cursor.setMinutes(cursor.getMinutes() + 30)
  }
  return slots
}

export default function CallTimelineChart({ chartCalls }: CallTimelineChartProps) {
  const { chartData, groups } = useMemo(() => {
    if (chartCalls.length === 0) return { chartData: [], groups: [] }

    // Sort calls by time
    const sorted = [...chartCalls].sort((a, b) => a.callStart.localeCompare(b.callStart))

    // Generate time slots spanning the data range
    const slots = generateSlots(sorted[0].callStart, sorted[sorted.length - 1].callStart)

    // Track which groups appear in the data
    const activeGroups = new Set<string>()

    // Bucket calls into 30-min slots by disposition group
    const buckets: Record<string, Record<string, number>> = {}
    for (const slot of slots) {
      buckets[slot] = {}
    }

    for (const call of sorted) {
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

    // Build chart data
    const chartData = slots.map((slot) => {
      const row: Record<string, string | number> = {
        time: slot,
        label: new Date(slot).toLocaleTimeString('en-AU', {
          timeZone: 'Australia/Perth',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
      }
      for (const group of groups) {
        row[group] = buckets[slot]?.[group] || 0
      }
      return row
    })

    return { chartData, groups }
  }, [chartCalls])

  const [hidden, setHidden] = useState<Set<string>>(new Set(['No Answer']))

  const toggleGroup = (group: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  if (chartData.length === 0) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <h3 className="text-sm font-semibold text-[#111827] mb-3">Call Outcomes Timeline</h3>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
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
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {/* Legend (clickable to toggle) */}
      <div className="flex items-center gap-4 mt-2 justify-center">
        {groups.map((group) => (
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
