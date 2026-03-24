import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const AWST_OFFSET = '+08:00'

function startOfDayAWST(date: string): string {
  return `${date}T00:00:00${AWST_OFFSET}`
}

function endOfDayAWST(date: string): string {
  return `${date}T23:59:59${AWST_OFFSET}`
}

function todayAWST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' })
}

function buildName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

// Normalize dispositions: lowercase + replace spaces with underscores
// so "No Answer" → "no_answer", "Booked Test" → "booked_test"
function normalizeDisp(d: string): string {
  return d.toLowerCase().replace(/\s+/g, '_')
}

// For metrics calculation (normalized snake_case comparison)
const NOT_CONNECTED_NORMALIZED = new Set([
  'no_answer', 'noanswer', 'na', 'no_response',
  'busy',
  'voicemail', 'left_voicemail', 'vm', 'left_vm',
  'wrong_number', 'invalid_number', 'wrong',
  'machine', 'answering_machine',
  'dead_line', 'dead_air',
  'rejected', 'declined',
  'intercept', 'operator_intercept',
  'fax_machine', 'fax',
  'hang_up', 'do_not_call',
])

const BOOKED_TEST_NORMALIZED = new Set([
  'book_water_test', 'booked_test', 'booked_water_test', 'booked',
  'booked_test_single_leg', 'booked_single_leg', 'single_leg',
])

// Map RingCX campaign IDs to state codes
function getCampaignState(campaignId: string): string {
  const id = parseInt(campaignId, 10)
  if (id >= 222 && id <= 225) return 'WA'
  if (id >= 226 && id <= 229) return 'QLD'
  if (id >= 230 && id <= 233) return 'NSW'
  if (id >= 234 && id <= 237) return 'ACT'
  if (id >= 238 && id <= 241) return 'VIC'
  if (id >= 242 && id <= 245) return 'SA'
  return campaignId
}

// Actual Title Case values from call_recordings table for Supabase filter
const NOT_CONNECTED_DB = [
  'No Answer', 'Left Voicemail', 'Wrong Number',
  'Hang Up', 'Do Not Call', 'Busy',
]

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
  const campaignType = params.get('campaign_type')
  const campaignId = params.get('campaign_id')
  const priority = params.get('priority')
  const operatorFilter = params.get('operator')
  const search = params.get('search')
  const leadsPage = parseInt(params.get('leads_page') || '1', 10)
  const callsPage = parseInt(params.get('calls_page') || '1', 10)
  const pageSize = parseInt(params.get('pageSize') || '50', 10)
  const showAll = params.get('show_all') === '1'
  const dispositionFilter = params.get('disposition')

  // ── Left column: lead_loads (mirrors RingCX dial order) ──
  // IMMEDIATE first, then NORMAL; within each group newest first
  let leadsQuery = supabase
    .from('lead_loads')
    .select(
      'id, contact_id, campaign_id, campaign_type, created_at, dial_priority, ' +
      'priority_reason, priority_context, contact_first_name, contact_last_name, ' +
      'contact_state, contact_postcode',
      { count: 'exact' },
    )
    .order('dial_priority', { ascending: true })
    .order('priority_context->num_contacted', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (from) leadsQuery = leadsQuery.gte('created_at', startOfDayAWST(from))
  if (to) leadsQuery = leadsQuery.lte('created_at', endOfDayAWST(to))
  if (campaignType) leadsQuery = leadsQuery.eq('campaign_type', campaignType)
  if (campaignId) leadsQuery = leadsQuery.eq('campaign_id', campaignId)
  if (priority) leadsQuery = leadsQuery.eq('dial_priority', priority)
  if (search) {
    leadsQuery = leadsQuery.or(
      `contact_id.eq.${search},` +
      `contact_first_name.ilike.%${search}%,` +
      `contact_last_name.ilike.%${search}%,` +
      `contact_email.ilike.%${search}%,` +
      `contact_phone.ilike.%${search}%`,
    )
  }

  const leadsOffset = (leadsPage - 1) * pageSize
  leadsQuery = leadsQuery.range(leadsOffset, leadsOffset + pageSize - 1)

  // ── Right column: call_recordings (newest first for activity log) ──
  let callsQuery = supabase
    .from('call_recordings')
    .select(
      'id, hubspot_contact_id, hubspot_call_id, call_start, call_duration_seconds, disposition, agent_name, gdrive_file_id, ringcx_recording_url, backup_status, storage_url',
      { count: 'exact' },
    )
    .order('call_start', { ascending: false })

  if (from) callsQuery = callsQuery.gte('call_start', startOfDayAWST(from))
  if (to) callsQuery = callsQuery.lte('call_start', endOfDayAWST(to))
  if (!showAll) {
    // Default: only show calls with a form submission (rich data with notes/disposition)
    callsQuery = callsQuery.not('hubspot_call_id', 'is', null)
    // When no specific disposition filter, exclude non-connected calls (No Answer, Voicemail, etc.)
    if (!dispositionFilter) {
      callsQuery = callsQuery.not('disposition', 'in', `(${NOT_CONNECTED_DB.join(',')})`)
    }
  }
  if (dispositionFilter) {
    callsQuery = callsQuery.eq('disposition', dispositionFilter)
  }
  if (operatorFilter) {
    callsQuery = callsQuery.eq('agent_name', operatorFilter)
  }

  const callsOffset = (callsPage - 1) * pageSize
  callsQuery = callsQuery.range(callsOffset, callsOffset + pageSize - 1)

  // ── Chart data: all calls in date range (call_start + disposition only) ──
  // Supabase caps rows per request (~1000), so paginate to get all calls for the day
  async function fetchAllChartData() {
    const PAGE_SIZE = 1000
    const allRows: Record<string, unknown>[] = []
    for (let page = 0; page < 10; page++) {
      let q = supabase
        .from('call_recordings')
        .select('call_start, disposition')
        .order('call_start', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      if (from) q = q.gte('call_start', startOfDayAWST(from))
      if (to) q = q.lte('call_start', endOfDayAWST(to))
      if (operatorFilter) q = q.eq('agent_name', operatorFilter)
      const { data } = await q
      if (!data || data.length === 0) break
      allRows.push(...(data as Record<string, unknown>[]))
      if (data.length < PAGE_SIZE) break
    }
    return { data: allRows, error: null }
  }

  // ── Run leads + calls + chart + agent/campaign lookups in parallel ──
  const [leadsResult, callsResult, chartResult, agentResult, campaignResult] = await Promise.all([
    leadsQuery,
    callsQuery,
    fetchAllChartData(),
    supabase.from('agent_mappings').select('agent_name').order('agent_name'),
    supabase.from('lead_loads').select('campaign_id, campaign_type'),
  ])

  if (leadsResult.error) {
    return NextResponse.json({ error: leadsResult.error.message }, { status: 500 })
  }

  // ── Map leads to QueuedLead shape with daily queue position ──
  // Ordered ASC (chronological): first lead of day = #1 at top
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leads = ((leadsResult.data || []) as any[]).map((row: Record<string, unknown>, idx: number) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName: buildName(row.contact_first_name as string | null, row.contact_last_name as string | null),
    contactState: row.contact_state || null,
    contactPostcode: row.contact_postcode || null,
    campaignId: row.campaign_id,
    campaignType: row.campaign_type,
    loadedAt: row.created_at,
    dialPriority: row.dial_priority || 'UNKNOWN',
    priorityReason: row.priority_reason || '',
    priorityContext: row.priority_context || null,
    queuePosition: leadsOffset + idx + 1,
  }))

  // ── Resolve contact names for calls via lead_loads ──
  const callContactIds = (callsResult.data || [])
    .map((r: Record<string, unknown>) => r.hubspot_contact_id as string)
    .filter(Boolean)
  const nameMap: Record<string, string> = {}
  if (callContactIds.length > 0) {
    const uniqueIds = [...new Set(callContactIds)]
    const { data: nameRows } = await supabase
      .from('lead_loads')
      .select('contact_id, contact_first_name, contact_last_name')
      .in('contact_id', uniqueIds)
      .not('contact_first_name', 'is', null)
      .limit(500)
    if (nameRows) {
      for (const r of nameRows) {
        const n = buildName(r.contact_first_name, r.contact_last_name)
        if (n && !nameMap[r.contact_id]) nameMap[r.contact_id] = n
      }
    }
  }

  // ── Resolve notes from form submissions via hubspot_call_id ──
  const callHubspotIds = (callsResult.data || [])
    .map((r: Record<string, unknown>) => r.hubspot_call_id as string)
    .filter(Boolean)
  const notesMap: Record<string, string> = {}
  if (callHubspotIds.length > 0) {
    const uniqueCallIds = [...new Set(callHubspotIds)]
    const { data: formRows } = await supabase
      .from('hubspot_form_submissions')
      .select('hubspot_call_id, form_data, contact')
      .in('hubspot_call_id', uniqueCallIds)
    if (formRows) {
      for (const r of formRows as Record<string, unknown>[]) {
        const callId = r.hubspot_call_id as string
        const formData = r.form_data as Record<string, unknown> | null
        const notes = formData?.notes as string
        if (notes && callId && !notesMap[callId]) notesMap[callId] = notes
      }
    }
  }

  // ── Map calls to CompletedCall shape with daily position ──
  // Calls ordered DESC (newest first); position = total - offset - idx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = ((callsResult.data || []) as any[]).map((row: Record<string, unknown>, idx: number) => ({
    id: row.id,
    contactId: row.hubspot_contact_id || null,
    contactName: nameMap[row.hubspot_contact_id as string] || null,
    callStart: row.call_start,
    callDuration: row.call_duration_seconds ?? null,
    disposition: row.disposition || null,
    agentName: row.agent_name || null,
    gdriveFileId: row.gdrive_file_id || null,
    ringcxRecordingUrl: row.ringcx_recording_url || null,
    backupStatus: row.backup_status || null,
    storageUrl: row.storage_url || null,
    callPosition: (callsResult.count ?? 0) - callsOffset - idx,
    notes: notesMap[row.hubspot_call_id as string] || null,
  }))

  // ── Metrics: compute in parallel ──
  const today = todayAWST()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const [
    todayCallsResult,
    recentCallsResult,
    recentLeadsResult,
    summaryResult,
  ] = await Promise.all([
    // Today's calls (for callsToday + connect/booking rates)
    // Use exact count + large limit to avoid Supabase default 1000-row cap
    supabase
      .from('call_recordings')
      .select('disposition', { count: 'exact' })
      .gte('call_start', startOfDayAWST(today))
      .limit(10000),
    // Calls in last hour
    supabase
      .from('call_recordings')
      .select('id', { count: 'exact', head: true })
      .gte('call_start', oneHourAgo),
    // Leads loaded in last hour
    supabase
      .from('lead_loads')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', oneHourAgo),
    // Summary counts (filtered)
    getSummary(supabase, from, to, campaignType, priority, search),
  ])

  // Calculate rates from today's calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const todayCalls = (todayCallsResult.data || []) as any[]
  const callsToday = todayCallsResult.count ?? todayCalls.length
  let connectedCount = 0
  let bookedCount = 0
  for (const c of todayCalls) {
    const d = (c as Record<string, unknown>).disposition as string || ''
    const norm = normalizeDisp(d)
    const isNotConnected = NOT_CONNECTED_NORMALIZED.has(norm)
    if (!isNotConnected && d) connectedCount++
    if (BOOKED_TEST_NORMALIZED.has(norm)) bookedCount++
  }

  // Compute bookings in last hour from call_recordings (use Title Case values)
  const BOOKED_TEST_DB = ['Booked Test']
  const { count: bookingsLastHour } = await supabase
    .from('call_recordings')
    .select('id', { count: 'exact', head: true })
    .gte('call_start', oneHourAgo)
    .in('disposition', BOOKED_TEST_DB)

  const metrics = {
    callsToday,
    callsPerHour: recentCallsResult.count ?? 0,
    leadsPerHour: recentLeadsResult.count ?? 0,
    connectRate: callsToday > 0 ? Math.round((connectedCount / callsToday) * 100) : null,
    bookingRate: connectedCount > 0 ? Math.round((bookedCount / connectedCount) * 100) : null,
    bookingsPerHour: bookingsLastHour ?? 0,
    avgLeadToCallMinutes: summaryResult.avgLeadToCallMinutes,
  }

  // ── Build available agents list ──
  const availableAgents: string[] = []
  if (agentResult.data) {
    const seen = new Set<string>()
    for (const r of agentResult.data) {
      const name = (r as Record<string, unknown>).agent_name as string
      if (name && !seen.has(name)) { seen.add(name); availableAgents.push(name) }
    }
  }

  // ── Build available campaigns list (New/Old only, grouped by state) ──
  const availableCampaigns: { id: string; label: string }[] = []
  if (campaignResult.data) {
    const seen = new Set<string>()
    for (const r of campaignResult.data) {
      const cid = (r as Record<string, unknown>).campaign_id as string
      const ctype = (r as Record<string, unknown>).campaign_type as string
      if (cid && !seen.has(cid) && (ctype === 'New' || ctype === 'Old')) {
        seen.add(cid)
        availableCampaigns.push({ id: cid, label: `${getCampaignState(cid)} ${ctype}` })
      }
    }
    availableCampaigns.sort((a, b) => a.label.localeCompare(b.label))
  }

  // ── Chart calls: lightweight array for timeline chart ──
  const chartCalls = ((chartResult.data || []) as Record<string, unknown>[]).map((row) => ({
    callStart: row.call_start as string,
    disposition: (row.disposition as string) || 'Unknown',
  }))

  return NextResponse.json({
    leads,
    leadsTotal: leadsResult.count ?? 0,
    leadsPage,
    calls,
    callsTotal: callsResult.count ?? 0,
    callsPage,
    metrics,
    summary: {
      totalLoaded: summaryResult.totalLoaded,
      immediateCount: summaryResult.immediateCount,
      normalCount: summaryResult.normalCount,
      calledCount: summaryResult.calledCount,
    },
    availableAgents,
    availableCampaigns,
    chartCalls,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSummary(
  supabase: any,
  from: string | null,
  to: string | null,
  campaignType: string | null,
  priority: string | null,
  search: string | null,
) {
  let baseQuery = supabase.from('lead_loads').select('dial_priority, created_at, contact_id', { count: 'exact' })
  if (from) baseQuery = baseQuery.gte('created_at', startOfDayAWST(from))
  if (to) baseQuery = baseQuery.lte('created_at', endOfDayAWST(to))
  if (campaignType) baseQuery = baseQuery.eq('campaign_type', campaignType)
  if (priority) baseQuery = baseQuery.eq('dial_priority', priority)
  if (search) {
    baseQuery = baseQuery.or(
      `contact_id.eq.${search},` +
      `contact_first_name.ilike.%${search}%,` +
      `contact_last_name.ilike.%${search}%,` +
      `contact_email.ilike.%${search}%,` +
      `contact_phone.ilike.%${search}%`,
    )
  }

  const { data: allLeads, count: totalLoaded } = await baseQuery

  let immediateCount = 0
  let normalCount = 0
  if (allLeads) {
    for (const l of allLeads) {
      if ((l as Record<string, unknown>).dial_priority === 'IMMEDIATE') immediateCount++
      else normalCount++
    }
  }

  const contactIds = allLeads
    ? [...new Set(allLeads.map((l: Record<string, unknown>) => l.contact_id as string))]
    : []

  let calledCount = 0
  let totalWaitMinutes = 0
  let waitCount = 0

  if (contactIds.length > 0 && allLeads) {
    const earliestLoad = allLeads.reduce(
      (min: string, l: Record<string, unknown>) => ((l.created_at as string) < min ? (l.created_at as string) : min),
      allLeads[0].created_at as string,
    )

    const { data: calls } = await supabase
      .from('call_recordings')
      .select('hubspot_contact_id, call_start')
      .in('hubspot_contact_id', contactIds)
      .gte('call_start', earliestLoad)

    if (calls) {
      const calledSet = new Set(calls.map((c: Record<string, unknown>) => c.hubspot_contact_id))
      calledCount = calledSet.size

      const callLookup: Record<string, string> = {}
      for (const c of calls) {
        const cid = c.hubspot_contact_id as string
        if (!callLookup[cid] || (c.call_start as string) < callLookup[cid]) {
          callLookup[cid] = c.call_start as string
        }
      }

      for (const lead of allLeads) {
        const cid = (lead as Record<string, unknown>).contact_id as string
        const loadedAt = (lead as Record<string, unknown>).created_at as string
        if (callLookup[cid]) {
          const wait = (new Date(callLookup[cid]).getTime() - new Date(loadedAt).getTime()) / 60000
          if (wait >= 0) {
            totalWaitMinutes += wait
            waitCount++
          }
        }
      }
    }
  }

  return {
    totalLoaded: totalLoaded ?? 0,
    immediateCount,
    normalCount,
    calledCount,
    avgLeadToCallMinutes: waitCount > 0 ? Math.round(totalWaitMinutes / waitCount) : null,
  }
}
