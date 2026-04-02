import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { hubspotFetch } from './hubspot-rate-limit'

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
  createContact(properties: Record<string, string>): Promise<{ id: string; properties: Record<string, unknown> }>
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
      const res = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
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
    async createContact(properties) {
      const res = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ properties }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HubSpot create contact failed (${res.status}): ${text}`)
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
            body: JSON.stringify({
              campaignIds: [Number(campaignId)],
              page: 1,
              maxRows: 1,
            }),
          }
        )
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error(`RingCX leadSearch ${res.status} for campaign ${campaignId}: ${errText}`)
          return -1
        }
        const result = await res.json()
        if (typeof result.totalCount === 'number') return result.totalCount
        const leads = Array.isArray(result) ? result : (result.leads || result.data || [])
        return leads.length
      } catch (e) {
        console.error(`RingCX leadSearch error for campaign ${campaignId}:`, (e as Error).message)
        return -1
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
  const saJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!saJsonRaw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON')

  // Parse the service account JSON. The env var may be:
  // 1. Valid JSON (Vercel) — JSON.parse works directly
  // 2. Single-line with literal \n (dotenv .env files) — needs special handling
  let sa: { client_email: string; private_key: string; token_uri: string }
  try {
    sa = JSON.parse(saJsonRaw)
  } catch {
    // Extract fields directly — handles any \n / quoting format from .env files
    const emailMatch = saJsonRaw.match(/"client_email"\s*:\s*"([^"]+)"/)
    const keyMatch = saJsonRaw.match(/"private_key"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const uriMatch = saJsonRaw.match(/"token_uri"\s*:\s*"([^"]+)"/)
    if (!emailMatch || !keyMatch || !uriMatch) {
      throw new Error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON — could not extract required fields')
    }
    sa = {
      client_email: emailMatch[1],
      private_key: keyMatch[1].replace(/\\n/g, '\n'),
      token_uri: uriMatch[1],
    }
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

// ── Campaign mapping (hardcoded — authoritative source) ──

export interface CampaignMapping {
  new: string
  old: string
  newHitlist: string
  oldHitlist: string
}

const CAMPAIGN_MAPPING: Record<string, CampaignMapping> = {
  WA:  { new: '222', old: '223', newHitlist: '224', oldHitlist: '225' },
  QLD: { new: '226', old: '227', newHitlist: '228', oldHitlist: '229' },
  NSW: { new: '230', old: '231', newHitlist: '232', oldHitlist: '233' },
  ACT: { new: '234', old: '235', newHitlist: '236', oldHitlist: '237' },
  VIC: { new: '238', old: '239', newHitlist: '240', oldHitlist: '241' },
  SA:  { new: '242', old: '243', newHitlist: '244', oldHitlist: '245' },
}

export async function discoverCampaignMapping(
  _hubspot: HubSpotClient
): Promise<Record<string, CampaignMapping>> {
  return CAMPAIGN_MAPPING
}
