#!/usr/bin/env node
/**
 * Retrofit missing hubspot_owner_id on HubSpot call engagements.
 *
 * The form submission path previously looked up agent_mappings by agent_name,
 * but the form sends leads_rep values — so most calls were created without an owner.
 *
 * This script:
 *   1. Queries call_recordings + agent_mappings for hubspot_call_id → hubspot_owner_id pairs
 *   2. Queries hubspot_form_submissions for form-only calls not in call_recordings
 *   3. PATCHes each HubSpot call engagement to set the correct owner
 *
 * Usage:
 *   HUBSPOT_ACCESS_TOKEN=pat-xxx node scripts/retrofit-call-owners.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// --- Config ---
const DRY_RUN = process.argv.includes('--dry-run')
const HUBSPOT_API_BASE = 'https://api.hubapi.com'
const RATE_LIMIT_DELAY_MS = 120 // ~8 req/s, well under 100/10s limit

// --- Load env ---
const envContent = readFileSync('.env.local', 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/)
  if (match) envVars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY
const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN || envVars.HUBSPOT_API_KEY || envVars.HUBSPOT_ACCESS_TOKEN

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}
if (!hubspotToken) {
  console.error('Set HUBSPOT_ACCESS_TOKEN env var: HUBSPOT_ACCESS_TOKEN=pat-xxx node scripts/retrofit-call-owners.mjs')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// --- Step 1: Get pairs from call_recordings ---
async function getCallRecordingPairs() {
  // Fetch call_recordings with agent_name and hubspot_call_id
  const { data: recordings, error: recErr } = await supabase
    .from('call_recordings')
    .select('hubspot_call_id, agent_name')
    .not('hubspot_call_id', 'is', null)
    .not('agent_name', 'is', null)

  if (recErr) {
    console.error('Error fetching call_recordings:', recErr.message)
    return []
  }

  // Fetch all agent_mappings
  const { data: mappings, error: mapErr } = await supabase
    .from('agent_mappings')
    .select('agent_name, leads_rep, hubspot_owner_id')
    .not('hubspot_owner_id', 'is', null)

  if (mapErr) {
    console.error('Error fetching agent_mappings:', mapErr.message)
    return []
  }

  // Build lookup: leads_rep -> owner, agent_name -> owner
  const ownerByName = new Map()
  for (const m of mappings) {
    if (m.leads_rep) ownerByName.set(m.leads_rep, m.hubspot_owner_id)
    if (m.agent_name) ownerByName.set(m.agent_name, m.hubspot_owner_id)
  }

  const pairs = []
  for (const rec of recordings) {
    const ownerId = ownerByName.get(rec.agent_name)
    if (ownerId) {
      pairs.push({ hubspot_call_id: rec.hubspot_call_id, hubspot_owner_id: ownerId, source: 'call_recordings', agent: rec.agent_name })
    }
  }

  return pairs
}

// --- Step 2: Get pairs from form submissions (not already in call_recordings) ---
async function getFormSubmissionPairs(existingCallIds) {
  const { data: submissions, error } = await supabase
    .from('hubspot_form_submissions')
    .select('hubspot_call_id, form_data')
    .not('hubspot_call_id', 'is', null)

  if (error) {
    console.error('Error fetching form submissions:', error.message)
    return []
  }

  // Fetch all agent_mappings
  const { data: mappings, error: mapErr } = await supabase
    .from('agent_mappings')
    .select('agent_name, leads_rep, hubspot_owner_id')
    .not('hubspot_owner_id', 'is', null)

  if (mapErr) {
    console.error('Error fetching agent_mappings:', mapErr.message)
    return []
  }

  const ownerByName = new Map()
  for (const m of mappings) {
    if (m.leads_rep) ownerByName.set(m.leads_rep, m.hubspot_owner_id)
    if (m.agent_name) ownerByName.set(m.agent_name, m.hubspot_owner_id)
  }

  const pairs = []
  for (const sub of submissions) {
    // Skip if already covered by call_recordings
    if (existingCallIds.has(sub.hubspot_call_id)) continue

    const leadsRep = sub.form_data?.leadsRep
    if (!leadsRep) continue

    const ownerId = ownerByName.get(leadsRep)
    if (ownerId) {
      pairs.push({ hubspot_call_id: sub.hubspot_call_id, hubspot_owner_id: ownerId, source: 'form_submission', agent: leadsRep })
    }
  }

  return pairs
}

// --- Step 3: Check & PATCH HubSpot ---
async function patchCallOwner(callId, ownerId) {
  const res = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/calls/${callId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hubspotToken}`,
    },
    body: JSON.stringify({ properties: { hubspot_owner_id: ownerId } }),
  })

  if (!res.ok) {
    const text = await res.text()
    return { success: false, error: text }
  }

  return { success: true }
}

// --- Main ---
async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===')

  // Step 1: call_recordings pairs
  const crPairs = await getCallRecordingPairs()
  console.log(`Found ${crPairs.length} call_recordings with resolvable owners`)

  // Step 2: form-only pairs
  const existingCallIds = new Set(crPairs.map(p => p.hubspot_call_id))
  const fsPairs = await getFormSubmissionPairs(existingCallIds)
  console.log(`Found ${fsPairs.length} form-only submissions with resolvable owners`)

  // Deduplicate by hubspot_call_id (prefer call_recordings source)
  const allPairs = new Map()
  for (const p of [...crPairs, ...fsPairs]) {
    if (!allPairs.has(p.hubspot_call_id)) {
      allPairs.set(p.hubspot_call_id, p)
    }
  }

  const pairs = [...allPairs.values()]
  console.log(`Total unique calls to update: ${pairs.length}`)

  if (DRY_RUN) {
    console.log('\nSample (first 20):')
    for (const p of pairs.slice(0, 20)) {
      console.log(`  ${p.hubspot_call_id} → owner ${p.hubspot_owner_id} (${p.agent}, via ${p.source})`)
    }
    console.log('\nRe-run without --dry-run to apply.')
    return
  }

  let updated = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < pairs.length; i++) {
    const { hubspot_call_id, hubspot_owner_id, agent, source } = pairs[i]

    const result = await patchCallOwner(hubspot_call_id, hubspot_owner_id)

    if (result.success) {
      updated++
      if (updated % 50 === 0 || i === pairs.length - 1) {
        console.log(`Progress: ${i + 1}/${pairs.length} (${updated} updated, ${failed} failed)`)
      }
    } else {
      failed++
      // 404 = call was deleted from HubSpot, not an error worth retrying
      if (result.error?.includes('404') || result.error?.includes('NOT_FOUND')) {
        skipped++
      } else {
        console.error(`Failed ${hubspot_call_id} (${agent}): ${result.error}`)
      }
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))
  }

  console.log(`\nDone: ${updated} updated, ${skipped} not found (deleted), ${failed - skipped} errors`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
