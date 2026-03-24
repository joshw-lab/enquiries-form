import { NextResponse } from 'next/server'
import type { PipelineResponse, RegionPipelineData, Region } from '@/lib/dashboard-types'
import { REGIONS, DEFAULT_THRESHOLDS } from '@/lib/dashboard-types'
import { getHubSpotClient, type HubSpotClient } from '@/lib/server/api-clients'
import { computeHealthStatus } from '@/lib/dashboard-scoring'

const MS_PER_DAY = 86_400_000

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

/**
 * Fetch all HubSpot contacts with a lead_date, paginating through results.
 * Returns contacts with state + lead_date for client-side bucketing.
 */
async function fetchAllLeads(hs: HubSpotClient): Promise<Array<{ state: string; leadDateMs: number }>> {
  const leads: Array<{ state: string; leadDateMs: number }> = []
  let after: string | undefined

  // Paginate through all results (HubSpot max 100 per page)
  for (let page = 0; page < 50; page++) {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          {
            propertyName: 'lead_date',
            operator: 'HAS_PROPERTY',
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

export async function GET() {
  try {
    const hs = getHubSpotClient()
    const now = Date.now()

    const leads = await fetchAllLeads(hs)

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
      const rm = regionMap[region]
      if (!rm || rm.total === 0) return emptyRegion(region)

      const regionData: RegionPipelineData = {
        region,
        status: 'good',
        urgency: 'low',
        avgResponseTime: '-',
        avgResponseHours: 0,
        totalContacts: rm.total,
        newPipeline: {
          hubspotCount: rm.total,
          ringcxCount: 0,
          delta: 0,
          campaignId: '',
          campaignName: `${region}`,
          bucketCounts: rm.buckets,
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
