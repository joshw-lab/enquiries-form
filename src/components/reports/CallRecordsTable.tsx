'use client'

import { useState } from 'react'
import { FormSubmission, getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'

interface CallRecordsTableProps {
  submissions: FormSubmission[]
}

const PAGE_SIZE = 25

export default function CallRecordsTable({ submissions }: CallRecordsTableProps) {
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const totalPages = Math.ceil(submissions.length / PAGE_SIZE)
  const pageData = submissions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  if (submissions.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        No call records found for the selected filters.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Call Records ({submissions.length})
        </h3>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
            >
              Prev
            </button>
            <span className="text-gray-500">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Date/Time</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agent</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Contact</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Phone</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Disposition</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Notes</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((s) => {
              const fd = s.form_data || {}
              const agent = s.agent_name || '-'
              const contactName = s.contact?.name || `${(fd.firstName as string) || ''} ${(fd.lastName as string) || ''}`.trim() || '-'
              const phone = s.contact?.phone || (fd.phoneNumber as string) || '-'
              const disposition = s.disposition || (fd.disposition as string) || 'unknown'
              const notes = (fd.notes as string) || ''
              const timestamp = new Date(s.created_at).toLocaleString('en-AU', {
                timeZone: 'Australia/Perth',
                day: '2-digit',
                month: '2-digit',
                year: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              })
              const isExpanded = expandedId === s.id

              return (
                <tr
                  key={s.id}
                  className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : s.id)}
                >
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{timestamp}</td>
                  <td className="px-4 py-2">{agent}</td>
                  <td className="px-4 py-2">{contactName}</td>
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{phone}</td>
                  <td className="px-4 py-2">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: getDispositionColor(disposition) }}
                    >
                      {getDispositionLabel(disposition)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 max-w-xs truncate">
                    {notes || '-'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
