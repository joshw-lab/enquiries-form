import { SupabaseClient } from '@supabase/supabase-js'

/** AWST (Australia/Perth) timezone used for all report date filtering */
export const REPORT_TIMEZONE = 'Australia/Perth'
const AWST_OFFSET = '+08:00'

/** Get today's date string (YYYY-MM-DD) in Perth timezone */
export function getTodayPerth(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: REPORT_TIMEZONE })
}

/** Convert a YYYY-MM-DD date to start-of-day in AWST as ISO string */
export function startOfDayAWST(date: string): string {
  return `${date}T00:00:00${AWST_OFFSET}`
}

/** Convert a YYYY-MM-DD date to end-of-day in AWST as ISO string */
export function endOfDayAWST(date: string): string {
  return `${date}T23:59:59${AWST_OFFSET}`
}

export interface HubSpotUser {
  user_id: string
  first_name: string | null
  last_name: string | null
}

export interface FormSubmission {
  id: string
  source: string
  submitted_by: { agent_id?: string; name?: string; email?: string; phone?: string; contact_id?: string } | null
  contact: { email?: string; phone?: string; name?: string } | null
  form_data: Record<string, unknown>
  disposition: string | null
  metadata: { submittedAt?: string; disposition?: string } | null
  created_at: string
  // Resolved agent name (populated after join with hubspot_users)
  agent_name?: string
}

export interface CallRecording {
  id: string
  call_id: string
  ringcx_recording_url: string | null
  call_direction: string | null
  call_duration_seconds: number | null
  call_start: string
  disposition: string | null
  phone_number: string | null
  agent_id: string | null
  agent_name: string | null
  hubspot_contact_id: string | null
  hubspot_call_id: string | null
  backup_status: string
  gdrive_file_id: string | null
  gdrive_file_url: string | null
  gdrive_file_name: string | null
  created_at: string
  backed_up_at: string | null
}

export interface Filters {
  agent?: string
  startDate?: string
  endDate?: string
}

/**
 * Fetch the hubspot_users lookup table for resolving agent IDs to names
 */
export async function fetchUserLookup(
  supabase: SupabaseClient
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('hubspot_users')
    .select('user_id, first_name, last_name')

  if (error || !data) return {}

  const lookup: Record<string, string> = {}
  for (const user of data as HubSpotUser[]) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
    if (name) {
      lookup[user.user_id] = name
    }
  }
  return lookup
}

/**
 * Resolve agent_id to display name using the user lookup
 */
export function resolveAgentName(
  submission: FormSubmission,
  userLookup: Record<string, string>
): string {
  const agentId = submission.submitted_by?.agent_id
  if (agentId && userLookup[agentId]) {
    return userLookup[agentId]
  }
  return agentId || 'Unknown'
}

/**
 * Remove duplicate submissions: same phone + disposition within 60 seconds.
 * Keeps the earliest submission (lowest created_at) from each group.
 */
function deduplicateSubmissions(submissions: FormSubmission[]): FormSubmission[] {
  const seen = new Map<string, FormSubmission>()
  const result: FormSubmission[] = []

  for (const s of submissions) {
    const phone = s.contact?.phone || (s.form_data?.phoneNumber as string) || ''
    const disp = s.disposition || ''
    if (!phone) {
      result.push(s)
      continue
    }

    const ts = new Date(s.created_at).getTime()
    const key = `${phone}|${disp}`
    const existing = seen.get(key)

    if (existing) {
      const existingTs = new Date(existing.created_at).getTime()
      // If within 60 seconds of the existing one, skip this duplicate
      if (Math.abs(ts - existingTs) < 60_000) continue
    }

    seen.set(key, s)
    result.push(s)
  }

  return result
}

export async function fetchSubmissions(
  supabase: SupabaseClient,
  filters: Filters,
  userLookup: Record<string, string>
): Promise<{ data: FormSubmission[]; error: string | null }> {
  let query = supabase
    .from('hubspot_form_submissions')
    .select('*')
    .order('created_at', { ascending: false })

  if (filters.startDate) {
    query = query.gte('created_at', startOfDayAWST(filters.startDate))
  }
  if (filters.endDate) {
    query = query.lte('created_at', endOfDayAWST(filters.endDate))
  }

  const { data, error } = await query

  if (error) {
    return { data: [], error: error.message }
  }

  let submissions = (data || []) as FormSubmission[]

  // Resolve agent names
  for (const s of submissions) {
    s.agent_name = resolveAgentName(s, userLookup)
  }

  // Deduplicate submissions: same contact phone + disposition within 60 seconds = duplicate
  submissions = deduplicateSubmissions(submissions)

  // Client-side agent filter (by resolved name)
  if (filters.agent) {
    submissions = submissions.filter((s) => s.agent_name === filters.agent)
  }

  return { data: submissions, error: null }
}

export function extractAgentList(
  submissions: FormSubmission[]
): string[] {
  const agents = new Set<string>()
  for (const s of submissions) {
    if (s.agent_name && s.agent_name !== 'Unknown') {
      agents.add(s.agent_name)
    }
  }
  return Array.from(agents).sort()
}

export function getDispositionLabel(disposition: string): string {
  const labels: Record<string, string> = {
    book_water_test: 'Booked Test',
    call_back: 'Call Back',
    not_interested: 'Not Interested',
    other_department: 'Other Department',
    unable_to_service: 'Unable to Service',
    no_answer: 'No Answer',
    wrong_number: 'Wrong Number',
  }
  return labels[disposition] || disposition.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function getDispositionColor(disposition: string): string {
  const colors: Record<string, string> = {
    book_water_test: '#22c55e',
    call_back: '#f59e0b',
    not_interested: '#ef4444',
    other_department: '#8b5cf6',
    unable_to_service: '#6b7280',
    no_answer: '#3b82f6',
    wrong_number: '#f97316',
  }
  return colors[disposition] || '#94a3b8'
}

/**
 * Fetch call recordings with optional filters.
 * Used by the recordings modal in the dashboard.
 */
export async function fetchCallRecordings(
  supabase: SupabaseClient,
  filters: Filters & { disposition?: string }
): Promise<{ data: CallRecording[]; error: string | null }> {
  let query = supabase
    .from('call_recordings')
    .select('*')
    .order('call_start', { ascending: false })

  if (filters.startDate) {
    query = query.gte('call_start', startOfDayAWST(filters.startDate))
  }
  if (filters.endDate) {
    query = query.lte('call_start', endOfDayAWST(filters.endDate))
  }
  if (filters.disposition) {
    query = query.eq('disposition', filters.disposition)
  }
  if (filters.agent) {
    query = query.eq('agent_name', filters.agent)
  }

  const { data, error } = await query

  if (error) {
    return { data: [], error: error.message }
  }

  return { data: (data || []) as CallRecording[], error: null }
}

export interface DialStats {
  totalOutboundDials: number
  dialsByAgent: Record<string, number>
}

/**
 * Fetch outbound dial stats from the ringcx-dial-stats edge function.
 * Queries ringcx_webhook_logs for unique call_ids in the date range.
 */
export async function fetchDialStats(
  filters: Filters
): Promise<{ data: DialStats | null; error: string | null }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!supabaseUrl) {
    return { data: null, error: 'Supabase not configured' }
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/ringcx-dial-stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: filters.startDate,
        endDate: filters.endDate,
        agent: filters.agent || undefined,
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      console.error('Dial stats fetch failed:', response.status, errBody)
      return { data: null, error: `Failed to fetch dial stats (${response.status})` }
    }

    const data: DialStats = await response.json()
    return { data, error: null }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Dial stats fetch error:', error)
    return { data: null, error: message }
  }
}

/**
 * Format seconds into a human-readable duration string
 */
export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '0s'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}
