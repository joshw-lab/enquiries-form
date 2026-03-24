import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { PipelineResponse, RegionPipelineData, Region, TierMetrics, TierKey } from '@/lib/dashboard-types'
import { REGIONS, DEFAULT_THRESHOLDS, TIER_LABELS } from '@/lib/dashboard-types'
import { getHubSpotClient, type HubSpotClient } from '@/lib/server/api-clients'
import { computeHealthStatus } from '@/lib/dashboard-scoring'

const MS_PER_DAY = 86_400_000
const AWST_OFFSET = '+08:00'

// All 8 age bucket boundaries (days since lead_date)
const ALL_BUCKET_RANGES = [
  { minDays: 0, maxDays: 1 },     // <24h
  { minDays: 1, maxDays: 3 },     // 1–3d
  { minDays: 3, maxDays: 7 },     // 3–7d
  { minDays: 7, maxDays: 30 },    // 7–30d
  { minDays: 30, maxDays: 45 },   // 30–45d
  { minDays: 45, maxDays: 60 },   // 45–60d
  { minDays: 60, maxDays: 90 },   // 60–90d
  { minDays: 90, maxDays: 9999 }, // 90d+
]

function getBucketIndex(leadDateMs: number, now: number): number {
  const ageDays = (now - leadDateMs) / MS_PER_DAY
  for (let i = 0; i < ALL_BUCKET_RANGES.length; i++) {
    if (ageDays >= ALL_BUCKET_RANGES[i].minDays && ageDays < ALL_BUCKET_RANGES[i].maxDays) return i
  }
  return -1
}

function emptyTierMetrics(): TierMetrics[] {
  return (['HOT', 'NEW', 'OLD'] as TierKey[]).map((tier) => ({
    tier,
    tierLabel: TIER_LABELS[tier],
    totalActive: 0,
    newToday: 0,
    newCallsToday: 0,
    passes: 0,
  }))
}

function emptyRegion(region: Region): RegionPipelineData {
  return {
    region,
    status: 'good',
    urgency: 'low',
    avgResponseTime: '-',
    avgResponseHours: 0,
    totalContacts: 0,
    tierMetrics: emptyTierMetrics(),
    newPipeline: {
      hubspotCount: 0, ringcxCount: 0, delta: 0,
      campaignId: '', campaignName: `${region}-New`,
      bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    agedPipeline: {
      hubspotCount: 0, ringcxCount: 0, delta: 0,
      campaignId: '', campaignName: `${region}-Aged`,
      bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    calendar: { slots72h: { booked: 0, total: 0 }, slots7d: { booked: 0, total: 0 }, daily: [] },
  }
}

/**
 * Fetch all HubSpot contacts with a lead_date, paginating through results.
 * Returns contacts with state + lead_date for client-side bucketing.
 */
async function fetchAllLeads(hs: HubSpotClient): Promise<Array<{ state: string; leadDateMs: number }>> {
  const leads: Array<{ state: string; leadDateMs: number }> = []
  let after: string | undefined

  // Only fetch leads from the last 270 days (covers all 8 buckets including 90d+)
  const cutoffDate = new Date(Date.now() - 270 * MS_PER_DAY).toISOString().split('T')[0]

  // Paginate through results (HubSpot max 100 per page, cap at 30 pages = 3000 contacts)
  for (let page = 0; page < 30; page++) {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          {
            propertyName: 'lead_date',
            operator: 'GTE',
            value: cutoffDate,
          },
        ],
      }],
      properties: ['state', 'lead_date'],
      sorts: [{ propertyName: 'lead_date', direction: 'DESCENDING' }],
      limit: 100,
    }

    if (after) {
      body.after = after
    }

    const result = await hs.searchContacts(body)

    for (const contact of result.results) {
      const props = contact.properties as Record<string, string> | undefined
      if (!props) continue

      const state = props.state
      const leadDate = props.lead_date
      if (!state || !leadDate) continue

      const leadDateMs = new Date(leadDate).getTime()
      if (isNaN(leadDateMs)) continue

      leads.push({ state, leadDateMs })
    }

    // Check for next page
    const paging = (result as Record<string, unknown>).paging as { next?: { after?: string } } | undefined
    if (!paging?.next?.after) break
    after = paging.next.after
  }

  return leads
}

/** Fetch tier metrics from Supabase RPC (returns null on error). */
async function fetchTierMetrics(): Promise<{
  tiers: Array<{ contact_state: string; current_tier: TierKey; total_active: number; new_today: number; calls_today: number; total_passes: number }>
  avg_response: Array<{ contact_state: string; avg_response_seconds: number }>
  buckets: Array<{ contact_state: string; bucket_index: number; count: number }>
} | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null

  const supabase = createClient(url, key)

  // Start of today in AWST
  const todayAWST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
  const todayStart = `${todayAWST}T00:00:00${AWST_OFFSET}`

  const { data, error } = await supabase.rpc('pipeline_tier_metrics', { today_start: todayStart })
  if (error) {
    console.error('Tier metrics RPC error:', error)
    return null
  }

  return data as {
    tiers: Array<{ contact_state: string; current_tier: TierKey; total_active: number; new_today: number; calls_today: number; total_passes: number }>
    avg_response: Array<{ contact_state: string; avg_response_seconds: number }>
    buckets: Array<{ contact_state: string; bucket_index: number; count: number }>
  }
}

function formatResponseTime(seconds: number): { text: string; hours: number } {
  const hours = seconds / 3600
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) {
    return { text: `${mins} mins ${secs} sec`, hours }
  }
  if (hours < 24) {
    return { text: `${hours.toFixed(1)}h`, hours }
  }
  const days = Math.floor(hours / 24)
  const remainHours = Math.round(hours % 24)
  return { text: `${days}d ${remainHours}h`, hours }
}

export async function GET() {
  try {
    const hs = getHubSpotClient()
    const now = Date.now()

    // Fetch HubSpot leads and Supabase tier metrics in parallel
    // Use .catch() so a HubSpot failure doesn't block tier metrics
    const [leads, tierData] = await Promise.all([
      fetchAllLeads(hs).catch((e) => {
        console.error('HubSpot fetch error (tier metrics still available):', e.message)
        return [] as Array<{ state: string; leadDateMs: number }>
      }),
      fetchTierMetrics(),
    ])

    // Index tier metrics by region+tier for fast lookup
    const tierIndex: Record<string, { total_active: number; new_today: number; calls_today: number; total_passes: number }> = {}
    const avgRespIndex: Record<string, number> = {} // region → avg_response_seconds
    const bucketIndex: Record<string, number[]> = {} // region → 8-bucket counts

    if (tierData) {
      for (const row of tierData.tiers) {
        tierIndex[`${row.contact_state}:${row.current_tier}`] = row
      }
      for (const row of tierData.avg_response) {
        avgRespIndex[row.contact_state] = row.avg_response_seconds
      }
      for (const row of tierData.buckets ?? []) {
        if (!bucketIndex[row.contact_state]) {
          bucketIndex[row.contact_state] = [0, 0, 0, 0, 0, 0, 0, 0]
        }
        if (row.bucket_index >= 0 && row.bucket_index < 8) {
          bucketIndex[row.contact_state][row.bucket_index] = row.count
        }
      }
    }

    // Build region data — single 8-bucket array per region
    const regionMap: Record<string, { total: number; buckets: number[] }> = {}
    for (const r of REGIONS) {
      regionMap[r] = { total: 0, buckets: [0, 0, 0, 0, 0, 0, 0, 0] }
    }

    for (const lead of leads) {
      const rm = regionMap[lead.state]
      if (!rm) continue

      rm.total++
      const bucket = getBucketIndex(lead.leadDateMs, now)
      if (bucket >= 0) rm.buckets[bucket]++
    }

    // Build response
    const regions: RegionPipelineData[] = REGIONS.map((region) => {
      const rm = regionMap[region] ?? { total: 0, buckets: [0, 0, 0, 0, 0, 0, 0, 0] }

      // Build tier metrics from Supabase data (always — even if HubSpot returned 0)
      const tiers: TierMetrics[] = (['HOT', 'NEW', 'OLD'] as TierKey[]).map((tier) => {
        const row = tierIndex[`${region}:${tier}`]
        return {
          tier,
          tierLabel: TIER_LABELS[tier],
          totalActive: row?.total_active ?? 0,
          newToday: row?.new_today ?? 0,
          newCallsToday: row?.calls_today ?? 0,
          passes: row?.total_passes ?? 0,
        }
      })

      // Avg response time
      const avgRespSec = avgRespIndex[region]
      const resp = avgRespSec != null && avgRespSec > 0
        ? formatResponseTime(avgRespSec)
        : { text: '-', hours: 0 }

      // Use HubSpot data when available, fall back to Supabase
      const hsTotal = rm.total
      const tierTotal = tiers.reduce((sum, t) => sum + t.totalActive, 0)
      const hsBuckets = rm.buckets
      const sbBuckets = bucketIndex[region] ?? [0, 0, 0, 0, 0, 0, 0, 0]
      // Use HubSpot buckets if they have data, otherwise Supabase buckets
      const hasBucketData = hsBuckets.some((v) => v > 0)
      const finalBuckets = hasBucketData ? hsBuckets : sbBuckets

      const regionData: RegionPipelineData = {
        region,
        status: 'good',
        urgency: 'low',
        avgResponseTime: resp.text,
        avgResponseHours: resp.hours,
        totalContacts: hsTotal || tierTotal,
        tierMetrics: tiers,
        newPipeline: {
          hubspotCount: hsTotal || tierTotal,
          ringcxCount: 0,
          delta: 0,
          campaignId: '',
          campaignName: `${region}`,
          bucketCounts: finalBuckets,
        },
        agedPipeline: {
          hubspotCount: 0,
          ringcxCount: 0,
          delta: 0,
          campaignId: '',
          campaignName: '',
          bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0],
        },
        calendar: { slots72h: { booked: 0, total: 0 }, slots7d: { booked: 0, total: 0 }, daily: [] },
      }

      const health = computeHealthStatus(regionData, DEFAULT_THRESHOLDS)
      regionData.status = health.status
      regionData.urgency = health.urgency

      return regionData
    })

    return NextResponse.json({
      regions,
      lastFetched: new Date().toISOString(),
    } satisfies PipelineResponse)
  } catch (e) {
    console.error('Pipeline API error:', e)
    return NextResponse.json(
      { regions: REGIONS.map(emptyRegion), lastFetched: new Date().toISOString() },
      { status: 200 },
    )
  }
}
