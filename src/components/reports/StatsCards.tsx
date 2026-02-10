'use client'

import { FormSubmission, getDispositionLabel } from '@/lib/reports-queries'

interface StatsCardsProps {
  submissions: FormSubmission[]
  startDate: string
  endDate: string
}

export default function StatsCards({ submissions, startDate, endDate }: StatsCardsProps) {
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

  const cards = [
    { label: 'Total Calls', value: total, color: 'text-gray-900' },
    { label: 'Booked Tests', value: bookings, color: 'text-green-600' },
    { label: 'No Answer', value: noAnswer, color: 'text-blue-600' },
    { label: 'Not Interested', value: notInterested, color: 'text-red-600' },
    ...(avgPerDay > 0
      ? [{ label: 'Avg / Day', value: avgPerDay, color: 'text-purple-600' }]
      : []),
    ...(topDisp
      ? [{ label: 'Top Disposition', value: `${getDispositionLabel(topDisp[0])} (${topDisp[1]})`, color: 'text-amber-600' }]
      : []),
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <p className="text-xs font-medium text-gray-500">{card.label}</p>
          <p className={`text-2xl font-bold mt-1 ${card.color}`}>{card.value}</p>
        </div>
      ))}
    </div>
  )
}
