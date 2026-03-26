import { NextResponse } from 'next/server'
import type { SyncFailure } from '@/lib/dashboard-types'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const campaignId = searchParams.get('campaignId')

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )

    let query = supabase
      .from('sync_failures')
      .select('contact_id, campaign_id, region, tier, failure_type, reason, updated_at')
      .is('resolved_at', null)
      .order('updated_at', { ascending: false })

    if (campaignId) {
      query = query.eq('campaign_id', Number(campaignId))
    }

    const { data, error } = await query

    if (error) throw new Error(`sync_failures query failed: ${error.message}`)

    const failures: SyncFailure[] = (data || []).map((row) => ({
      contactId: row.contact_id,
      campaignId: String(row.campaign_id),
      region: row.region,
      tier: row.tier,
      failureType: row.failure_type,
      reason: row.reason,
      updatedAt: row.updated_at,
    }))

    return NextResponse.json({ failures })
  } catch (e) {
    console.error('Sync failures API error:', e)
    return NextResponse.json({ failures: [] })
  }
}
