import { NextResponse } from 'next/server'
import type { SyncResponse, CampaignSync, SyncSummary, Region } from '@/lib/dashboard-types'
import { REGIONS } from '@/lib/dashboard-types'
import { createClient } from '@supabase/supabase-js'

// Campaign mapping for sorting and labelling
const CAMPAIGN_META: Record<string, { region: Region | 'ALL'; listType: CampaignSync['listType'] }> = {
  // LIST campaigns (NEW/OLD)
  '222': { region: 'WA',  listType: 'New' },
  '223': { region: 'WA',  listType: 'Aged' },
  '230': { region: 'NSW', listType: 'New' },
  '231': { region: 'NSW', listType: 'Aged' },
  '226': { region: 'QLD', listType: 'New' },
  '227': { region: 'QLD', listType: 'Aged' },
  '234': { region: 'ACT', listType: 'New' },
  '235': { region: 'ACT', listType: 'Aged' },
  '238': { region: 'VIC', listType: 'New' },
  '239': { region: 'VIC', listType: 'Aged' },
  '242': { region: 'SA',  listType: 'New' },
  '243': { region: 'SA',  listType: 'Aged' },
  // HOT campaigns
  '272': { region: 'ACT', listType: 'Hot' },
  '273': { region: 'NSW', listType: 'Hot' },
  '274': { region: 'QLD', listType: 'Hot' },
  '275': { region: 'SA',  listType: 'Hot' },
  '276': { region: 'VIC', listType: 'Hot' },
  '277': { region: 'WA',  listType: 'Hot' },
  // Archive campaign
  '289': { region: 'ALL', listType: 'Archived' },
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
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )

    const { data: syncRows, error } = await supabase
      .from('sync_counts')
      .select('*')

    if (error) throw new Error(`sync_counts query failed: ${error.message}`)

    const campaigns: CampaignSync[] = (syncRows || []).map((row: {
      campaign_id: number
      hubspot_count: number
      ringcx_count: number
      load_failed: number | null
      updated_at: string
    }) => {
      const meta = CAMPAIGN_META[String(row.campaign_id)]
      if (!meta) return null

      const loadFailed = row.load_failed ?? 0
      const delta = row.hubspot_count - row.ringcx_count
      const absDelta = Math.abs(delta)
      // If the entire gap is explained by load failures, it's a data quality issue not a sync error
      const unexplainedGap = Math.max(0, absDelta - loadFailed)
      const status: CampaignSync['status'] =
        unexplainedGap > 20 ? 'err' : unexplainedGap > 0 ? 'warn' : 'ok'

      return {
        region: meta.region,
        listType: meta.listType,
        campaignId: String(row.campaign_id),
        hubspotCount: row.hubspot_count,
        ringcxCount: row.ringcx_count,
        delta,
        loadFailed,
        status,
        lastSynced: timeSince(row.updated_at),
      } satisfies CampaignSync
    }).filter(Boolean) as CampaignSync[]

    // Sort: region order, then Hot > New > Aged; Archived at end
    const typeOrder: Record<string, number> = { Hot: 0, New: 1, Aged: 2, Archived: 3 }
    campaigns.sort((a, b) => {
      // Archived always last
      const ta = typeOrder[a.listType] ?? 9
      const tb = typeOrder[b.listType] ?? 9
      if (a.listType === 'Archived' && b.listType !== 'Archived') return 1
      if (b.listType === 'Archived' && a.listType !== 'Archived') return -1
      const ri = REGIONS.indexOf(a.region as Region)
      const rj = REGIONS.indexOf(b.region as Region)
      if (ri !== rj) return ri - rj
      return ta - tb
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

    return NextResponse.json({
      campaigns,
      summary,
      lastFetched: new Date().toISOString(),
    } as SyncResponse)
  } catch (e) {
    console.error('Sync API error:', e)
    return NextResponse.json({
      campaigns: [],
      summary: { totalCampaigns: 0, inSync: 0, minorGaps: 0, missingContacts: 0 },
      lastFetched: new Date().toISOString(),
    } as SyncResponse)
  }
}
