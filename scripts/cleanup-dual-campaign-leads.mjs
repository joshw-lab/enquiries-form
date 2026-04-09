#!/usr/bin/env node
/**
 * Detect and remove leads that exist in both HOT and NEW/OLD campaigns.
 *
 * For each state, fetches leads from HOT + NEW campaigns in RingCX,
 * finds the intersection (duplicates), then removes the lead from
 * the wrong campaign based on lead_date age.
 *
 * Default: dry-run (report only)
 * --live:  execute deletions
 *
 * Usage:
 *   node scripts/cleanup-dual-campaign-leads.mjs            # audit
 *   node scripts/cleanup-dual-campaign-leads.mjs --live      # fix
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// --- Config ---
const LIVE_MODE = process.argv.includes('--live')
const RINGCX_ACCOUNT_ID = '44510001'
const RINGCX_API_BASE = 'https://ringcx.ringcentral.com/voice/api/v1'
const RINGCX_AUTH_URL = 'https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken'
const RC_TOKEN_URL = 'https://platform.ringcentral.com/restapi/oauth/token'
const AGING_THRESHOLD_HOURS = 72

// State → campaign mapping
const CAMPAIGNS = [
  { state: 'WA',  hotId: 277, newId: 222, oldId: 223 },
  { state: 'NSW', hotId: 273, newId: 230, oldId: 231 },
  { state: 'QLD', hotId: 274, newId: 226, oldId: 227 },
  { state: 'ACT', hotId: 272, newId: 234, oldId: 235 },
  { state: 'VIC', hotId: 276, newId: 238, oldId: 239 },
  { state: 'SA',  hotId: 275, newId: 242, oldId: 243 },
]

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

    await supabase.from('ringcentral_auth').update({
      rc_access_token: rcData.access_token,
      rc_access_token_expires_at: new Date(Date.now() + rcData.expires_in * 1000).toISOString(),
      rc_refresh_token: rcData.refresh_token,
      rc_refresh_token_expires_at: new Date(Date.now() + rcData.refresh_token_expires_in * 1000).toISOString(),
    }).eq('id', auth.id || 1)
  }

  // Exchange for RingCX token
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
  const ringcxToken = ringcxData.accessToken || ringcxData.access_token

  // Cache it
  await supabase.from('ringcentral_auth').update({
    ringcx_access_token: ringcxToken,
    ringcx_token_expires_at: new Date(Date.now() + 4.5 * 60 * 1000).toISOString(),
  }).eq('id', auth.id || 1)

  return ringcxToken
}

// --- RingCX API ---
async function fetchCampaignLeads(campaignId, token) {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignIds: [campaignId] }),
  })

  if (!res.ok) throw new Error(`leadSearch ${res.status} for campaign ${campaignId}`)
  const data = await res.json()
  const leads = Array.isArray(data) ? data : (data.leads || data.data || [])

  // Build externId -> leadId map
  const map = new Map()
  for (const lead of leads) {
    const externId = String(lead.externId || lead.extern_id || '')
    const leadId = Number(lead.leadId || lead.lead_id || lead.id || 0)
    if (externId && leadId) map.set(externId, leadId)
  }
  return map
}

async function deleteLeads(campaignId, leadIds, token) {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=DELETE_LEADS`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      campaignLeadSearchCriteria: { campaignId, leadIds },
    }),
  })

  if (!res.ok) throw new Error(`Delete failed: ${res.status} ${await res.text()}`)
  return true
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- Main ---
async function main() {
  console.log(`\n=== Dual-Campaign Lead Cleanup (${LIVE_MODE ? 'LIVE' : 'DRY RUN'}) ===\n`)

  const token = await getRingCXToken()
  let totalDupes = 0
  let totalFixed = 0

  for (const { state, hotId, newId, oldId } of CAMPAIGNS) {
    console.log(`\n--- ${state} ---`)

    // Fetch leads from all three campaigns (sequential to avoid 429)
    const hotLeads = await fetchCampaignLeads(hotId, token)
    await sleep(500)
    const newLeads = await fetchCampaignLeads(newId, token)
    await sleep(500)
    const oldLeads = await fetchCampaignLeads(oldId, token)
    await sleep(500)

    console.log(`  HOT (${hotId}): ${hotLeads.size} leads`)
    console.log(`  NEW (${newId}): ${newLeads.size} leads`)
    console.log(`  OLD (${oldId}): ${oldLeads.size} leads`)

    // Find contacts in HOT that are also in NEW or OLD
    const hotNewDupes = []
    const hotOldDupes = []

    for (const [externId, hotLeadId] of hotLeads) {
      if (newLeads.has(externId)) hotNewDupes.push({ externId, hotLeadId, newLeadId: newLeads.get(externId) })
      if (oldLeads.has(externId)) hotOldDupes.push({ externId, hotLeadId, oldLeadId: oldLeads.get(externId) })
    }

    // Also check NEW vs OLD duplicates
    const newOldDupes = []
    for (const [externId, newLeadId] of newLeads) {
      if (oldLeads.has(externId)) newOldDupes.push({ externId, newLeadId, oldLeadId: oldLeads.get(externId) })
    }

    if (hotNewDupes.length === 0 && hotOldDupes.length === 0 && newOldDupes.length === 0) {
      console.log(`  No duplicates found`)
      continue
    }

    // For HOT+NEW dupes: check lead_date to decide which to remove
    for (const dupe of hotNewDupes) {
      totalDupes++
      const { data: routing } = await supabase
        .from('ringcx_lead_routing')
        .select('lead_date')
        .eq('contact_id', dupe.externId)
        .is('removed_at', null)
        .maybeSingle()

      const leadDate = routing?.lead_date ? new Date(routing.lead_date) : null
      const ageHours = leadDate ? (Date.now() - leadDate.getTime()) / (1000 * 60 * 60) : null

      if (ageHours !== null && ageHours < AGING_THRESHOLD_HOURS) {
        // Lead is < 72h — belongs in HOT, remove from NEW
        console.log(`  DUPE: ${dupe.externId} in HOT+NEW (age=${Math.round(ageHours)}h < 72h) → remove from NEW (leadId=${dupe.newLeadId})`)
        if (LIVE_MODE) {
          await deleteLeads(newId, [dupe.newLeadId], token)
          totalFixed++
        }
      } else {
        // Lead is >= 72h — belongs in NEW, remove from HOT
        console.log(`  DUPE: ${dupe.externId} in HOT+NEW (age=${ageHours !== null ? Math.round(ageHours) + 'h' : 'unknown'} >= 72h) → remove from HOT (leadId=${dupe.hotLeadId})`)
        if (LIVE_MODE) {
          await deleteLeads(hotId, [dupe.hotLeadId], token)
          // Update routing to reflect NEW
          await supabase.from('ringcx_lead_routing')
            .update({
              current_campaign_id: String(newId),
              current_tier: 'NEW',
              moved_to_new_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('contact_id', dupe.externId)
            .is('removed_at', null)
          totalFixed++
        }
      }
    }

    // HOT+OLD dupes: lead should not be in HOT if it's already OLD
    for (const dupe of hotOldDupes) {
      totalDupes++
      console.log(`  DUPE: ${dupe.externId} in HOT+OLD → remove from HOT (leadId=${dupe.hotLeadId})`)
      if (LIVE_MODE) {
        await deleteLeads(hotId, [dupe.hotLeadId], token)
        totalFixed++
      }
    }

    // NEW+OLD dupes: remove from OLD (NEW takes priority in the pipeline)
    for (const dupe of newOldDupes) {
      totalDupes++
      console.log(`  DUPE: ${dupe.externId} in NEW+OLD → remove from OLD (leadId=${dupe.oldLeadId})`)
      if (LIVE_MODE) {
        await deleteLeads(oldId, [dupe.oldLeadId], token)
        totalFixed++
      }
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Total duplicates found: ${totalDupes}`)
  if (LIVE_MODE) {
    console.log(`Total fixed: ${totalFixed}`)
  } else {
    console.log(`Run with --live to fix`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
