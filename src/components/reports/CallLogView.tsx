'use client'

import { useState, useEffect, useCallback } from 'react'
import type { CallLogEntry, CallLogResponse } from '@/lib/dashboard-types'
import { getDispositionLabel, getDispositionColor } from '@/lib/reports-queries'
import CallLogFilters, { type CallLogFilterState } from './CallLogFilters'

const HUBSPOT_PORTAL_ID = '5877625'
const PAGE_SIZES = [25, 50, 100]

function perthDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

export default function CallLogView() {
  const [records, setRecords] = useState<CallLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [dispositions, setDispositions] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)

  // Default: last 7 days
  const [filters, setFilters] = useState<CallLogFilterState>(() => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - 7)
    return {
      from: perthDate(start),
      to: perthDate(end),
      operator: '',
      region: '',
      disposition: '',
      phone: '',
    }
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')

    const params = new URLSearchParams()
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    if (filters.operator) params.set('operator', filters.operator)
    if (filters.region) params.set('region', filters.region)
    if (filters.disposition) params.set('disposition', filters.disposition)
    if (filters.phone) params.set('phone', filters.phone)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))

    try {
      const res = await fetch(`/api/calllog?${params}`)
      if (!res.ok) throw new Error(`Failed to fetch (${res.status})`)
      const data: CallLogResponse = await res.json()
      setRecords(data.records)
      setTotal(data.total)

      // Extract agent and disposition lists for filters
      const agentSet = new Set<string>()
      const dispSet = new Set<string>()
      for (const r of data.records) {
        if (r.agent && r.agent !== 'Unknown') agentSet.add(r.agent)
        if (r.disposition && r.disposition !== 'unknown') dispSet.add(r.disposition)
      }
      setAgents((prev) => {
        const merged = new Set([...prev, ...agentSet])
        return Array.from(merged).sort()
      })
      setDispositions((prev) => {
        const merged = new Set([...prev, ...dispSet])
        return Array.from(merged).sort()
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [filters, page, pageSize])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Reset to page 1 when filters change
  function handleFilterChange(newFilters: CallLogFilterState) {
    setFilters(newFilters)
    setPage(1)
  }

  const totalPages = Math.ceil(total / pageSize)

  // CSV export
  async function handleExport() {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (filters.from) params.set('from', filters.from)
      if (filters.to) params.set('to', filters.to)
      if (filters.operator) params.set('operator', filters.operator)
      if (filters.region) params.set('region', filters.region)
      if (filters.disposition) params.set('disposition', filters.disposition)
      if (filters.phone) params.set('phone', filters.phone)
      params.set('pageSize', 'all')

      const res = await fetch(`/api/calllog?${params}`)
      if (!res.ok) throw new Error('Export failed')
      const data: CallLogResponse = await res.json()

      // Generate CSV
      const headers = ['Date/Time', 'Agent', 'Contact', 'Phone', 'Region', 'Disposition', 'Notes']
      const rows = data.records.map((r) => [
        new Date(r.timestamp).toLocaleString('en-AU', { timeZone: 'Australia/Perth' }),
        r.agent,
        r.contactName,
        r.phone,
        r.region,
        getDispositionLabel(r.disposition),
        r.notes.replace(/"/g, '""'),
      ])

      const csv = [
        headers.join(','),
        ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
      ].join('\n')

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `call-log-${filters.from || 'all'}-to-${filters.to || 'all'}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) {
      alert('Export failed: ' + (e instanceof Error ? e.message : 'Unknown error'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Filter bar */}
      <div className="px-5 py-4 border-b border-gray-200">
        <CallLogFilters
          filters={filters}
          agents={agents}
          dispositions={dispositions}
          onChange={handleFilterChange}
        />
      </div>

      {/* Table header with pagination */}
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[#111827]">
            Call Records ({total.toLocaleString()})
          </h3>
          <button
            onClick={handleExport}
            disabled={exporting || total === 0}
            className="text-[11px] font-medium text-blue-600 hover:text-blue-700 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {/* Page size selector */}
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span>Rows:</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
              className="border border-gray-200 rounded px-1.5 py-0.5 text-[11px] bg-white"
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Prev
              </button>
              <span className="text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      {error ? (
        <div className="px-5 py-8 text-center text-sm text-red-600">{error}</div>
      ) : loading ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500">Loading call records...</div>
      ) : records.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500">No call records found for the selected filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                {['Date/Time', 'Agent', 'Contact', 'Phone', 'Region', 'Disposition', 'Notes', 'HubSpot'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-xs font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const timestamp = new Date(r.timestamp).toLocaleString('en-AU', {
                  timeZone: 'Australia/Perth',
                  day: '2-digit', month: '2-digit', year: '2-digit',
                  hour: '2-digit', minute: '2-digit', hour12: true,
                })

                const hubspotUrl = r.hubspotContactId
                  ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${r.hubspotContactId}`
                  : null

                return (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{timestamp}</td>
                    <td className="px-4 py-2">{r.agent}</td>
                    <td className="px-4 py-2">{r.contactName}</td>
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{r.phone}</td>
                    <td className="px-4 py-2 text-gray-600">{r.region || '-'}</td>
                    <td className="px-4 py-2">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                        style={{ backgroundColor: getDispositionColor(r.disposition) }}
                      >
                        {getDispositionLabel(r.disposition)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 max-w-xs truncate" title={r.notes || undefined}>
                      {r.notes || '-'}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {hubspotUrl ? (
                        <a
                          href={hubspotUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-green-700"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Synced
                        </a>
                      ) : (
                        <span className="text-[10px] text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
