'use client'

import { useState } from 'react'
import type { RegionPipelineData, PipelineData, ServiceAreaCalendar } from '@/lib/dashboard-types'
import {
  NEW_BUCKET_COLORS,
  NEW_BUCKET_LABELS,
  AGED_BUCKET_COLORS,
  AGED_BUCKET_LABELS,
} from '@/lib/dashboard-types'

interface RegionCardProps {
  data: RegionPipelineData & { serviceAreaCalendars?: ServiceAreaCalendar[] }
  isSelected: boolean
  onClick: () => void
}

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

function PipelineBody({
  pipe,
  colors,
  labels,
}: {
  pipe: PipelineData
  colors: readonly string[]
  labels: readonly string[]
}) {
  const total = pipe.bucketCounts.reduce((a, b) => a + b, 0)
  const pcts = pipe.bucketCounts.map((v) => pct(v, total))
  const isOk = pipe.delta === 0

  return (
    <div className="px-4 py-3 flex flex-col gap-2.5">
      {/* HS → RX sync row */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 flex flex-col gap-px">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">HubSpot</span>
          <span className="text-[22px] font-extrabold text-[#111827] leading-none tracking-tight">{pipe.hubspotCount.toLocaleString()}</span>
          <span className="text-[10px] text-gray-500">{pipe.campaignName}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <span className="text-gray-200 text-[13px]">&rarr;</span>
          {isOk ? (
            <span className="text-[13px] text-emerald-500">&#10003;</span>
          ) : (
            <span className="text-[13px] text-red-500">&darr;</span>
          )}
        </div>
        <div className="flex-1 flex flex-col gap-px text-right">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">RingCX</span>
          <span className={`text-[22px] font-extrabold leading-none tracking-tight ${isOk ? 'text-[#111827]' : 'text-red-500'}`}>
            {pipe.ringcxCount.toLocaleString()}
          </span>
          <span className="text-[10px] text-gray-500">{pipe.campaignId}</span>
        </div>
      </div>

      {/* Tier bar */}
      <div>
        <div className="flex h-1.5 rounded overflow-hidden gap-px">
          {pipe.bucketCounts.map((_, i) => (
            <div
              key={i}
              className="h-full"
              style={{ width: `${pcts[i]}%`, background: colors[i] }}
            />
          ))}
        </div>
        {/* Bucket counts */}
        <div className="grid grid-cols-4 gap-1 mt-1.5">
          {pipe.bucketCounts.map((v, i) => (
            <div key={i} className="flex flex-col items-center bg-gray-50 rounded-md py-1.5 px-1">
              <span className="text-[15px] font-extrabold leading-none" style={{ color: colors[i] }}>{v}</span>
              <span className="text-[9px] text-gray-600 mt-0.5 font-medium">{labels[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function RegionCard({ data, isSelected, onClick }: RegionCardProps) {
  const [activeTab, setActiveTab] = useState<'n' | 'a'>('n')

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
      className={`bg-white border border-gray-200 rounded-xl overflow-hidden cursor-pointer flex flex-col transition-shadow hover:shadow-md ${
        isSelected ? 'border-blue-500 shadow-[0_0_0_3px_rgba(37,99,235,0.08)]' : ''
      }`}
      style={{ borderLeft: `3px solid ${borderColor}` }}
      onClick={onClick}
    >
      {/* Header */}
      <div className="px-4 py-3.5 flex items-start justify-between border-b border-gray-100">
        <div className="flex flex-col gap-0.5">
          <span className="text-xl font-extrabold text-[#111827] tracking-tight leading-none">{data.region}</span>
          <span className="text-[11px] text-gray-500">{data.totalContacts.toLocaleString()} contacts</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`w-2 h-2 rounded-full mt-1 ${statusDot}`} />
          <div className="flex items-center gap-1 text-[11px] text-gray-600">
            <span>avg&nbsp;resp</span>
            <span className={`text-[13px] font-bold ${respClass(data.avgResponseHours)}`}>{data.avgResponseTime}</span>
          </div>
        </div>
      </div>

      {/* Pipeline tabs */}
      <div className="grid grid-cols-2 bg-gray-50">
        <button
          className={`px-4 py-2.5 text-left flex flex-col gap-px border-r border-gray-100 border-b-2 transition-all ${
            activeTab === 'n' ? 'bg-white border-b-blue-600' : 'border-b-transparent'
          }`}
          onClick={(e) => { e.stopPropagation(); setActiveTab('n') }}
        >
          <span className={`text-[9px] font-bold uppercase tracking-wide ${activeTab === 'n' ? 'text-blue-600' : 'text-gray-500'}`}>New</span>
          <span className={`text-sm font-bold ${activeTab === 'n' ? 'text-[#111827]' : 'text-gray-500'}`}>0 &ndash; 30d</span>
          <span className={`text-[11px] ${activeTab === 'n' ? 'text-gray-600' : 'text-gray-500'}`}>{data.newPipeline.hubspotCount.toLocaleString()}</span>
        </button>
        <button
          className={`px-4 py-2.5 text-left flex flex-col gap-px border-b-2 transition-all ${
            activeTab === 'a' ? 'bg-white border-b-purple-600' : 'border-b-transparent'
          }`}
          onClick={(e) => { e.stopPropagation(); setActiveTab('a') }}
        >
          <span className={`text-[9px] font-bold uppercase tracking-wide ${activeTab === 'a' ? 'text-purple-600' : 'text-gray-500'}`}>Aged</span>
          <span className={`text-sm font-bold ${activeTab === 'a' ? 'text-[#111827]' : 'text-gray-500'}`}>30d+</span>
          <span className={`text-[11px] ${activeTab === 'a' ? 'text-gray-600' : 'text-gray-500'}`}>{data.agedPipeline.hubspotCount.toLocaleString()}</span>
        </button>
      </div>

      {/* Pipeline body */}
      {activeTab === 'n' ? (
        <PipelineBody pipe={data.newPipeline} colors={NEW_BUCKET_COLORS} labels={NEW_BUCKET_LABELS} />
      ) : (
        <PipelineBody pipe={data.agedPipeline} colors={AGED_BUCKET_COLORS} labels={AGED_BUCKET_LABELS} />
      )}

      {/* Calendar footer */}
      <div className="mt-auto border-t border-gray-100 px-4 py-2.5 bg-[#fafafa] flex flex-col gap-1.5">
        {data.serviceAreaCalendars && data.serviceAreaCalendars.length > 1 ? (
          /* Per-service-area breakdown */
          data.serviceAreaCalendars.map((sa) => {
            const sp72 = pct(sa.data.slots72h.booked, sa.data.slots72h.total)
            const sOpen72 = sa.data.slots72h.total - sa.data.slots72h.booked
            return (
              <div key={sa.serviceArea} className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">{sa.serviceArea}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-600 font-medium w-8 shrink-0">72h</span>
                  <div className="flex-1 bg-gray-200 rounded h-[5px] overflow-hidden">
                    <div className={`h-full rounded ${calFillClass(sp72)}`} style={{ width: `${sp72}%` }} />
                  </div>
                  <span className="text-[11px] font-bold min-w-[36px] text-right" style={{ color: calColor(sp72) }}>
                    {sa.data.slots72h.booked}/{sa.data.slots72h.total}
                  </span>
                  <span className="text-[10px] text-gray-500 min-w-[38px] text-right">{sOpen72} open</span>
                </div>
              </div>
            )
          })
        ) : (
          /* Single calendar — show 72h + 7d */
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600 font-medium w-8 shrink-0">72h</span>
              <div className="flex-1 bg-gray-200 rounded h-[5px] overflow-hidden">
                <div className={`h-full rounded ${calFillClass(p72)}`} style={{ width: `${p72}%` }} />
              </div>
              <span className="text-[11px] font-bold min-w-[36px] text-right" style={{ color: calColor(p72) }}>
                {data.calendar.slots72h.booked}/{data.calendar.slots72h.total}
              </span>
              <span className="text-[10px] text-gray-500 min-w-[38px] text-right">{open72} open</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600 font-medium w-8 shrink-0">7d</span>
              <div className="flex-1 bg-gray-200 rounded h-[5px] overflow-hidden">
                <div className={`h-full rounded ${calFillClass(p7)}`} style={{ width: `${p7}%` }} />
              </div>
              <span className="text-[11px] font-bold min-w-[36px] text-right" style={{ color: calColor(p7) }}>
                {data.calendar.slots7d.booked}/{data.calendar.slots7d.total}
              </span>
              <span className="text-[10px] text-gray-500 min-w-[38px] text-right">{open7} open</span>
            </div>
          </>
        )}
      </div>

      {/* Urgency strip */}
      <div className="px-4 py-1.5 border-t border-gray-100 flex items-center justify-between">
        <span className="text-[10px] text-gray-600">Urgency</span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${urgClass}`}>{urgText}</span>
      </div>
    </div>
  )
}
