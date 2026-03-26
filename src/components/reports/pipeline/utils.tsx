// Shared utility functions for pipeline components

export function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round((a / b) * 100)
}

export function calFillClass(p: number): string {
  if (p < 30) return 'bg-red-500'
  if (p < 60) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function calColor(p: number): string {
  if (p < 30) return '#dc2626'
  if (p < 60) return '#d97706'
  return '#16a34a'
}

export function slotColor(p: number): string {
  if (p < 30) return '#ef4444'
  if (p < 60) return '#f59e0b'
  return '#10b981'
}

export function respClass(hours: number): string {
  if (hours < 3) return 'text-green-600'
  if (hours < 6) return 'text-amber-600'
  return 'text-red-600'
}

export function formatSpeed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hrs = seconds / 3600
  if (hrs < 24) return `${hrs.toFixed(1)}h`
  const days = Math.floor(hrs / 24)
  return `${days}d ${Math.round(hrs % 24)}h`
}

export function speedColor(seconds: number): string {
  const hrs = seconds / 3600
  if (hrs < 1) return 'text-green-600'
  if (hrs < 3) return 'text-amber-600'
  return 'text-red-600'
}

export function timeAgo(isoStr: string): string {
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

export function Tip({ text }: { text: string }) {
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
