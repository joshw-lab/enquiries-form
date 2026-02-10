'use client'

import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { FormSubmission, getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'

interface DispositionChartProps {
  submissions: FormSubmission[]
}

export default function DispositionChart({ submissions }: DispositionChartProps) {
  const { chartData, dispositions } = useMemo(() => {
    if (submissions.length === 0) return { chartData: [], dispositions: [] }

    // Group by date and disposition
    const byDateDisp: Record<string, Record<string, number>> = {}
    const allDispositions = new Set<string>()

    for (const s of submissions) {
      const date = new Date(s.created_at).toISOString().split('T')[0]
      const disp = s.disposition || 'unknown'
      allDispositions.add(disp)

      if (!byDateDisp[date]) byDateDisp[date] = {}
      byDateDisp[date][disp] = (byDateDisp[date][disp] || 0) + 1
    }

    // Sort dates
    const sortedDates = Object.keys(byDateDisp).sort()
    const dispositions = Array.from(allDispositions).sort()

    // Build chart data
    const chartData = sortedDates.map((date) => {
      const row: Record<string, string | number> = {
        date: new Date(date + 'T12:00:00').toLocaleDateString('en-AU', {
          day: 'numeric',
          month: 'short',
        }),
      }
      for (const disp of dispositions) {
        row[disp] = byDateDisp[date][disp] || 0
      }
      return row
    })

    return { chartData, dispositions }
  }, [submissions])

  if (chartData.length === 0) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Daily Dispositions</h3>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any, name: any) => [String(value ?? 0), getDispositionLabel(String(name ?? ''))]) as any}
          />
          <Legend
            formatter={(value: string) => getDispositionLabel(value)}
            wrapperStyle={{ fontSize: 11 }}
          />
          {dispositions.map((disp) => (
            <Bar
              key={disp}
              dataKey={disp}
              stackId="a"
              fill={getDispositionColor(disp)}
              name={disp}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
