import { NextResponse } from 'next/server'
import type { PipelineResponse, RegionPipelineData, Region } from '@/lib/dashboard-types'
import { REGIONS, DEFAULT_THRESHOLDS } from '@/lib/dashboard-types'
import {
  getHubSpotClient,
  getRingCXClient,
  discoverCampaignMapping,
  type HubSpotClient,
  type RingCXClient,
  type CampaignMapping,
} from '@/lib/server/api-clients'
import { computeHealthStatus } from '@/lib/dashboard-scoring'

const MS_PER_DAY = 86_400_000

// Age bucket boundaries (days since createdate)
const NEW_BUCKET_RANGES = [
  { minDays: 0, maxDays: 1 },   // <24h
  { minDays: 1, maxDays: 3 },   // 1–3d
  { minDays: 3, maxDays: 7 },   // 3–7d
  { minDays: 7, maxDays: 30 },  // 7–30d
]

const AGED_BUCKET_RANGES = [
  { minDays: 30, maxDays: 45 },  // 30–45d
  { minDays: 45, maxDays: 60 },  // 45–60d
  { minDays: 60, maxDays: 90 },  // 60–90d
  { minDays: 90, maxDays: 365 }, // 90d+
]

/**
 * Count HubSpot contacts matching a campaign property filter + optional createdate range.
 * Uses limit: 1 to minimise payload — we only need the `total` field.
 */
async function hsCount(
  hs: HubSpotClient,
  prop: string,
  value: string,
  createdAfter?: number,
  createdBefore?: number,
): Promise<number> {
  try {
    const filters: Record<string, unknown>[] = [
      { propertyName: prop, operator: 'EQ', value },
    ]
    if (createdAfter !== undefined) {
      filters.push({ propertyName: 'createdate', operator: 'GTE', value: String(createdAfter) })
    }
    if (createdBefore !== undefined) {
      filters.push({ propertyName: 'createdate', operator: 'LT', value: String(createdBefore) })
    }
    const result = await hs.searchContacts({ filterGroups: [{ filters }], limit: 1 })
    return result.total
  } catch {
    return 0
  }
}

/**
 * Build a full RegionPipelineData for one region.
 * Runs HubSpot bucket counts and RingCX lead counts in parallel.
 */
async function buildRegion(
  region: Region,
  campaigns: CampaignMapping,
  hs: HubSpotClient,
  rcx: RingCXClient | null,
  now: number,
): Promise<RegionPipelineData> {
  // ── HubSpot: New pipeline total + 4 buckets ──
  const newCountsP = Promise.all([
    hsCount(hs, 'ringcx_campaignid_new', campaigns.new),
    ...NEW_BUCKET_RANGES.map((b) =>
      hsCount(
        hs,
        'ringcx_campaignid_new',
        campaigns.new,
        now - b.maxDays * MS_PER_DAY,
        now - b.minDays * MS_PER_DAY,
      )
    ),
  ])

  // ── HubSpot: Aged pipeline total + 4 buckets ──
  const oldCountsP = campaigns.old
    ? Promise.all([
        hsCount(hs, 'ringcx_campaignid_old', campaigns.old),
        ...AGED_BUCKET_RANGES.map((b) =>
          hsCount(
            hs,
            'ringcx_campaignid_old',
            campaigns.old,
            now - b.maxDays * MS_PER_DAY,
            now - b.minDays * MS_PER_DAY,
          )
        ),
      ])
    : Promise.resolve([0, 0, 0, 0, 0] as number[])

  // ── RingCX: lead counts per campaign ──
  const rcxP = rcx
    ? Promise.all([
        rcx.getCampaignLeadCount(campaigns.new),
        campaigns.old ? rcx.getCampaignLeadCount(campaigns.old) : Promise.resolve(0),
      ])
    : Promise.resolve([0, 0] as number[])

  const [[newTotal, ...newBuckets], [oldTotal, ...oldBuckets], [newRcx, oldRcx]] =
    await Promise.all([newCountsP, oldCountsP, rcxP])

  const totalContacts = newTotal + oldTotal
  const newDelta = newTotal - newRcx
  const oldDelta = oldTotal - oldRcx

  const regionData: RegionPipelineData = {
    region,
    status: 'good',
    urgency: 'low',
    avgResponseTime: '-',
    avgResponseHours: 0,
    totalContacts,
    newPipeline: {
      hubspotCount: newTotal,
      ringcxCount: newRcx,
      delta: newDelta,
      campaignId: campaigns.new,
      campaignName: `${region}-New`,
      bucketCounts: newBuckets as [number, number, number, number],
    },
    agedPipeline: {
      hubspotCount: oldTotal,
      ringcxCount: oldRcx,
      delta: oldDelta,
      campaignId: campaigns.old || '',
      campaignName: `${region}-Aged`,
      bucketCounts: oldBuckets as [number, number, number, number],
    },
    // Calendar data is merged in from the separate /api/calendar route
    calendar: { slots72h: { booked: 0, total: 0 }, slots7d: { booked: 0, total: 0 }, daily: [] },
  }

  // Compute health status from thresholds
  const health = computeHealthStatus(regionData, DEFAULT_THRESHOLDS)
  regionData.status = health.status
  regionData.urgency = health.urgency

  return regionData
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
      bucketCounts: [0, 0, 0, 0],
    },
    agedPipeline: {
      hubspotCount: 0, ringcxCount: 0, delta: 0,
      campaignId: '', campaignName: `${region}-Aged`,
      bucketCounts: [0, 0, 0, 0],
    },
    calendar: { slots72h: { booked: 0, total: 0 }, slots7d: { booked: 0, total: 0 }, daily: [] },
  }
}

export async function GET() {
  try {
    const hs = getHubSpotClient()

    // Discover region → campaign ID mapping from HubSpot contacts
    const campaignMapping = await discoverCampaignMapping(hs)

    // Initialise RingCX client (may fail if auth token expired)
    let rcx: RingCXClient | null = null
    try {
      rcx = await getRingCXClient()
    } catch (e) {
      console.warn('RingCX unavailable:', (e as Error).message)
    }

    const now = Date.now()

    // Build all 6 regions in parallel
    const regions = await Promise.all(
      REGIONS.map(async (region) => {
        const campaigns = campaignMapping[region]
        if (!campaigns) return emptyRegion(region)
        return buildRegion(region, campaigns, hs, rcx, now)
      })
    )

    const response: PipelineResponse = {
      regions,
      lastFetched: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (e) {
    console.error('Pipeline API error:', e)
    return NextResponse.json(
      { regions: REGIONS.map(emptyRegion), lastFetched: new Date().toISOString() },
      { status: 200 } // Return empty data rather than error so UI doesn't break
    )
  }
}
