import { NextResponse } from 'next/server'
import type { SyncResponse, CampaignSync, SyncSummary, Region } from '@/lib/dashboard-types'
import { REGIONS } from '@/lib/dashboard-types'
import {
  getRingCXClient,
  type RingCXClient,
} from '@/lib/server/api-clients'

// HubSpot List ID → RingCX Campaign mapping (authoritative source)
const SYNC_CAMPAIGNS: {
  region: Region
  listType: 'New' | 'Aged'
  listId: string
  campaignId: string
}[] = [
  { region: 'WA',  listType: 'New',  listId: '16765', campaignId: '222' },
  { region: 'WA',  listType: 'Aged', listId: '16766', campaignId: '223' },
  { region: 'NSW', listType: 'New',  listId: '16767', campaignId: '230' },
  { region: 'NSW', listType: 'Aged', listId: '16768', campaignId: '231' },
  { region: 'QLD', listType: 'New',  listId: '16769', campaignId: '226' },
  { region: 'QLD', listType: 'Aged', listId: '16770', campaignId: '227' },
  { region: 'ACT', listType: 'New',  listId: '16772', campaignId: '234' },
  { region: 'ACT', listType: 'Aged', listId: '16771', campaignId: '235' },
  { region: 'VIC', listType: 'New',  listId: '16775', campaignId: '238' },
  { region: 'VIC', listType: 'Aged', listId: '16780', campaignId: '239' },
  { region: 'SA',  listType: 'New',  listId: '16781', campaignId: '242' },
  { region: 'SA',  listType: 'Aged', listId: '16782', campaignId: '243' },
]

/** Fetch list member count from HubSpot Lists API v3. */
async function getHubSpotListSize(listId: string, token: string): Promise<number> {
  const res = await fetch(`https://api.hubapi.com/crm/v3/lists/${listId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HubSpot Lists API ${res.status} for list ${listId}: ${text}`)
  }
  const raw = await res.json()
  const data = raw.list ?? raw
  return Number(data.size ?? 0)
}

function timeSince(startMs: number): string {
  const elapsed = Date.now() - startMs
  const mins = Math.round(elapsed / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

export async function GET() {
  const fetchStart = Date.now()

  try {
    const hubspotToken = process.env.HUBSPOT_API_KEY
    if (!hubspotToken) throw new Error('Missing HUBSPOT_API_KEY')

    let rcx: RingCXClient | null = null
    try {
      rcx = await getRingCXClient()
    } catch (e) {
      console.warn('RingCX unavailable for sync:', (e as Error).message)
    }

    const campaigns: CampaignSync[] = []

    // Process all campaigns in parallel
    await Promise.all(
      SYNC_CAMPAIGNS.map(async ({ region, listType, listId, campaignId }) => {
        try {
          // HubSpot: get list member count via Lists API
          const hsCount = await getHubSpotListSize(listId, hubspotToken)

          // RingCX: count leads in this campaign
          const rcxCount = rcx ? await rcx.getCampaignLeadCount(campaignId) : 0

          const delta = hsCount - rcxCount
          const absDelta = Math.abs(delta)
          const status: CampaignSync['status'] =
            absDelta > 20 ? 'err' : absDelta > 0 ? 'warn' : 'ok'

          campaigns.push({
            region,
            listType,
            campaignId,
            hubspotCount: hsCount,
            ringcxCount: rcxCount,
            delta,
            status,
            lastSynced: timeSince(fetchStart),
          })
        } catch (e) {
          console.warn(`Sync check failed for ${region} ${listType}:`, (e as Error).message)
        }
      })
    )

    // Sort: region order, then New before Aged
    campaigns.sort((a, b) => {
      const ri = REGIONS.indexOf(a.region as Region)
      const rj = REGIONS.indexOf(b.region as Region)
      if (ri !== rj) return ri - rj
      return a.listType === 'New' ? -1 : 1
    })

    const inSync = campaigns.filter((c) => c.delta === 0).length
    const minorGaps = campaigns.filter((c) => c.delta !== 0 && Math.abs(c.delta) <= 20).length
    const missingContacts = campaigns
      .filter((c) => c.delta < 0)
      .reduce((sum, c) => sum + Math.abs(c.delta), 0)

    const summary: SyncSummary = {
      totalCampaigns: campaigns.length,
      inSync,
      minorGaps,
      missingContacts,
    }

    const response: SyncResponse = {
      campaigns,
      summary,
      lastFetched: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (e) {
    console.error('Sync API error:', e)
    return NextResponse.json({
      campaigns: [],
      summary: { totalCampaigns: 0, inSync: 0, minorGaps: 0, missingContacts: 0 },
      lastFetched: new Date().toISOString(),
    } as SyncResponse)
  }
}
