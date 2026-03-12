'use client'

import { REGIONS } from '@/lib/dashboard-types'

export interface CallLogFilterState {
  from: string
  to: string
  operator: string
  region: string
  disposition: string
  phone: string
}

interface CallLogFiltersProps {
  filters: CallLogFilterState
  agents: string[]
  dispositions: string[]
  onChange: (filters: CallLogFilterState) => void
}

function perthDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

export default function CallLogFilters({ filters, agents, dispositions, onChange }: CallLogFiltersProps) {
  function update(partial: Partial<CallLogFilterState>) {
    onChange({ ...filters, ...partial })
  }

  function setQuickRange(days: number) {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days)
    update({ from: perthDate(start), to: perthDate(end) })
  }

  function setToday() {
    const today = perthDate(new Date())
    update({ from: today, to: today })
  }

  // Active filter chips
  const activeFilters: { key: keyof CallLogFilterState; label: string }[] = []
  if (filters.operator) activeFilters.push({ key: 'operator', label: `Agent: ${filters.operator}` })
  if (filters.region) activeFilters.push({ key: 'region', label: `Region: ${filters.region}` })
  if (filters.disposition) activeFilters.push({ key: 'disposition', label: `Disposition: ${filters.disposition}` })
  if (filters.phone) activeFilters.push({ key: 'phone', label: `Phone: ${filters.phone}` })

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-3">
        {/* Date range */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">From</label>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => update({ from: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">To</label>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => update({ to: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white"
          />
        </div>

        {/* Quick buttons */}
        <div className="flex gap-1 self-end">
          <button onClick={setToday} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">Today</button>
          <button onClick={() => setQuickRange(7)} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">7d</button>
          <button onClick={() => setQuickRange(30)} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">30d</button>
          <button onClick={() => update({ from: '', to: '' })} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">All</button>
        </div>

        {/* Operator */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Operator</label>
          <select
            value={filters.operator}
            onChange={(e) => update({ operator: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[120px]"
          >
            <option value="">All Agents</option>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Region */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Region</label>
          <select
            value={filters.region}
            onChange={(e) => update({ region: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[100px]"
          >
            <option value="">All</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {/* Disposition */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Disposition</label>
          <select
            value={filters.disposition}
            onChange={(e) => update({ disposition: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[140px]"
          >
            <option value="">All</option>
            {dispositions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        {/* Phone search */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Phone</label>
          <input
            type="text"
            value={filters.phone}
            onChange={(e) => update({ phone: e.target.value })}
            placeholder="Search..."
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white w-[140px]"
          />
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {activeFilters.map((f) => (
            <span
              key={f.key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200"
            >
              {f.label}
              <button
                onClick={() => update({ [f.key]: '' })}
                className="text-blue-400 hover:text-blue-600 cursor-pointer ml-0.5"
              >
                &#10005;
              </button>
            </span>
          ))}
          <button
            onClick={() => update({ operator: '', region: '', disposition: '', phone: '' })}
            className="text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
