// ── Region identifiers ──
export const REGIONS = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'ACT'] as const
export type Region = (typeof REGIONS)[number]

// ── Dashboard tab identifiers ──
export type DashboardTab = 'pipeline' | 'sync' | 'queue' | 'activity'

// ── Pipeline data ──
export interface PipelineData {
  hubspotCount: number
  ringcxCount: number
  delta: number // hubspot - ringcx (negative = missing from RingCX)
  campaignId: string
  campaignName: string
  bucketCounts: number[] // 8 buckets: <24h, 1-3d, 3-7d, 7-30d, 30-45d, 45-60d, 60-90d, 90d+
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

// ── Tier metrics (HOT / NEW / OLD) ──
export type TierKey = 'HOT' | 'NEW' | 'OLD'

export interface TierMetrics {
  tier: TierKey
  tierLabel: string           // "First 72 hours", "Days 4 - 90", "90+ Days"
  totalActive: number         // leads loaded in RingCX for this tier
  newToday: number            // leads that entered this tier today
  newCallsToday: number       // calls made today to leads in this tier
  passes: number              // total call attempts since lead was loaded
}

export const TIER_LABELS: Record<TierKey, string> = {
  HOT: 'First 72 hours',
  NEW: 'Days 4 - 90',
  OLD: '90+ Days',
}

export interface RegionPipelineData {
  region: Region
  status: 'urgent' | 'warn' | 'good'
  urgency: 'high' | 'med' | 'low'
  avgResponseTime: string // e.g. "4.2h"
  avgResponseHours: number // numeric for threshold comparison
  totalContacts: number
  tierMetrics: TierMetrics[] // 3 tiers: HOT, NEW, OLD
  newPipeline: PipelineData
  agedPipeline: PipelineData
  calendar: RegionCalendarData
}

// ── Sync data ──
export interface CampaignSync {
  region: Region | 'Global' | 'ALL'
  listType: 'Hot' | 'New' | 'Aged' | 'Archived'
  campaignId: string
  hubspotCount: number
  ringcxCount: number
  delta: number
  loadFailed: number
  status: 'ok' | 'warn' | 'err'
  lastSynced: string // relative timestamp e.g. "4m ago"
}

export interface SyncFailure {
  contactId: string
  campaignId: string
  region: string
  tier: string
  failureType: string
  reason: string
  updatedAt: string
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

// ── Today's new leads (for DrillPanel third column) ──
export interface TodayLead {
  contactId: string
  name: string
  region: string
  postcode: string
  leadDate: string           // ISO timestamp
  loadedAt: string           // ISO timestamp (when pushed to RingCX)
  firstCallAt: string | null // ISO timestamp of first call, null if not yet called
  speedToLeadSeconds: number | null // lead_date → first_call, null if no call yet
}

export interface TodayLeadsResponse {
  leads: TodayLead[]
}

// ── Queue — Left column (queued leads) ──
export interface QueuedLead {
  id: string
  contactId: string
  contactName: string | null
  contactState: string | null
  contactPostcode: string | null
  campaignId: string
  campaignType: string
  loadedAt: string
  dialPriority: string
  priorityReason: string
  priorityContext: {
    lead_date: string | null
    createdate: string | null
    num_contacted: number
  } | null
  queuePosition: number
}

// ── Queue — Right column (completed calls) ──
export interface CompletedCall {
  id: string
  contactId: string | null
  contactName: string | null
  callStart: string
  callDuration: number | null
  disposition: string | null
  agentName: string | null
  gdriveFileId: string | null
  ringcxRecordingUrl: string | null
  backupStatus: string | null
  storageUrl: string | null
  callPosition: number
  notes: string | null
  contactState: string | null
  leadDate: string | null
  bookingDate: string | null
  speedToLeadSeconds: number | null
}

// ── Queue — Metrics ──
export interface QueueMetrics {
  callsToday: number
  callsPerHour: number
  leadsPerHour: number
  connectRate: number | null
  bookingRate: number | null
  bookingsPerHour: number
  avgLeadToCallMinutes: number | null
}

// ── Queue — Summary strip ──
export interface QueueSummary {
  totalLoaded: number
  immediateCount: number
  normalCount: number
  calledCount: number
}

// ── Queue — Chart data (hourly disposition timeline) ──
export interface ChartCall {
  callStart: string
  disposition: string
}

// ── Queue API response ──
export interface QueueCampaign {
  id: string
  label: string
}

export interface QueueResponse {
  leads: QueuedLead[]
  leadsTotal: number
  leadsPage: number
  calls: CompletedCall[]
  callsTotal: number
  callsPage: number
  metrics: QueueMetrics
  summary: QueueSummary
  availableAgents: string[]
  availableCampaigns: QueueCampaign[]
  chartCalls: ChartCall[]
}

// ── Colour constants (from HTML prototype) ──
export const NEW_BUCKET_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#374151'] as const
export const NEW_BUCKET_LABELS = ['<24h', '1\u20133d', '3\u20137d', '7\u201330d'] as const
export const AGED_BUCKET_COLORS = ['#c084fc', '#a855f7', '#7c3aed', '#4c1d95'] as const
export const AGED_BUCKET_LABELS = ['30\u201345d', '45\u201360d', '60\u201390d', '90d+'] as const

// Combined 8-bucket colours/labels for unified pipeline card display
export const ALL_BUCKET_COLORS = [...NEW_BUCKET_COLORS, ...AGED_BUCKET_COLORS] as const
export const ALL_BUCKET_LABELS = [...NEW_BUCKET_LABELS, ...AGED_BUCKET_LABELS] as const
