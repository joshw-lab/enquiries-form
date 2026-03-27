import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { PipelineResponse, RegionPipelineData, Region, TierMetrics, TierKey } from '@/lib/dashboard-types'
import { REGIONS, DEFAULT_THRESHOLDS, TIER_LABELS } from '@/lib/dashboard-types'
import { computeHealthStatus } from '@/lib/dashboard-scoring'

const AWST_OFFSET = '+08:00'

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
    const tierData = await fetchTierMetrics()

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

    // Build response
    const regions: RegionPipelineData[] = REGIONS.map((region) => {

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

      const tierTotal = tiers.reduce((sum, t) => sum + t.totalActive, 0)
      const finalBuckets = bucketIndex[region] ?? [0, 0, 0, 0, 0, 0, 0, 0]

      const regionData: RegionPipelineData = {
        region,
        status: 'good',
        urgency: 'low',
        avgResponseTime: resp.text,
        avgResponseHours: resp.hours,
        totalContacts: tierTotal,
        tierMetrics: tiers,
        newPipeline: {
          hubspotCount: tierTotal,
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
