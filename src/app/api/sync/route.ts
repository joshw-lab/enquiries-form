import { NextResponse } from 'next/server'
import type { SyncResponse, CampaignSync, SyncSummary, Region } from '@/lib/dashboard-types'
import { REGIONS } from '@/lib/dashboard-types'
import {
  getHubSpotClient,
  getRingCXClient,
  discoverCampaignMapping,
  type RingCXClient,
} from '@/lib/server/api-clients'

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
    const hs = getHubSpotClient()
    const mapping = await discoverCampaignMapping(hs)

    let rcx: RingCXClient | null = null
    try {
      rcx = await getRingCXClient()
    } catch (e) {
      console.warn('RingCX unavailable for sync:', (e as Error).message)
    }

    const campaigns: CampaignSync[] = []

    // Process all regions in parallel
    await Promise.all(
      REGIONS.map(async (region) => {
        const camp = mapping[region]
        if (!camp) return

        const checks: Array<{ type: 'New' | 'Aged'; prop: string; campaignId: string }> = []
        if (camp.new) checks.push({ type: 'New', prop: 'ringcx_campaignid_new', campaignId: camp.new })
        if (camp.old) checks.push({ type: 'Aged', prop: 'ringcx_campaignid_old', campaignId: camp.old })

        await Promise.all(
          checks.map(async ({ type, prop, campaignId }) => {
            try {
              // HubSpot: count contacts with this campaign ID
              const hsResult = await hs.searchContacts({
                filterGroups: [{
                  filters: [{ propertyName: prop, operator: 'EQ', value: campaignId }],
                }],
                limit: 1,
              })
              const hsCount = hsResult.total

              // RingCX: count leads in this campaign
              const rcxCount = rcx ? await rcx.getCampaignLeadCount(campaignId) : 0

              const delta = hsCount - rcxCount
              const absDelta = Math.abs(delta)
              const status: CampaignSync['status'] =
                absDelta > 20 ? 'err' : absDelta > 0 ? 'warn' : 'ok'

              campaigns.push({
                region,
                listType: type,
                campaignId,
                hubspotCount: hsCount,
                ringcxCount: rcxCount,
                delta,
                status,
                lastSynced: timeSince(fetchStart),
              })
            } catch (e) {
              console.warn(`Sync check failed for ${region} ${type}:`, (e as Error).message)
            }
          })
        )
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
