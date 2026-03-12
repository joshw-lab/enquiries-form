'use client'

import type { SyncResponse } from '@/lib/dashboard-types'

interface SyncViewProps {
  data: SyncResponse | null
  onRefresh: () => void
}

export default function SyncView({ data, onRefresh }: SyncViewProps) {
  if (!data) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-500">
        Loading sync data...
      </div>
    )
  }

  const { campaigns, summary } = data

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-gray-200 flex items-center justify-between">
        <span className="text-sm font-semibold">Campaign Sync</span>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-gray-500">Polled just now</span>
          <button
            onClick={onRefresh}
            className="bg-gray-100 border border-gray-200 text-gray-600 rounded-md px-3 py-1 text-[11px] font-semibold cursor-pointer hover:bg-gray-200 transition-colors"
          >
            &#8635; Refresh
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-4 border-b border-gray-200">
        <div className="px-4 py-3.5 border-r border-gray-200">
          <div className="text-[11px] text-gray-600 mb-1">Campaigns</div>
          <div className="text-[22px] font-extrabold">{summary.totalCampaigns}</div>
        </div>
        <div className="px-4 py-3.5 border-r border-gray-200">
          <div className="text-[11px] text-gray-600 mb-1">In sync</div>
          <div className="text-[22px] font-extrabold text-green-600">{summary.inSync}</div>
        </div>
        <div className="px-4 py-3.5 border-r border-gray-200">
          <div className="text-[11px] text-gray-600 mb-1">Minor gaps</div>
          <div className="text-[22px] font-extrabold text-amber-600">{summary.minorGaps}</div>
        </div>
        <div className="px-4 py-3.5">
          <div className="text-[11px] text-gray-600 mb-1">Missing contacts</div>
          <div className="text-[22px] font-extrabold text-red-600">{summary.missingContacts}</div>
        </div>
      </div>

      {/* Table */}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {['Region', 'List', 'Campaign', 'HubSpot', 'RingCX', '\u0394', 'Status', 'Synced'].map((h) => (
              <th
                key={h}
                className="bg-gray-50 px-4 py-2.5 text-left text-[10px] font-bold text-gray-600 uppercase tracking-wide border-b border-gray-200"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c, i) => {
            const hasIssue = c.delta < 0
            const countClass = hasIssue ? 'text-red-600 font-semibold' : 'text-green-600 font-semibold'
            const deltaDisplay = c.delta < 0 ? `\u2193 ${Math.abs(c.delta)}` : '\u2014'
            const deltaClass = c.delta < 0 ? 'text-red-600 font-bold' : ''

            const statusClass =
              c.status === 'err' ? 'bg-red-100 text-red-600'
              : c.status === 'warn' ? 'bg-amber-100 text-amber-700'
              : 'bg-green-100 text-green-600'
            const statusText =
              c.status === 'err' ? 'Missing'
              : c.status === 'warn' ? 'Gap'
              : '\u2713'

            const listClass = c.listType === 'New'
              ? 'bg-blue-50 text-blue-600'
              : 'bg-purple-50 text-purple-600'

            return (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-xs border-b border-gray-100 font-bold text-[13px]">{c.region}</td>
                <td className="px-4 py-2.5 text-xs border-b border-gray-100">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${listClass}`}>{c.listType}</span>
                </td>
                <td className="px-4 py-2.5 text-[11px] border-b border-gray-100 text-gray-400 font-mono">{c.campaignId}</td>
                <td className={`px-4 py-2.5 text-xs border-b border-gray-100 ${countClass}`}>{c.hubspotCount.toLocaleString()}</td>
                <td className={`px-4 py-2.5 text-xs border-b border-gray-100 ${countClass}`}>{c.ringcxCount.toLocaleString()}</td>
                <td className={`px-4 py-2.5 text-xs border-b border-gray-100 ${deltaClass}`}>{deltaDisplay}</td>
                <td className="px-4 py-2.5 text-xs border-b border-gray-100">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${statusClass}`}>{statusText}</span>
                </td>
                <td className="px-4 py-2.5 text-[11px] border-b border-gray-100 text-gray-500">{c.lastSynced}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
