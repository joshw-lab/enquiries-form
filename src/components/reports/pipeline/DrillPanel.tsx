'use client'

import type { RegionPipelineData, CampaignSync } from '@/lib/dashboard-types'
import { ALL_BUCKET_COLORS, ALL_BUCKET_LABELS } from '@/lib/dashboard-types'

interface DrillPanelProps {
  data: RegionPipelineData
  syncCampaigns?: CampaignSync[]
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

function PipelineDetailColumn({
  title,
  titleClass,
  pipe,
  colors,
  labels,
  accentBg,
  accentBorder,
  accentColor,
}: {
  title: string
  titleClass: string
  pipe: RegionPipelineData['newPipeline']
  colors: readonly string[]
  labels: readonly string[]
  accentBg: string
  accentBorder: string
  accentColor: string
}) {
  const maxCount = Math.max(...pipe.bucketCounts, 1)
  const isOk = pipe.delta === 0

  return (
    <div className="px-5 py-4 border-r border-gray-100 last:border-r-0">
      <div className={`text-[10px] font-bold uppercase tracking-wider mb-3 pb-2 border-b ${titleClass}`}>
        {title}
      </div>

      {/* HS vs RX boxes */}
      <div className="flex gap-2.5 mb-3">
        <div className="flex-1 text-center p-2 rounded-lg" style={{ background: accentBg, border: `1px solid ${accentBorder}` }}>
          <div className="text-lg font-extrabold" style={{ color: accentColor }}>{pipe.hubspotCount.toLocaleString()}</div>
          <div className="text-[9px] text-gray-400 mt-0.5 uppercase tracking-wide">HubSpot</div>
        </div>
        <div className={`flex-1 text-center p-2 rounded-lg`} style={{
          background: isOk ? accentBg : '#fef2f2',
          border: `1px solid ${isOk ? accentBorder : '#fecaca'}`,
        }}>
          <div className="text-lg font-extrabold" style={{ color: isOk ? accentColor : '#dc2626' }}>
            {pipe.ringcxCount.toLocaleString()}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5 uppercase tracking-wide">
            RingCX {isOk ? '\u2713' : `\u2193${Math.abs(pipe.delta)}`}
          </div>
        </div>
      </div>

      {/* Bar rows */}
      {pipe.bucketCounts.map((v, i) => (
        <div key={i} className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-b-0">
          <div className="w-[52px] text-[11px] text-[#111827] font-medium">{labels[i]}</div>
          <div className="flex-1 bg-gray-100 rounded h-1.5 overflow-hidden">
            <div className="h-full rounded" style={{ width: `${Math.round((v / maxCount) * 100)}%`, background: colors[i] }} />
          </div>
          <div className="w-7 text-right text-[11px] font-bold" style={{ color: colors[i] }}>{v}</div>
        </div>
      ))}
    </div>
  )
}

export default function DrillPanel({ data, syncCampaigns, onClose }: DrillPanelProps) {
  const p72 = pct(data.calendar.slots72h.booked, data.calendar.slots72h.total)
  const open72 = data.calendar.slots72h.total - data.calendar.slots72h.booked
  const hotTier = data.tierMetrics.find((t) => t.tier === 'HOT')
  const totalCallsToday = data.tierMetrics.reduce((sum, t) => sum + t.newCallsToday, 0)
  const totalPasses = data.tierMetrics.reduce((sum, t) => sum + t.passes, 0)

  return (
    <div className="bg-white border border-blue-100 rounded-xl mb-5 overflow-hidden shadow-[0_4px_20px_rgba(37,99,235,0.08)]">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <span className="text-[13px] font-bold text-blue-800">{data.region} &mdash; Detail</span>
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
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
                  {i < 3 && (
                    <span className="text-[9px] bg-blue-50 text-blue-600 px-1 py-px rounded ml-1">72h</span>
                  )}
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
      </div>

      {/* Footer */}
      <div className="px-5 py-3.5 border-t border-gray-100 bg-[#fafafa] flex items-center justify-between gap-5">
        <div className="flex gap-5">
          <div className="flex flex-col">
            <span className="text-xl font-extrabold text-[#111827] leading-none">{data.totalContacts.toLocaleString()}</span>
            <span className="text-[10px] text-gray-600 mt-0.5">Total contacts</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xl font-extrabold text-red-500 leading-none">{hotTier?.totalActive ?? 0}</span>
            <span className="text-[10px] text-gray-600 mt-0.5">Hot leads (72h)</span>
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
        <div className={`py-2.5 px-3.5 rounded-lg text-xs leading-relaxed max-w-[360px] ${
          data.urgency === 'high'
            ? 'bg-orange-50 border border-orange-200 text-amber-900'
            : 'bg-green-50 border border-green-200 text-green-900'
        }`}>
          {data.urgency === 'high'
            ? `${open72} open slots in 72h \u00b7 ${hotTier?.totalActive ?? 0} hot leads active \u00b7 speed to lead ${data.avgResponseTime}`
            : `Calendar ${p72}% filled \u00b7 pipeline sustaining \u00b7 speed to lead ${data.avgResponseTime}`
          }
        </div>
      </div>
    </div>
  )
}
