const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://rzvuzdwhvahwqqhzmuli.supabase.co'
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

export interface DayData {
  date: string
  day_name: string
  day_number: number
  month_name: string
  available_count: number
  priority: string
  label: string
  color: string
  icon: string
  conversionRate: string
  message: string
  priorityScore: number
}

export interface HeatMapResponse {
  region: string
  service_area_name: string
  coverage_description: string
  priority_breakdown: {
    critical: { label: string; days: DayData[]; total_slots: number }
    urgent: { label: string; days: DayData[]; total_slots: number }
    warm: { label: string; days: DayData[]; total_slots: number }
    cooling: { label: string; days: DayData[]; total_slots: number }
  }
  total_slots_available: number
}

export interface TimeSlot {
  event_id: string
  datetime: string
  time: string
  hour: number
  period: 'morning' | 'afternoon' | 'evening'
}

export interface DaySlotsResponse {
  region: string
  service_area_name: string
  date: string
  day_display: string
  total_slots: number
  slots: TimeSlot[]
  grouped_by_period: {
    morning: TimeSlot[]
    afternoon: TimeSlot[]
    evening: TimeSlot[]
  }
}

export async function getCalendarHeatMap(postcode: string, daysAhead: number = 14): Promise<HeatMapResponse> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/get-calendar-heatmap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ postcode: parseInt(postcode), days_ahead: daysAhead })
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || 'Failed to fetch calendar availability')
  }

  return response.json()
}

export async function getDaySlots(postcode: string, date: string): Promise<DaySlotsResponse> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/get-day-slots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ postcode: parseInt(postcode), date })
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || 'Failed to fetch day slots')
  }

  return response.json()
}
