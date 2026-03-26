import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { TodayLead } from '@/lib/dashboard-types'

const AWST_OFFSET = '+08:00'

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ leads: [] })
  }

  const supabase = createClient(url, key)

  // Start of today in AWST
  const todayAWST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
  const todayStart = `${todayAWST}T00:00:00${AWST_OFFSET}`

  // Fetch today's new leads with their first call time
  const { data, error } = await supabase.rpc('today_new_leads', { today_start: todayStart })

  if (error) {
    console.error('today_new_leads RPC error:', error)
    return NextResponse.json({ leads: [] })
  }

  const leads: TodayLead[] = (data ?? []).map((row: {
    contact_id: string
    contact_name: string
    contact_state: string
    contact_postcode: string
    lead_date: string
    loaded_at: string
    first_call_at: string | null
    speed_to_lead_seconds: number | null
  }) => ({
    contactId: row.contact_id,
    name: row.contact_name,
    region: row.contact_state,
    postcode: row.contact_postcode,
    leadDate: row.lead_date,
    loadedAt: row.loaded_at,
    firstCallAt: row.first_call_at,
    speedToLeadSeconds: row.speed_to_lead_seconds,
  }))

  return NextResponse.json({ leads })
}
