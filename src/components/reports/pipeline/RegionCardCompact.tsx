'use client'

import type { RegionPipelineData, ServiceAreaCalendar } from '@/lib/dashboard-types'
import { pct, calFillClass, calColor, respClass } from './utils'

interface RegionCardCompactProps {
  data: RegionPipelineData & { serviceAreaCalendars?: ServiceAreaCalendar[] }
  isSelected: boolean
  onClick: () => void
}

export default function RegionCardCompact({ data, onClick }: RegionCardCompactProps) {
  const open72 = data.calendar.slots72h.total - data.calendar.slots72h.booked

  const statusDot =
    data.status === 'urgent' ? 'bg-red-500'
    : data.status === 'warn' ? 'bg-amber-500'
    : 'bg-emerald-500'

  const borderColor =
    data.status === 'urgent' ? '#fca5a5'
    : data.status === 'warn' ? '#fcd34d'
    : '#86efac'

  // Per-service-area 72h bars if multiple areas, otherwise single aggregated bar
  const calendarBars = data.serviceAreaCalendars && data.serviceAreaCalendars.length > 1
    ? data.serviceAreaCalendars.map((sa) => ({
        label: sa.serviceArea,
        booked: sa.data.slots72h.booked,
        total: sa.data.slots72h.total,
        open: sa.data.slots72h.total - sa.data.slots72h.booked,
        pct: pct(sa.data.slots72h.booked, sa.data.slots72h.total),
      }))
    : [{
        label: null,
        booked: data.calendar.slots72h.booked,
        total: data.calendar.slots72h.total,
        open: open72,
        pct: pct(data.calendar.slots72h.booked, data.calendar.slots72h.total),
      }]

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl cursor-pointer flex flex-col transition-shadow hover:shadow-md"
      style={{ borderLeft: `3px solid ${borderColor}` }}
      onClick={onClick}
    >
      {/* Region name + status + key metrics */}
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full shrink-0 ${statusDot}`} />
          <span className="text-2xl font-extrabold text-[#111827] tracking-tight leading-none">{data.region}</span>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="text-[20px] font-extrabold text-gray-800 leading-none">{data.totalContacts.toLocaleString()}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">contacts</div>
          </div>
          <div className="text-right" title="Avg time from lead loaded to first call">
            <div className={`text-[20px] font-extrabold leading-none ${respClass(data.avgResponseHours)}`}>{data.avgResponseTime}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">speed to lead</div>
          </div>
        </div>
      </div>

      {/* 72h calendar fill */}
      <div className="border-t border-gray-100 px-5 py-3 bg-[#fafafa] flex flex-col gap-2">
        {calendarBars.map((bar, i) => (
          <div key={i} className="flex flex-col gap-1">
            {bar.label && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{bar.label}</span>
            )}
            <div className="flex items-center gap-2.5">
              <div className="flex-1 bg-gray-200 rounded-full h-[7px] overflow-hidden">
                <div className={`h-full rounded-full ${calFillClass(bar.pct)}`} style={{ width: `${bar.pct}%` }} />
              </div>
              <span className="text-[13px] font-bold min-w-[42px] text-right" style={{ color: calColor(bar.pct) }}>
                {bar.booked}/{bar.total}
              </span>
              <span className="text-[12px] text-gray-400 min-w-[48px] text-right">{bar.open} open</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
