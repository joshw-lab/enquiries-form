'use client'

import type { RegionPipelineData, ServiceAreaCalendar, CampaignSync } from '@/lib/dashboard-types'
import {
  ALL_BUCKET_COLORS,
  ALL_BUCKET_LABELS,
} from '@/lib/dashboard-types'

interface RegionCardProps {
  data: RegionPipelineData & { serviceAreaCalendars?: ServiceAreaCalendar[] }
  syncCampaigns?: CampaignSync[]
  isSelected: boolean
  onClick: () => void
}

function Tip({ text }: { text: string }) {
  return (
    <span className="relative group/tip cursor-help">
      <svg className="w-3 h-3 text-gray-400 inline-block ml-0.5 -mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
        <path strokeLinecap="round" strokeWidth="1.5" d="M12 16v-4m0-4h.01" />
      </svg>
      <span className="invisible group-hover/tip:visible absolute z-[9999] bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-[10px] font-normal normal-case tracking-normal text-white bg-gray-900 rounded-md shadow-lg max-w-[220px] whitespace-normal text-center pointer-events-none">
        {text}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
      </span>
    </span>
  )
}

const BUCKET_TOOLTIPS = [
  'Under 24 hours since lead_date — HOT tier, highest priority',
  '1–3 days old — still in HOT tier (first 72 hours)',
  '3–7 days old — transitioned from HOT to NEW tier',
  '7–30 days old — NEW tier, active dialling',
  '30–45 days old — NEW tier, approaching aged threshold',
  '45–60 days old — NEW tier, nearing 90-day aging boundary',
  '60–90 days old — NEW tier, will move to OLD campaign at 90 days',
  '90+ days old — moved to OLD/Aged campaign by aging cron',
]

function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round((a / b) * 100)
}

function calFillClass(p: number): string {
  if (p < 30) return 'bg-red-500'
  if (p < 60) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function calColor(p: number): string {
  if (p < 30) return '#dc2626'
  if (p < 60) return '#d97706'
  return '#16a34a'
}

function respClass(hours: number): string {
  if (hours < 3) return 'text-green-600'
  if (hours < 6) return 'text-amber-600'
  return 'text-red-600'
}

export default function RegionCard({ data, syncCampaigns, isSelected, onClick }: RegionCardProps) {
  // Unified 8-bucket array (API now returns all 8 buckets in each pipeline)
  const allBuckets = data.newPipeline.bucketCounts
  const total = allBuckets.reduce((a, b) => a + b, 0)
  const pcts = allBuckets.map((v) => pct(v, total))

  const p72 = pct(data.calendar.slots72h.booked, data.calendar.slots72h.total)
  const p7 = pct(data.calendar.slots7d.booked, data.calendar.slots7d.total)
  const open72 = data.calendar.slots72h.total - data.calendar.slots72h.booked
  const open7 = data.calendar.slots7d.total - data.calendar.slots7d.booked

  const urgClass =
    data.urgency === 'high' ? 'bg-red-100 text-red-600'
    : data.urgency === 'med' ? 'bg-amber-100 text-amber-700'
    : 'bg-green-100 text-green-600'
  const urgText =
    data.urgency === 'high' ? 'Dial now'
    : data.urgency === 'med' ? 'Monitor'
    : 'On track'

  const statusDot =
    data.status === 'urgent' ? 'bg-red-500'
    : data.status === 'warn' ? 'bg-amber-500'
    : 'bg-emerald-500'

  const borderColor =
    data.status === 'urgent' ? '#fca5a5'
    : data.status === 'warn' ? '#fcd34d'
    : '#86efac'

  return (
    <div
      className={`bg-white border border-gray-200 rounded-xl cursor-pointer flex flex-col transition-shadow hover:shadow-md ${
        isSelected ? 'border-blue-500 shadow-[0_0_0_3px_rgba(37,99,235,0.08)]' : ''
      }`}
      style={{ borderLeft: `3px solid ${borderColor}` }}
      onClick={onClick}
    >
      {/* Header */}
      <div className="px-3 py-2.5 flex items-start justify-between border-b border-gray-100">
        <div className="flex flex-col gap-0.5">
          <span className="text-lg font-extrabold text-[#111827] tracking-tight leading-none">{data.region}</span>
          <span className="text-[11px] text-gray-500">{data.totalContacts.toLocaleString()} contacts</span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className={`w-2 h-2 rounded-full mt-0.5 ${statusDot}`} />
          <div className="flex items-center gap-1 text-[11px] text-gray-600" title="Today's avg time from lead loaded to first call">
            <span>speed&nbsp;to&nbsp;lead:</span>
            <span className={`text-[12px] font-bold ${respClass(data.avgResponseHours)}`}>{data.avgResponseTime}</span>
          </div>
        </div>
      </div>

      {/* Tier metrics table */}
      <div className="px-3 py-2">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-gray-500 text-right">
              <th className="text-left font-medium pb-1"></th>
              <th className="font-medium pb-1 px-1">Active<Tip text="Leads loaded in the RingCX dialler for this tier" /></th>
              <th className="font-medium pb-1 px-1">New<Tip text="Leads that entered this tier today (new ingest or aging move)" /></th>
              <th className="font-medium pb-1 px-1">Calls<Tip text="Call attempts made today to leads in this tier" /></th>
              <th className="font-medium pb-1 px-1">Passes<Tip text="Total cumulative call attempts across all leads in this tier" /></th>
            </tr>
          </thead>
          <tbody>
            {data.tierMetrics.map((tm) => (
              <tr key={tm.tier} className="border-t border-gray-50">
                <td className="py-1 pr-1">
                  <span className="text-[11px] font-semibold text-gray-800">{tm.tierLabel}</span>
                  <span className="text-[10px] text-gray-400 ml-1">({tm.totalActive})</span>
                </td>
                <td className="py-1 px-1 text-right font-bold text-gray-900">{tm.totalActive}</td>
                <td className="py-1 px-1 text-right font-bold text-emerald-600">
                  {tm.newToday > 0 ? `+${tm.newToday}` : '0'}
                </td>
                <td className="py-1 px-1 text-right font-bold text-gray-900">{tm.newCallsToday}</td>
                <td className="py-1 px-1 text-right font-bold text-gray-900">{tm.passes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sync health — HubSpot vs RingCX per campaign */}
      {syncCampaigns && syncCampaigns.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-100 flex flex-col gap-1">
          <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-gray-400 mb-0.5">
            <span>List sync</span>
            <Tip text="Counts refreshed every 15 min from HubSpot Lists API and RingCX Campaign API" />
            {syncCampaigns[0]?.lastSynced && (
              <span className="ml-auto font-normal normal-case text-gray-300">{syncCampaigns[0].lastSynced}</span>
            )}
          </div>
          {syncCampaigns.map((sc) => {
            const rcxUnavailable = sc.ringcxCount < 0
            const diff = rcxUnavailable ? 0 : sc.hubspotCount - sc.ringcxCount
            const isOk = !rcxUnavailable && diff === 0
            const absDiff = Math.abs(diff)
            const isMinor = !rcxUnavailable && absDiff > 0 && absDiff <= 20
            const gapReason = diff > 0
              ? `${diff} leads pending load to RingCX — next ingest cycle will sync`
              : diff < 0
                ? `${Math.abs(diff)} excess leads in RingCX — reconciler will clean within 15 min`
                : undefined
            return (
              <div key={sc.campaignId} className="flex items-center gap-1.5 text-[10px]" title={gapReason}>
                <span className={`font-bold w-8 ${sc.listType === 'New' ? 'text-blue-600' : 'text-purple-600'}`}>
                  {sc.listType === 'New' ? 'NEW' : 'OLD'}
                </span>
                <span className="text-gray-400">HS</span>
                <span className="text-gray-600 font-medium">{sc.hubspotCount.toLocaleString()}</span>
                <span className="text-gray-300">/</span>
                <span className="text-gray-400">RC</span>
                {rcxUnavailable ? (
                  <span className="text-gray-400 italic">—</span>
                ) : (
                  <span className="text-gray-600 font-medium">{sc.ringcxCount.toLocaleString()}</span>
                )}
                {rcxUnavailable ? (
                  <span className="text-gray-400 ml-auto">—</span>
                ) : isOk ? (
                  <span className="text-green-600 font-bold ml-auto">{'\u2713'}</span>
                ) : (
                  <span className={`font-bold ml-auto ${isMinor ? 'text-amber-500' : diff > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                    {diff > 0 ? `-${diff}` : `+${Math.abs(diff)}`}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* All 8 bucket counts — 2 rows of 4 */}
      <div className="px-3 py-2.5 flex flex-col gap-2 border-t border-gray-100">
        {/* Tier bar */}
        <div className="flex h-1.5 rounded overflow-hidden gap-px">
          {allBuckets.map((_, i) => (
            <div
              key={i}
              className="h-full"
              style={{ width: `${pcts[i]}%`, background: ALL_BUCKET_COLORS[i] }}
            />
          ))}
        </div>
        {/* Bucket grid: 2 rows of 4 */}
        <div className="grid grid-cols-4 gap-1">
          {allBuckets.map((v, i) => (
            <div key={i} className="flex flex-col items-center bg-gray-50 rounded py-1 px-0.5 cursor-help" title={BUCKET_TOOLTIPS[i]}>
              <span className="text-[13px] font-extrabold leading-none" style={{ color: ALL_BUCKET_COLORS[i] }}>{v}</span>
              <span className="text-[8px] text-gray-600 mt-0.5 font-medium">{ALL_BUCKET_LABELS[i]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Calendar footer */}
      <div className="mt-auto border-t border-gray-100 px-3 py-2 bg-[#fafafa] flex flex-col gap-1">
        {data.serviceAreaCalendars && data.serviceAreaCalendars.length > 1 ? (
          data.serviceAreaCalendars.map((sa) => {
            const sp72 = pct(sa.data.slots72h.booked, sa.data.slots72h.total)
            const sOpen72 = sa.data.slots72h.total - sa.data.slots72h.booked
            return (
              <div key={sa.serviceArea} className="flex flex-col gap-0.5">
                <span className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">{sa.serviceArea}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-600 font-medium w-7 shrink-0">72h</span>
                  <div className="flex-1 bg-gray-200 rounded h-[4px] overflow-hidden">
                    <div className={`h-full rounded ${calFillClass(sp72)}`} style={{ width: `${sp72}%` }} />
                  </div>
                  <span className="text-[10px] font-bold min-w-[32px] text-right" style={{ color: calColor(sp72) }}>
                    {sa.data.slots72h.booked}/{sa.data.slots72h.total}
                  </span>
                  <span className="text-[9px] text-gray-500 min-w-[34px] text-right">{sOpen72} open</span>
                </div>
              </div>
            )
          })
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600 font-medium w-7 shrink-0">72h</span>
              <div className="flex-1 bg-gray-200 rounded h-[4px] overflow-hidden">
                <div className={`h-full rounded ${calFillClass(p72)}`} style={{ width: `${p72}%` }} />
              </div>
              <span className="text-[10px] font-bold min-w-[32px] text-right" style={{ color: calColor(p72) }}>
                {data.calendar.slots72h.booked}/{data.calendar.slots72h.total}
              </span>
              <span className="text-[9px] text-gray-500 min-w-[34px] text-right">{open72} open</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600 font-medium w-7 shrink-0">7d</span>
              <div className="flex-1 bg-gray-200 rounded h-[4px] overflow-hidden">
                <div className={`h-full rounded ${calFillClass(p7)}`} style={{ width: `${p7}%` }} />
              </div>
              <span className="text-[10px] font-bold min-w-[32px] text-right" style={{ color: calColor(p7) }}>
                {data.calendar.slots7d.booked}/{data.calendar.slots7d.total}
              </span>
              <span className="text-[9px] text-gray-500 min-w-[34px] text-right">{open7} open</span>
            </div>
          </>
        )}
      </div>

      {/* Urgency strip */}
      <div className="px-3 py-1 border-t border-gray-100 flex items-center justify-between">
        <span className="text-[10px] text-gray-600">Urgency</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${urgClass}`}>{urgText}</span>
      </div>
    </div>
  )
}
