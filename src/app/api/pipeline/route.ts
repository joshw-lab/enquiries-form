import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { PipelineResponse, RegionPipelineData, Region } from '@/lib/dashboard-types'
import { REGIONS, DEFAULT_THRESHOLDS } from '@/lib/dashboard-types'
import { computeHealthStatus } from '@/lib/dashboard-scoring'

const MS_PER_DAY = 86_400_000

// All 8 age bucket boundaries (days since lead_date) — applied to every lead
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

interface LeadRow {
  contact_id: string
  contact_state: string | null
  campaign_type: string
  campaign_id: string | null
  priority_context: { lead_date?: string; createdate?: string } | null
}

/**
 * Determine which age bucket (0-7) a lead falls into based on its lead_date.
 * Returns bucket index or -1 if outside all ranges.
 */
function getBucketIndex(leadDateMs: number, now: number): number {
  const ageDays = (now - leadDateMs) / MS_PER_DAY
  for (let i = 0; i < ALL_BUCKET_RANGES.length; i++) {
    if (ageDays >= ALL_BUCKET_RANGES[i].minDays && ageDays < ALL_BUCKET_RANGES[i].maxDays) return i
  }
  return -1
}

function emptyRegion(region: Region): RegionPipelineData {
  return {
    region,
    status: 'good',
    urgency: 'low',
    avgResponseTime: '-',
    avgResponseHours: 0,
    totalContacts: 0,
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

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json(
      { regions: REGIONS.map(emptyRegion), lastFetched: new Date().toISOString() },
      { status: 200 },
    )
  }

  try {
    const supabase = createClient(url, key)
    const now = Date.now()

    // Fetch all lead_loads — deduplicate by contact_id + campaign_type in JS
    // Pull only the columns we need for bucketing
    const { data: allLeads, error } = await supabase
      .from('lead_loads')
      .select('contact_id, contact_state, campaign_type, campaign_id, priority_context')
      .in('campaign_type', ['New', 'Old'])
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Pipeline: lead_loads query failed:', error.message)
      return NextResponse.json(
        { regions: REGIONS.map(emptyRegion), lastFetched: new Date().toISOString() },
        { status: 200 },
      )
    }

    // Deduplicate: keep the most recent load per contact + campaign_type
    const seen = new Set<string>()
    const leads: LeadRow[] = []
    for (const row of (allLeads || []) as LeadRow[]) {
      const k = `${row.contact_id}:${row.campaign_type}`
      if (seen.has(k)) continue
      seen.add(k)
      leads.push(row)
    }

    // Build region data from leads — single 8-bucket array per region
    const regionMap: Record<string, {
      newTotal: number
      oldTotal: number
      buckets: number[]  // 8 buckets: [<24h, 1-3d, 3-7d, 7-30d, 30-45d, 45-60d, 60-90d, 90d+]
      newCampaignId: string
      oldCampaignId: string
    }> = {}

    // Initialise all regions
    for (const r of REGIONS) {
      regionMap[r] = {
        newTotal: 0,
        oldTotal: 0,
        buckets: [0, 0, 0, 0, 0, 0, 0, 0],
        newCampaignId: '',
        oldCampaignId: '',
      }
    }

    // Aggregate leads into regions and buckets
    for (const lead of leads) {
      const region = lead.contact_state
      if (!region || !regionMap[region]) continue

      const rm = regionMap[region]
      const leadDateStr = lead.priority_context?.lead_date || lead.priority_context?.createdate
      const leadDateMs = leadDateStr ? new Date(leadDateStr).getTime() : 0

      if (lead.campaign_type === 'New') {
        rm.newTotal++
        if (lead.campaign_id && !rm.newCampaignId) rm.newCampaignId = lead.campaign_id
      } else if (lead.campaign_type === 'Old') {
        rm.oldTotal++
        if (lead.campaign_id && !rm.oldCampaignId) rm.oldCampaignId = lead.campaign_id
      }

      // Bucket by age regardless of campaign type
      if (leadDateMs > 0) {
        const bucket = getBucketIndex(leadDateMs, now)
        if (bucket >= 0) rm.buckets[bucket]++
      }
    }

    // Build response
    const regions: RegionPipelineData[] = REGIONS.map((region) => {
      const rm = regionMap[region]
      if (!rm || (rm.newTotal === 0 && rm.oldTotal === 0)) return emptyRegion(region)

      const regionData: RegionPipelineData = {
        region,
        status: 'good',
        urgency: 'low',
        avgResponseTime: '-',
        avgResponseHours: 0,
        totalContacts: rm.newTotal + rm.oldTotal,
        newPipeline: {
          hubspotCount: rm.newTotal,
          ringcxCount: 0,
          delta: 0,
          campaignId: rm.newCampaignId,
          campaignName: `${region}-New`,
          bucketCounts: rm.buckets,
        },
        agedPipeline: {
          hubspotCount: rm.oldTotal,
          ringcxCount: 0,
          delta: 0,
          campaignId: rm.oldCampaignId,
          campaignName: `${region}-Old`,
          bucketCounts: rm.buckets,
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
