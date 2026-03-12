// ── Region identifiers ──
export const REGIONS = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'ACT'] as const
export type Region = (typeof REGIONS)[number]

// ── Dashboard tab identifiers ──
export type DashboardTab = 'pipeline' | 'sync' | 'reports' | 'calllog'

// ── Pipeline data ──
export interface PipelineData {
  hubspotCount: number
  ringcxCount: number
  delta: number // hubspot - ringcx (negative = missing from RingCX)
  campaignId: string
  campaignName: string
  bucketCounts: [number, number, number, number] // 4 buckets
}

export interface CalendarSlots {
  booked: number
  total: number
}

export interface CalendarDaySlot {
  day: string // e.g. "Thu 5"
  date: string // ISO date
  booked: number
  total: number
}

export interface RegionCalendarData {
  slots72h: CalendarSlots
  slots7d: CalendarSlots
  daily: CalendarDaySlot[] // next 7 days for drill panel
}

export interface RegionPipelineData {
  region: Region
  status: 'urgent' | 'warn' | 'good'
  urgency: 'high' | 'med' | 'low'
  avgResponseTime: string // e.g. "4.2h"
  avgResponseHours: number // numeric for threshold comparison
  totalContacts: number
  newPipeline: PipelineData
  agedPipeline: PipelineData
  calendar: RegionCalendarData
}

// ── Sync data ──
export interface CampaignSync {
  region: Region | 'Global'
  listType: 'New' | 'Aged'
  campaignId: string
  hubspotCount: number
  ringcxCount: number
  delta: number
  status: 'ok' | 'warn' | 'err'
  lastSynced: string // relative timestamp e.g. "4m ago"
}

export interface SyncSummary {
  totalCampaigns: number
  inSync: number
  minorGaps: number
  missingContacts: number
}

// ── Dashboard config (thresholds) ──
export interface DashboardThresholds {
  calendarFillUrgent: number  // < this % = urgent (default 25)
  calendarFillWarn: number    // < this % = warn (default 50)
  hotLeadsUrgent: number      // > this count = urgent (default 20)
  hotLeadsWarn: number        // > this count = warn (default 10)
  avgResponseUrgent: number   // > this hours = urgent (default 6)
  avgResponseWarn: number     // > this hours = warn (default 3)
  ringcxDeltaUrgent: number   // > this count = urgent (default 20)
  ringcxDeltaWarn: number     // > this count = warn (default 1)
  refreshInterval: number     // seconds (default 60)
  agedMaxDays: number         // max age for aged pipeline (default 180)
}

export const DEFAULT_THRESHOLDS: DashboardThresholds = {
  calendarFillUrgent: 25,
  calendarFillWarn: 50,
  hotLeadsUrgent: 20,
  hotLeadsWarn: 10,
  avgResponseUrgent: 6,
  avgResponseWarn: 3,
  ringcxDeltaUrgent: 20,
  ringcxDeltaWarn: 1,
  refreshInterval: 60,
  agedMaxDays: 180,
}

// ── Call Log ──
export interface CallLogEntry {
  id: string
  timestamp: string
  agent: string
  contactName: string
  phone: string
  region: string
  disposition: string
  notes: string
  duration: number | null
  attemptNumber: number | null
  hubspotContactId: string | null
  hubspotCallId: string | null
}

export interface CallLogFilters {
  from?: string
  to?: string
  operator?: string
  region?: string
  disposition?: string
  phone?: string
  page?: number
  pageSize?: number
}

export interface CallLogResponse {
  records: CallLogEntry[]
  total: number
  page: number
  pageSize: number
}

// ── Pipeline API response ──
export interface PipelineResponse {
  regions: RegionPipelineData[]
  lastFetched: string
}

// ── Service area calendar (one per calendar / postcode zone) ──
export interface ServiceAreaCalendar {
  serviceArea: string // e.g. "Gold Coast", "WA Southwest"
  region: string      // parent state e.g. "QLD", "WA"
  data: RegionCalendarData
}

// ── Calendar API response ──
export interface CalendarResponse {
  serviceAreas: ServiceAreaCalendar[]
  lastFetched: string
}

// ── Sync API response ──
export interface SyncResponse {
  campaigns: CampaignSync[]
  summary: SyncSummary
  lastFetched: string
}

// ── Colour constants (from HTML prototype) ──
export const NEW_BUCKET_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#e5e7eb'] as const
export const NEW_BUCKET_LABELS = ['<24h', '1\u20133d', '3\u20137d', '7\u201330d'] as const
export const AGED_BUCKET_COLORS = ['#c084fc', '#a855f7', '#7c3aed', '#4c1d95'] as const
export const AGED_BUCKET_LABELS = ['30\u201345d', '45\u201360d', '60\u201390d', '90d+'] as const
