'use client'

import { FormSubmission, getDispositionLabel, type DialStats } from '@/lib/reports-queries'

export interface StatsCardFilter {
  label: string
  disposition?: string
}

interface StatsCardsProps {
  submissions: FormSubmission[]
  startDate: string
  endDate: string
  dialStats?: DialStats | null
  onCardClick?: (filter: StatsCardFilter) => void
}

export default function StatsCards({ submissions, startDate, endDate, dialStats, onCardClick }: StatsCardsProps) {
  const total = submissions.length

  const bookings = submissions.filter(
    (s) => s.disposition === 'book_water_test'
  ).length

  const noAnswer = submissions.filter(
    (s) => s.disposition === 'no_answer'
  ).length

  const notInterested = submissions.filter(
    (s) => s.disposition === 'not_interested'
  ).length

  // Calculate date range days for avg
  let avgPerDay = 0
  if (startDate && endDate) {
    const days = Math.max(1, Math.ceil(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
    ) + 1)
    avgPerDay = Math.round((total / days) * 10) / 10
  }

  // Top disposition
  const dispCounts: Record<string, number> = {}
  for (const s of submissions) {
    const d = s.disposition || 'unknown'
    dispCounts[d] = (dispCounts[d] || 0) + 1
  }
  const topDisp = Object.entries(dispCounts).sort((a, b) => b[1] - a[1])[0]

  const cards: Array<{
    label: string
    value: string | number
    color: string
    clickFilter?: StatsCardFilter
  }> = [
    ...(dialStats
      ? [{ label: 'Outbound Dials', value: dialStats.totalOutboundDials, color: 'text-indigo-600' }]
      : []),
    { label: 'Dispositions', value: total, color: 'text-gray-900', clickFilter: { label: 'All Calls' } },
    { label: 'Booked Tests', value: bookings, color: 'text-green-600', clickFilter: { label: 'Booked Tests', disposition: 'book_water_test' } },
    { label: 'No Answer', value: noAnswer, color: 'text-blue-600', clickFilter: { label: 'No Answer', disposition: 'no_answer' } },
    { label: 'Not Interested', value: notInterested, color: 'text-red-600', clickFilter: { label: 'Not Interested', disposition: 'not_interested' } },
    ...(avgPerDay > 0
      ? [{ label: 'Avg / Day', value: avgPerDay, color: 'text-purple-600' }]
      : []),
    ...(topDisp
      ? [{
          label: 'Top Disposition',
          value: `${getDispositionLabel(topDisp[0])} (${topDisp[1]})`,
          color: 'text-amber-600',
          clickFilter: { label: getDispositionLabel(topDisp[0]), disposition: topDisp[0] },
        }]
      : []),
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`bg-white rounded-lg shadow-sm border border-gray-200 p-4 transition-colors ${
            card.clickFilter && onCardClick
              ? 'cursor-pointer hover:border-blue-300 hover:shadow-md'
              : ''
          }`}
          onClick={() => card.clickFilter && onCardClick?.(card.clickFilter)}
        >
          <p className="text-xs font-medium text-gray-500">{card.label}</p>
          <p className={`text-2xl font-bold mt-1 ${card.color}`}>{card.value}</p>
        </div>
      ))}
    </div>
  )
}
