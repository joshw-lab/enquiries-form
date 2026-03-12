import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ── Constants ──
const RINGCX_ACCOUNT_ID = '44510001'
const RINGCX_VOICE_BASE = 'https://ringcx.ringcentral.com/voice/api/v1'
const RINGCX_AUTH_URL = 'https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken'

// ── Supabase Server Client ──

let _supabaseServer: SupabaseClient | null = null

export function getSupabaseServerClient(): SupabaseClient {
  if (_supabaseServer) return _supabaseServer

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  _supabaseServer = createClient(url, key)
  return _supabaseServer
}

// ── HubSpot Client ──

export interface HubSpotClient {
  searchContacts(body: Record<string, unknown>): Promise<{ total: number; results: Record<string, unknown>[] }>
}

export function getHubSpotClient(): HubSpotClient {
  const apiKey = process.env.HUBSPOT_API_KEY
  if (!apiKey) throw new Error('Missing HUBSPOT_API_KEY')

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  return {
    async searchContacts(body) {
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HubSpot search failed (${res.status}): ${text}`)
      }
      return res.json()
    },
  }
}

// ── RingCX Client (2-step auth: RC token → RingCX JWT) ──

export interface RingCXClient {
  getCampaignLeadCount(campaignId: string): Promise<number>
}

// Cache RingCX JWT (~5 min lifetime, cache for 4 min)
let _ringcxTokenCache: { token: string; expiry: number } | null = null

async function getRingCXToken(): Promise<string> {
  const now = Date.now()
  if (_ringcxTokenCache && _ringcxTokenCache.expiry > now) {
    return _ringcxTokenCache.token
  }

  // Step 1: Get RC access token from Supabase
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('ringcentral_auth')
    .select('rc_access_token, rc_access_token_expires_at')
    .single()

  if (error || !data) throw new Error('RingCX auth not configured in database')

  const expiresAt = new Date(data.rc_access_token_expires_at)
  if (expiresAt <= new Date()) {
    throw new Error('RC access token expired — cron refresh may have failed')
  }

  // Step 2: Exchange RC token for RingCX JWT
  const res = await fetch(RINGCX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `rcAccessToken=${encodeURIComponent(data.rc_access_token)}&rcTokenType=Bearer`,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`RingCX token exchange failed (${res.status}): ${text}`)
  }

  const authData = await res.json()
  const token = authData.accessToken || authData.access_token
  if (!token) throw new Error('RingCX token exchange returned no access token')

  _ringcxTokenCache = { token, expiry: now + 4 * 60 * 1000 }
  return token
}

export async function getRingCXClient(): Promise<RingCXClient> {
  const token = await getRingCXToken()
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

  return {
    async getCampaignLeadCount(campaignId) {
      try {
        const res = await fetch(
          `${RINGCX_VOICE_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ campaignId: Number(campaignId) }),
          }
        )
        if (!res.ok) return 0
        const result = await res.json()
        // Try totalCount first (paginated response), then array length
        if (typeof result.totalCount === 'number') return result.totalCount
        const leads = Array.isArray(result) ? result : (result.leads || result.data || [])
        return leads.length
      } catch {
        return 0
      }
    },
  }
}

// ── Google Calendar Client ──

export interface CalendarEvent {
  id: string
  summary: string | null
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
}

export interface GoogleCalendarClient {
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<CalendarEvent[]>
}

export function getGoogleCalendarClient(): GoogleCalendarClient {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!saJson) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON')

  const sa = JSON.parse(saJson) as {
    client_email: string
    private_key: string
    token_uri: string
  }

  let cachedToken: { token: string; expiry: number } | null = null

  async function getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (cachedToken && cachedToken.expiry > now + 60) {
      return cachedToken.token
    }

    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    }

    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url')
    const unsignedToken = `${enc(header)}.${enc(payload)}`

    const crypto = await import('crypto')
    const sign = crypto.createSign('RSA-SHA256')
    sign.update(unsignedToken)
    const signature = sign.sign(sa.private_key, 'base64url')
    const jwt = `${unsignedToken}.${signature}`

    const res = await fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Google auth failed (${res.status}): ${text}`)
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    cachedToken = { token: data.access_token, expiry: now + data.expires_in }
    return data.access_token
  }

  return {
    async listEvents(calendarId, timeMin, timeMax) {
      const token = await getAccessToken()
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
      })
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Google Calendar list failed (${res.status}): ${text}`)
      }
      const data = await res.json() as { items: CalendarEvent[] }
      return data.items || []
    },
  }
}

// ── Calendar ID mapping from service_area_mappings ──

export interface ServiceAreaMapping {
  serviceArea: string
  region: string
  calendarId: string
}

let _serviceAreaCache: { areas: ServiceAreaMapping[]; expiry: number } | null = null

export async function getServiceAreaCalendars(): Promise<ServiceAreaMapping[]> {
  const now = Date.now()
  if (_serviceAreaCache && _serviceAreaCache.expiry > now) return _serviceAreaCache.areas

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('service_area_mappings')
    .select('region, service_area_name, calendar_id')
    .not('calendar_id', 'is', null)
    .order('region')
    .order('service_area_name')

  if (error || !data) throw new Error('Failed to fetch service area calendars')

  const areas: ServiceAreaMapping[] = data.map((row) => ({
    serviceArea: row.service_area_name || row.region,
    region: row.region,
    calendarId: row.calendar_id,
  }))

  _serviceAreaCache = { areas, expiry: now + 60 * 60 * 1000 }
  return areas
}

// ── Campaign mapping discovery from HubSpot ──

export interface CampaignMapping {
  new: string
  old: string
  newHitlist: string
  oldHitlist: string
}

let _campaignMappingCache: { mapping: Record<string, CampaignMapping>; expiry: number } | null = null

export async function discoverCampaignMapping(
  hubspot: HubSpotClient
): Promise<Record<string, CampaignMapping>> {
  const now = Date.now()
  if (_campaignMappingCache && _campaignMappingCache.expiry > now) {
    return _campaignMappingCache.mapping
  }

  // Search HubSpot for contacts with campaign IDs set
  const result = await hubspot.searchContacts({
    filterGroups: [{
      filters: [{
        propertyName: 'ringcx_campaignid_new',
        operator: 'HAS_PROPERTY',
      }],
    }],
    properties: [
      'state',
      'ringcx_campaignid_new',
      'ringcx_campaignid_newhitlist',
      'ringcx_campaignid_old',
      'ringcx_campaignid_oldhitlist',
    ],
    limit: 100,
  })

  const mapping: Record<string, CampaignMapping> = {}
  for (const contact of result.results) {
    const props = (contact as Record<string, unknown>).properties as Record<string, string> | undefined
    if (!props) continue

    const state = props.state
    const newId = props.ringcx_campaignid_new

    if (state && newId && !mapping[state]) {
      mapping[state] = {
        new: newId,
        old: props.ringcx_campaignid_old || '',
        newHitlist: props.ringcx_campaignid_newhitlist || '',
        oldHitlist: props.ringcx_campaignid_oldhitlist || '',
      }
    }
  }

  _campaignMappingCache = { mapping, expiry: now + 60 * 60 * 1000 } // Cache 1 hour
  return mapping
}
