'use client'

import { FormSubmission, getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'

interface DispositionTableProps {
  submissions: FormSubmission[]
}

export default function DispositionTable({ submissions }: DispositionTableProps) {
  const total = submissions.length
  if (total === 0) return null

  // Count by disposition
  const counts: Record<string, number> = {}
  for (const s of submissions) {
    const d = s.disposition || 'unknown'
    counts[d] = (counts[d] || 0) + 1
  }

  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([disposition, count]) => ({
      disposition,
      label: getDispositionLabel(disposition),
      color: getDispositionColor(disposition),
      count,
      pct: Math.round((count / total) * 100),
    }))

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-900">Disposition Breakdown</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Disposition</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Count</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">%</th>
            <th className="px-4 py-2 text-xs font-medium text-gray-500 w-32"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.disposition} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-2 flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                  style={{ backgroundColor: row.color }}
                />
                {row.label}
              </td>
              <td className="text-right px-4 py-2 font-medium">{row.count}</td>
              <td className="text-right px-4 py-2 text-gray-500">{row.pct}%</td>
              <td className="px-4 py-2">
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${row.pct}%`, backgroundColor: row.color }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200">
            <td className="px-4 py-2 font-semibold text-gray-900">Total</td>
            <td className="text-right px-4 py-2 font-semibold">{total}</td>
            <td className="text-right px-4 py-2 text-gray-500">100%</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
