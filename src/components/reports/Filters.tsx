'use client'

interface FiltersProps {
  agents: string[]
  selectedAgent: string
  startDate: string
  endDate: string
  onAgentChange: (agent: string) => void
  onStartDateChange: (date: string) => void
  onEndDateChange: (date: string) => void
}

export default function Filters({
  agents,
  selectedAgent,
  startDate,
  endDate,
  onAgentChange,
  onStartDateChange,
  onEndDateChange,
}: FiltersProps) {
  function setQuickRange(days: number) {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days)
    onStartDateChange(start.toISOString().split('T')[0])
    onEndDateChange(end.toISOString().split('T')[0])
  }

  function setToday() {
    const today = new Date().toISOString().split('T')[0]
    onStartDateChange(today)
    onEndDateChange(today)
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Agent</label>
          <select
            value={selectedAgent}
            onChange={(e) => onAgentChange(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Agents</option>
            {agents.map((agent) => (
              <option key={agent} value={agent}>{agent}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => onStartDateChange(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => onEndDateChange(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-1">
          <button
            onClick={setToday}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => setQuickRange(7)}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            7 days
          </button>
          <button
            onClick={() => setQuickRange(30)}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            30 days
          </button>
          <button
            onClick={() => { onStartDateChange(''); onEndDateChange('') }}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            All time
          </button>
        </div>
      </div>
    </div>
  )
}
