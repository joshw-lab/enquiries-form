#!/usr/bin/env node
/**
 * Retrofit misrouted leads: move sub-72h leads from NEW campaigns back to HOT.
 *
 * Finds leads in ringcx_lead_routing where current_tier='NEW' but lead_date
 * is less than 72 hours old, then moves them to the correct HOT campaign via
 * the RingCX MOVE_TO_CAMPAIGN API.
 *
 * Usage:
 *   node scripts/retrofit-hot-leads.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// --- Config ---
const DRY_RUN = process.argv.includes('--dry-run')
const RINGCX_ACCOUNT_ID = '44510001'
const RINGCX_API_BASE = 'https://ringcx.ringcentral.com/voice/api/v1'
const RINGCX_AUTH_URL = 'https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken'
const RC_TOKEN_URL = 'https://platform.ringcentral.com/restapi/oauth/token'
const AGING_THRESHOLD_HOURS = 72

// --- Load env ---
const envContent = readFileSync('.env.local', 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/)
  if (match) envVars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// --- RingCX Auth ---
async function getRingCXToken() {
  // Get stored RC credentials from Supabase
  const { data: auth, error } = await supabase
    .from('ringcentral_auth')
    .select('rc_client_id, rc_client_secret, rc_refresh_token, rc_access_token, rc_access_token_expires_at, ringcx_access_token, ringcx_access_token_expires_at')
    .single()

  if (error || !auth) {
    throw new Error(`Failed to fetch auth credentials: ${error?.message || 'no data'}`)
  }

  // Check if existing RingCX token is still valid
  if (auth.ringcx_access_token && auth.ringcx_access_token_expires_at) {
    const expiresAt = new Date(auth.ringcx_access_token_expires_at).getTime()
    if (Date.now() < expiresAt - 60_000) {
      return auth.ringcx_access_token
    }
  }

  // Need fresh RC token first
  let rcToken = auth.rc_access_token
  if (!rcToken || !auth.rc_access_token_expires_at || Date.now() >= new Date(auth.rc_access_token_expires_at).getTime() - 5 * 60_000) {
    console.log('Refreshing RC access token...')
    const credentials = `${auth.rc_client_id}:${auth.rc_client_secret}`
    const basicAuth = Buffer.from(credentials).toString('base64')

    const rcRes = await fetch(RC_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: `grant_type=refresh_token&refresh_token=${auth.rc_refresh_token}`,
    })

    if (!rcRes.ok) {
      throw new Error(`RC token refresh failed: ${rcRes.status} ${await rcRes.text()}`)
    }

    const rcData = await rcRes.json()
    rcToken = rcData.access_token

    // Update stored tokens
    await supabase.from('ringcentral_auth').update({
      rc_access_token: rcData.access_token,
      rc_access_token_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      rc_refresh_token: rcData.refresh_token,
      last_refreshed_at: new Date().toISOString(),
    }).eq('rc_client_id', auth.rc_client_id)
  }

  // Exchange RC token for RingCX token
  console.log('Exchanging RC token for RingCX token...')
  const ringcxRes = await fetch(`${RINGCX_AUTH_URL}?includeRefresh=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `rcAccessToken=${encodeURIComponent(rcToken)}&rcTokenType=Bearer`,
  })

  if (!ringcxRes.ok) {
    throw new Error(`RingCX token exchange failed: ${ringcxRes.status} ${await ringcxRes.text()}`)
  }

  const ringcxData = await ringcxRes.json()
  const ringcxToken = ringcxData.accessToken

  // Store new RingCX token
  await supabase.from('ringcentral_auth').update({
    ringcx_access_token: ringcxToken,
    ringcx_access_token_expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
  }).eq('rc_client_id', auth.rc_client_id)

  return ringcxToken
}

// --- Search for lead in RingCX campaign ---
async function searchLeadInCampaign(campaignId, contactId, token) {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignIds: [Number(campaignId)] }),
  })

  if (!res.ok) return null

  const data = await res.json()
  const leads = Array.isArray(data) ? data : (data.leads || data.data || [])

  for (const lead of leads) {
    const externId = String(lead.externId || lead.extern_id || '')
    if (externId === String(contactId)) {
      return Number(lead.leadId || lead.lead_id || lead.id || 0) || null
    }
  }
  return null
}

// --- Move lead between campaigns ---
async function moveLeadToCampaign(sourceCampaignId, destCampaignId, leadId, token) {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=MOVE_TO_CAMPAIGN`
  const body = {
    campaignLeadSearchCriteria: {
      campaignId: Number(sourceCampaignId),
      leadIds: [leadId],
      listIds: [],
      agentDispositions: [],
      systemDispositions: [],
      leadStates: [],
      physicalStates: [],
      leadTimezones: [],
      campaignIds: [Number(sourceCampaignId)],
    },
    leadActionParams: {
      paramMap: {
        CAMPAIGN_ID: String(destCampaignId),
        LIST_ID: '0',
        LIST_NAME: 'Retrofit from New to Hot',
        CREATE_COPY_SETTING: 'false',
        DUPLICATE_ACTION_SETTING: 'MOVE',
      },
    },
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}: ${text}` }
  }
  return { success: true }
}

// --- Main ---
async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===')

  // Find misrouted leads: current_tier=NEW but lead_date < 72h ago
  const cutoff = new Date(Date.now() - AGING_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString()
  console.log(`Looking for NEW leads with lead_date > ${cutoff} (i.e. < ${AGING_THRESHOLD_HOURS}h old)...`)

  const { data: misrouted, error } = await supabase
    .from('ringcx_lead_routing')
    .select('*')
    .eq('current_tier', 'NEW')
    .is('removed_at', null)
    .gt('lead_date', cutoff)

  if (error) {
    console.error('Query error:', error.message)
    process.exit(1)
  }

  if (!misrouted || misrouted.length === 0) {
    console.log('No misrouted leads found. All clear!')
    return
  }

  console.log(`Found ${misrouted.length} misrouted lead(s) in NEW that should be in HOT:\n`)

  for (const lead of misrouted) {
    const ageHours = Math.round((Date.now() - new Date(lead.lead_date).getTime()) / (1000 * 60 * 60))
    console.log(`  Contact ${lead.contact_id}: ${lead.contact_state || '??'} | age=${ageHours}h | current=${lead.current_campaign_id} (NEW) → ${lead.hot_campaign_id} (HOT)`)
  }

  if (DRY_RUN) {
    console.log('\nRe-run without --dry-run to move these leads.')
    return
  }

  console.log('\nMoving leads...')
  const token = await getRingCXToken()

  let moved = 0
  let failed = 0

  for (const lead of misrouted) {
    const contactId = lead.contact_id
    const sourceCampaign = lead.current_campaign_id
    const destCampaign = lead.hot_campaign_id

    if (!destCampaign) {
      console.warn(`  ${contactId}: no hot_campaign_id set — skipping`)
      failed++
      continue
    }

    // Resolve ringcx_lead_id if missing
    let leadId = lead.ringcx_lead_id ? Number(lead.ringcx_lead_id) : null
    if (!leadId) {
      console.log(`  ${contactId}: resolving leadId in campaign ${sourceCampaign}...`)
      leadId = await searchLeadInCampaign(sourceCampaign, contactId, token)
      if (!leadId) {
        console.warn(`  ${contactId}: not found in RingCX campaign ${sourceCampaign} — skipping`)
        failed++
        continue
      }
    }

    // Move from NEW → HOT
    const result = await moveLeadToCampaign(sourceCampaign, destCampaign, leadId, token)
    if (!result.success) {
      console.error(`  ${contactId}: MOVE failed — ${result.error}`)
      failed++
      continue
    }

    // Update routing record
    const now = new Date().toISOString()
    await supabase
      .from('ringcx_lead_routing')
      .update({
        current_campaign_id: destCampaign,
        current_tier: 'HOT',
        moved_to_new_at: null,
        ringcx_lead_id: String(leadId),
        updated_at: now,
      })
      .eq('id', lead.id)

    // Log event
    await supabase.from('lead_routing_events').insert({
      contact_id: contactId,
      event_type: 'retrofit_new_to_hot',
      from_campaign_id: sourceCampaign,
      to_campaign_id: destCampaign,
      from_tier: 'NEW',
      to_tier: 'HOT',
      ringcx_lead_id: String(leadId),
      details: {
        source: 'retrofit_script',
        lead_date: lead.lead_date,
        age_hours: Math.round((Date.now() - new Date(lead.lead_date).getTime()) / (1000 * 60 * 60)),
      },
    })

    console.log(`  ${contactId}: ✓ moved ${sourceCampaign} → ${destCampaign}`)
    moved++
  }

  console.log(`\nDone: ${moved} moved, ${failed} failed out of ${misrouted.length} total`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
