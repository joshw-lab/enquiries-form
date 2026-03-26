'use client'

import type { RegionPipelineData, CampaignSync, TodayLead } from '@/lib/dashboard-types'
import { ALL_BUCKET_COLORS, ALL_BUCKET_LABELS } from '@/lib/dashboard-types'

interface DrillPanelProps {
  data: RegionPipelineData
  syncCampaigns?: CampaignSync[]
  todayLeads?: TodayLead[]
  onClose: () => void
}

function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round((a / b) * 100)
}

function slotColor(p: number): string {
  if (p < 30) return '#ef4444'
  if (p < 60) return '#f59e0b'
  return '#10b981'
}

function respClass(hours: number): string {
  if (hours < 3) return 'text-green-600'
  if (hours < 6) return 'text-amber-600'
  return 'text-red-600'
}

function formatSpeed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hrs = seconds / 3600
  if (hrs < 24) return `${hrs.toFixed(1)}h`
  const days = Math.floor(hrs / 24)
  return `${days}d ${Math.round(hrs % 24)}h`
}

function speedColor(seconds: number): string {
  const hrs = seconds / 3600
  if (hrs < 1) return 'text-green-600'
  if (hrs < 3) return 'text-amber-600'
  return 'text-red-600'
}

function timeAgo(isoStr: string): string {
  const now = new Date()
  const then = new Date(isoStr)
  const diffMs = now.getTime() - then.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function DrillPanel({ data, syncCampaigns, todayLeads, onClose }: DrillPanelProps) {
  const p72 = pct(data.calendar.slots72h.booked, data.calendar.slots72h.total)
  const open72 = data.calendar.slots72h.total - data.calendar.slots72h.booked
  const hotTier = data.tierMetrics.find((t) => t.tier === 'HOT')
  const totalCallsToday = data.tierMetrics.reduce((sum, t) => sum + t.newCallsToday, 0)
  const totalPasses = data.tierMetrics.reduce((sum, t) => sum + t.passes, 0)

  const leads = todayLeads ?? []
  const calledLeads = leads.filter((l) => l.speedToLeadSeconds !== null)
  const uncalledLeads = leads.filter((l) => l.speedToLeadSeconds === null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Modal */}
      <div
        className="relative bg-white rounded-xl overflow-hidden shadow-2xl w-[90vw] max-w-[1060px] max-h-[90vh] overflow-y-auto"
      >
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white z-10">
        <span className="text-[13px] font-bold text-blue-800">{data.region} &mdash; Detail</span>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded border border-gray-200 bg-white cursor-pointer text-xs flex items-center justify-center text-gray-400 hover:text-gray-600"
        >
          &#10005;
        </button>
      </div>

      {/* 3-column body */}
      <div className="grid grid-cols-3">
        {/* Column 1: Calendar */}
        <div className="px-5 py-4 border-r border-gray-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-3 pb-2 border-b border-gray-100">
            Calendar &middot; Next 7 days
          </div>
          {data.calendar.daily.map((slot, i) => {
            const p = pct(slot.booked, slot.total)
            const col = slotColor(p)
            const openSlots = slot.total - slot.booked
            return (
              <div key={i} className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-b-0">
                <div className="w-[52px] text-[11px] text-[#111827]">
                  {slot.day}
                </div>
                <div className="flex-1 bg-gray-100 rounded h-1.5 overflow-hidden">
                  <div className="h-full rounded" style={{ width: `${p}%`, background: col }} />
                </div>
                <div className="text-[11px] font-bold min-w-[38px] text-right" style={{ color: col }}>
                  {slot.booked}/{slot.total}
                </div>
                <div className="text-[10px] text-gray-500 min-w-[38px] text-right">{openSlots} open</div>
              </div>
            )
          })}
        </div>

        {/* Column 2: Pipeline age breakdown */}
        <div className="px-5 py-4 border-r border-gray-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600 mb-3 pb-2 border-b border-blue-100">
            Pipeline
          </div>

          {/* Sync counts from sync_counts table */}
          {syncCampaigns && syncCampaigns.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-3">
              {syncCampaigns.map((sc) => {
                const diff = sc.hubspotCount - sc.ringcxCount
                const isOk = sc.ringcxCount >= 0 && diff === 0
                return (
                  <div key={sc.campaignId} className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold w-7 ${sc.listType === 'New' ? 'text-blue-600' : 'text-purple-600'}`}>
                      {sc.listType === 'New' ? 'NEW' : 'OLD'}
                    </span>
                    <div className="flex-1 flex items-center gap-1.5">
                      <div className="flex-1 text-center py-1.5 rounded" style={{ background: '#f0f9ff', border: '1px solid #e0f2fe' }}>
                        <div className="text-sm font-bold text-sky-700">HS {sc.hubspotCount.toLocaleString()}</div>
                      </div>
                      <div className={`flex-1 text-center py-1.5 rounded`} style={{
                        background: isOk ? '#f0fdf4' : '#fef2f2',
                        border: `1px solid ${isOk ? '#bbf7d0' : '#fecaca'}`,
                      }}>
                        <div className={`text-sm font-bold ${isOk ? 'text-green-700' : 'text-red-600'}`}>
                          RC {sc.ringcxCount >= 0 ? sc.ringcxCount.toLocaleString() : '—'}
                        </div>
                      </div>
                    </div>
                    {isOk ? (
                      <span className="text-green-600 font-bold text-xs">{'\u2713'}</span>
                    ) : diff !== 0 ? (
                      <span className={`text-xs font-bold ${diff > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                        {diff > 0 ? `-${diff}` : `+${Math.abs(diff)}`}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          {/* Bar rows */}
          {data.newPipeline.bucketCounts.map((v, i) => (
            <div key={i} className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-b-0">
              <div className="w-[52px] text-[11px] text-[#111827] font-medium">{ALL_BUCKET_LABELS[i]}</div>
              <div className="flex-1 bg-gray-100 rounded h-1.5 overflow-hidden">
                <div className="h-full rounded" style={{ width: `${Math.round((v / Math.max(...data.newPipeline.bucketCounts, 1)) * 100)}%`, background: ALL_BUCKET_COLORS[i] }} />
              </div>
              <div className="w-7 text-right text-[11px] font-bold" style={{ color: ALL_BUCKET_COLORS[i] }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Column 3: Today's new leads with speed-to-lead */}
        <div className="px-5 py-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 mb-3 pb-2 border-b border-emerald-100">
            Today&apos;s Leads &middot; {leads.length} added
          </div>

          {leads.length === 0 ? (
            <div className="text-[11px] text-gray-400 py-4 text-center">No leads added today</div>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-[320px] overflow-y-auto">
              {/* Awaiting call first */}
              {uncalledLeads.map((lead) => (
                <div key={lead.contactId} className="flex items-center gap-2 py-1.5 border-b border-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-[#111827] font-medium truncate">{lead.name}</div>
                    <div className="text-[10px] text-gray-400">{lead.postcode} &middot; {timeAgo(lead.loadedAt)}</div>
                  </div>
                  <div className="text-[10px] text-gray-300 whitespace-nowrap">
                    awaiting call
                  </div>
                </div>
              ))}
              {/* Called leads, most recent call first */}
              {calledLeads
                .sort((a, b) => new Date(b.firstCallAt!).getTime() - new Date(a.firstCallAt!).getTime())
                .map((lead) => (
                  <div key={lead.contactId} className="flex items-center gap-2 py-1.5 border-b border-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-[#111827] font-medium truncate">{lead.name}</div>
                      <div className="text-[10px] text-gray-400">{lead.postcode} &middot; {timeAgo(lead.loadedAt)}</div>
                    </div>
                    <div className={`text-[11px] font-bold whitespace-nowrap ${speedColor(lead.speedToLeadSeconds!)}`}>
                      &#9889; {formatSpeed(lead.speedToLeadSeconds!)}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer stats */}
      <div className="px-5 py-3.5 border-t border-gray-100 bg-[#fafafa] flex items-center gap-5">
        <div className="flex flex-col">
          <span className="text-xl font-extrabold text-[#111827] leading-none">{data.totalContacts.toLocaleString()}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Total contacts</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-extrabold text-red-500 leading-none">{hotTier?.totalActive ?? 0}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Hot leads</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-extrabold text-blue-600 leading-none">{totalCallsToday}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Calls today</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-extrabold text-gray-700 leading-none">{totalPasses}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Total passes</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-extrabold leading-none" style={{ color: slotColor(p72) }}>{open72}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Open 72h slots</span>
        </div>
        <div className="flex flex-col">
          <span className={`text-xl font-extrabold leading-none ${respClass(data.avgResponseHours)}`}>{data.avgResponseTime}</span>
          <span className="text-[10px] text-gray-600 mt-0.5">Speed to lead</span>
        </div>
      </div>

      </div>
    </div>
  )
}
