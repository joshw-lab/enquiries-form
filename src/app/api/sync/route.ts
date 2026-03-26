import { NextResponse } from 'next/server'
import type { SyncResponse, CampaignSync, SyncSummary, Region } from '@/lib/dashboard-types'
import { REGIONS } from '@/lib/dashboard-types'
import { createClient } from '@supabase/supabase-js'

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

function timeSince(ts: string): string {
  const elapsed = Date.now() - new Date(ts).getTime()
  const mins = Math.round(elapsed / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

export async function GET() {
  try {
    const hubspotToken = process.env.HUBSPOT_API_KEY
    if (!hubspotToken) throw new Error('Missing HUBSPOT_API_KEY')

    // Read RingCX counts from sync_counts table (written by reconcile cron)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )

    const { data: syncRows } = await supabase
      .from('sync_counts')
      .select('*')

    const syncMap = new Map<string, { ringcx_count: number; updated_at: string }>(
      (syncRows || []).map((r: { campaign_id: number; ringcx_count: number; updated_at: string }) => [
        String(r.campaign_id),
        { ringcx_count: r.ringcx_count, updated_at: r.updated_at },
      ])
    )

    const campaigns: CampaignSync[] = []

    // Fetch HubSpot counts fresh (fast - just list size, no lead data)
    // Process in batches of 4 to stay within rate limits
    for (let i = 0; i < SYNC_CAMPAIGNS.length; i += 4) {
      const batch = SYNC_CAMPAIGNS.slice(i, i + 4)
      await Promise.all(
        batch.map(async ({ region, listType, listId, campaignId }) => {
          try {
            const hsCount = await getHubSpotListSize(listId, hubspotToken!)

            // RingCX count from sync_counts table (updated by reconcile cron every 3 min)
            const syncEntry = syncMap.get(campaignId)
            const rcxCount = syncEntry?.ringcx_count ?? -1
            const rcxAvailable = rcxCount >= 0

            const delta = rcxAvailable ? hsCount - rcxCount : 0
            const absDelta = Math.abs(delta)
            const status: CampaignSync['status'] =
              !rcxAvailable ? 'err' : absDelta > 20 ? 'err' : absDelta > 0 ? 'warn' : 'ok'

            campaigns.push({
              region,
              listType,
              campaignId,
              hubspotCount: hsCount,
              ringcxCount: rcxAvailable ? rcxCount : -1,
              delta,
              status,
              lastSynced: syncEntry ? timeSince(syncEntry.updated_at) : 'never',
            })
          } catch (e) {
            console.warn(`Sync check failed for ${region} ${listType}:`, (e as Error).message)
          }
        })
      )
    }

    // Sort: region order, then New before Aged
    campaigns.sort((a, b) => {
      const ri = REGIONS.indexOf(a.region as Region)
      const rj = REGIONS.indexOf(b.region as Region)
      if (ri !== rj) return ri - rj
      return a.listType === 'New' ? -1 : 1
    })

    const inSync = campaigns.filter((c) => c.delta === 0 && c.ringcxCount >= 0).length
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
