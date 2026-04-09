#!/usr/bin/env node
/**
 * Cleanup: remove leads from WA HOT campaign (277) that have postcodes
 * outside the WA service area.
 *
 * Identified during investigation 2026-04-02: 12 leads bypassed the service
 * area postcode filter because they were ingested before it was deployed.
 *
 * For each lead:
 *   1. Calls remove-lead edge function to delete from RingCX campaign 277
 *   2. Archives the routing record (removed_at + removal_reason)
 *   3. Logs a lead_routing_events entry for audit trail
 *
 * Usage:
 *   node scripts/cleanup-out-of-area-wa-hot.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const DRY_RUN = process.argv.includes('--dry-run')
const CAMPAIGN_ID = 277

// Out-of-area leads identified from RingCX export analysis
const OUT_OF_AREA_CONTACTS = [
  { contactId: '212264152701', postcode: '6330', reason: 'Outside WA service area range' },
  { contactId: '212755482749', postcode: '6330', reason: 'Outside WA service area range' },
  { contactId: '212739756306', postcode: '6330', reason: 'Outside WA service area range' },
  { contactId: '212894303924', postcode: '6323', reason: 'Outside WA service area range' },
  { contactId: '212653085442', postcode: '6503', reason: 'Outside WA service area range' },
  { contactId: '212910442678', postcode: '6536', reason: 'Outside WA service area range' },
  { contactId: '212705777676', postcode: '6728', reason: 'Outside WA service area range' },
  { contactId: '212388992883', postcode: '6820', reason: 'Outside WA service area range' },
  { contactId: '212747272202', postcode: '6286', reason: 'Outside WA service area range' },
  { contactId: '212458333600', postcode: '6236', reason: 'Gap between 6233 and 6237 in service area' },
  { contactId: '213097368889', postcode: '3212', reason: 'VIC postcode — address data in zip field' },
  { contactId: '212033017606', postcode: null,   reason: 'No postcode on file' },
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
const anonKey = envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const removeLeadUrl = `${supabaseUrl}/functions/v1/remove-lead`

console.log(`\n=== Cleanup out-of-area leads from WA HOT (campaign ${CAMPAIGN_ID}) ===`)
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
console.log(`Leads to process: ${OUT_OF_AREA_CONTACTS.length}\n`)

let removed = 0, skipped = 0, errors = 0

for (const entry of OUT_OF_AREA_CONTACTS) {
  const { contactId, postcode, reason } = entry

  // Look up routing record
  const { data: routing, error: routingErr } = await supabase
    .from('ringcx_lead_routing')
    .select('id, ringcx_lead_id, current_campaign_id, current_tier, removed_at')
    .eq('contact_id', contactId)
    .eq('current_campaign_id', CAMPAIGN_ID)
    .is('removed_at', null)
    .maybeSingle()

  if (routingErr) {
    console.error(`  [${contactId}] Routing lookup error:`, routingErr.message)
    errors++
    continue
  }

  if (!routing) {
    console.log(`  [${contactId}] No active routing record for campaign ${CAMPAIGN_ID} — skipping`)
    skipped++
    continue
  }

  console.log(`  [${contactId}] postcode=${postcode || 'null'} ringcx_lead_id=${routing.ringcx_lead_id} — ${reason}`)

  if (DRY_RUN) {
    console.log(`    → Would remove from RingCX + archive routing`)
    continue
  }

  // 1. Remove from RingCX via remove-lead edge function
  if (routing.ringcx_lead_id) {
    try {
      const resp = await fetch(removeLeadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          campaignId: CAMPAIGN_ID,
          leadIds: [parseInt(routing.ringcx_lead_id, 10)],
        }),
      })
      const result = await resp.json()
      if (!result.success) {
        console.error(`    → RingCX removal failed:`, result.message || result.error)
        errors++
        continue
      }
      console.log(`    → Removed from RingCX campaign ${CAMPAIGN_ID}`)
    } catch (e) {
      console.error(`    → RingCX removal error:`, e.message)
      errors++
      continue
    }
  }

  // 2. Archive routing record
  const now = new Date().toISOString()
  const { error: updateErr } = await supabase
    .from('ringcx_lead_routing')
    .update({
      removed_at: now,
      removal_reason: `cleanup:outside_service_area:${postcode || 'null'}`,
      updated_at: now,
    })
    .eq('id', routing.id)

  if (updateErr) {
    console.error(`    → Routing update failed:`, updateErr.message)
    errors++
    continue
  }

  // 3. Log audit event
  await supabase.from('lead_routing_events').insert({
    contact_id: contactId,
    event_type: 'remediation_archived',
    from_campaign_id: String(CAMPAIGN_ID),
    from_tier: routing.current_tier,
    to_tier: 'ARCHIVED',
    ringcx_lead_id: routing.ringcx_lead_id,
    details: {
      reason: 'outside_service_area',
      postcode,
      cleanup_reason: reason,
      source: 'cleanup-out-of-area-wa-hot',
    },
  })

  console.log(`    → Archived routing record`)
  removed++
}

console.log(`\n=== Summary ===`)
console.log(`Removed: ${removed}`)
console.log(`Skipped: ${skipped}`)
console.log(`Errors:  ${errors}`)
console.log(`Total:   ${OUT_OF_AREA_CONTACTS.length}`)
