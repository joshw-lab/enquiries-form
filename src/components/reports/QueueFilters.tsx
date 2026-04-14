'use client'

import type { QueueCampaign } from '@/lib/dashboard-types'

export interface QueueFilterState {
  from: string
  to: string
  campaignType: string
  campaignId: string
  priority: string
  operator: string
  direction: string
  search: string
}

interface QueueFiltersProps {
  filters: QueueFilterState
  onChange: (filters: QueueFilterState) => void
  availableAgents?: string[]
  availableCampaigns?: QueueCampaign[]
}

const CAMPAIGN_TYPES = ['New', 'Old']

function perthDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

export default function QueueFilters({ filters, onChange, availableAgents = [], availableCampaigns = [] }: QueueFiltersProps) {
  function update(partial: Partial<QueueFilterState>) {
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

  const activeFilters: { key: keyof QueueFilterState; label: string }[] = []
  if (filters.campaignType) activeFilters.push({ key: 'campaignType', label: `Type: ${filters.campaignType}` })
  if (filters.campaignId) {
    const c = availableCampaigns.find((x) => x.id === filters.campaignId)
    activeFilters.push({ key: 'campaignId', label: `Campaign: ${c?.label || filters.campaignId}` })
  }
  if (filters.priority) activeFilters.push({ key: 'priority', label: `Priority: ${filters.priority}` })
  if (filters.operator) activeFilters.push({ key: 'operator', label: `Operator: ${filters.operator}` })
  if (filters.direction) activeFilters.push({ key: 'direction', label: `Direction: ${filters.direction}` })
  if (filters.search) activeFilters.push({ key: 'search', label: `Search: ${filters.search}` })

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-3">
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

        <div className="flex gap-1 self-end">
          <button onClick={setToday} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">Today</button>
          <button onClick={() => setQuickRange(7)} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">7d</button>
          <button onClick={() => setQuickRange(30)} className="px-3 py-1.5 border border-gray-200 rounded-md bg-white text-xs text-gray-500 cursor-pointer hover:bg-gray-50">30d</button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Type</label>
          <select
            value={filters.campaignType}
            onChange={(e) => update({ campaignType: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[90px]"
          >
            <option value="">All</option>
            {CAMPAIGN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Campaign</label>
          <select
            value={filters.campaignId}
            onChange={(e) => update({ campaignId: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[130px]"
          >
            <option value="">All campaigns</option>
            {availableCampaigns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Operator</label>
          <select
            value={filters.operator}
            onChange={(e) => update({ operator: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[130px]"
          >
            <option value="">All operators</option>
            {availableAgents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Direction</label>
          <select
            value={filters.direction}
            onChange={(e) => update({ direction: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[100px]"
          >
            <option value="">All</option>
            <option value="INBOUND">Inbound</option>
            <option value="OUTBOUND">Outbound</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Priority</label>
          <select
            value={filters.priority}
            onChange={(e) => update({ priority: e.target.value })}
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white min-w-[100px]"
          >
            <option value="">All</option>
            <option value="IMMEDIATE">Immediate</option>
            <option value="NORMAL">Normal</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-gray-600 font-medium">Search</label>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => update({ search: e.target.value })}
            placeholder="Name, email, phone, or ID..."
            className="border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-[#111827] bg-white w-[200px]"
          />
        </div>

      </div>

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
            onClick={() => update({ campaignType: '', campaignId: '', priority: '', operator: '', direction: '', search: '' })}
            className="text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
