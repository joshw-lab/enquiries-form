import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const REPORT_TIMEZONE = 'Australia/Perth'
const AWST_OFFSET = '+08:00'

function startOfDayAWST(date: string): string {
  return `${date}T00:00:00${AWST_OFFSET}`
}

function endOfDayAWST(date: string): string {
  return `${date}T23:59:59${AWST_OFFSET}`
}

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const supabase = createClient(url, key)
  const params = request.nextUrl.searchParams

  const from = params.get('from')
  const to = params.get('to')
  const operator = params.get('operator')
  const region = params.get('region')
  const disposition = params.get('disposition')
  const phone = params.get('phone')
  const page = parseInt(params.get('page') || '1', 10)
  const pageSizeParam = params.get('pageSize')
  const exportAll = pageSizeParam === 'all'
  const pageSize = exportAll ? 10000 : parseInt(pageSizeParam || '50', 10)

  // Build query
  let query = supabase
    .from('hubspot_form_submissions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (from) query = query.gte('created_at', startOfDayAWST(from))
  if (to) query = query.lte('created_at', endOfDayAWST(to))
  if (disposition) query = query.eq('disposition', disposition)

  // Pagination
  if (!exportAll) {
    const offset = (page - 1) * pageSize
    query = query.range(offset, offset + pageSize - 1)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Fetch user lookup for agent name resolution
  const { data: users } = await supabase
    .from('hubspot_users')
    .select('user_id, first_name, last_name')

  const userLookup: Record<string, string> = {}
  if (users) {
    for (const u of users) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
      if (name) userLookup[u.user_id] = name
    }
  }

  // Transform to CallLogEntry format
  type SubmissionRow = {
    id: string
    created_at: string
    disposition: string | null
    submitted_by: { agent_id?: string; name?: string; contact_id?: string } | null
    contact: { name?: string; phone?: string; email?: string } | null
    form_data: Record<string, unknown>
    hubspot_contact_id: string | null
    hubspot_call_id: string | null
  }

  let records = (data as SubmissionRow[]).map((s) => {
    const agentId = s.submitted_by?.agent_id
    const agentName = agentId && userLookup[agentId]
      ? userLookup[agentId]
      : agentId || 'Unknown'

    const contactName = s.contact?.name
      || `${(s.form_data?.firstName as string) || ''} ${(s.form_data?.lastName as string) || ''}`.trim()
      || '-'

    const phoneNumber = s.contact?.phone || (s.form_data?.phoneNumber as string) || '-'

    return {
      id: s.id,
      timestamp: s.created_at,
      agent: agentName,
      contactName,
      phone: phoneNumber,
      region: (s.form_data?.region as string) || '',
      disposition: s.disposition || (s.form_data?.disposition as string) || 'unknown',
      notes: (s.form_data?.notes as string) || '',
      duration: null,
      attemptNumber: null,
      hubspotContactId: s.hubspot_contact_id,
      hubspotCallId: s.hubspot_call_id,
    }
  })

  // Client-side filters that can't be done in Supabase query
  if (operator) {
    records = records.filter((r) => r.agent === operator)
  }
  if (region) {
    records = records.filter((r) => r.region.toLowerCase() === region.toLowerCase())
  }
  if (phone) {
    records = records.filter((r) => r.phone.includes(phone))
  }

  return NextResponse.json({
    records,
    total: count ?? records.length,
    page,
    pageSize,
  })
}
