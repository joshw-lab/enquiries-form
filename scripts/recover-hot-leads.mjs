#!/usr/bin/env node
/**
 * Recovery script: Re-ingest leads into HOT campaigns.
 *
 * The partial unique index on ringcx_lead_routing broke all routing upserts
 * from 2026-03-27 onward. Leads were pushed to RingCX but routing records
 * were never created, causing the HOT reconcile to delete them.
 *
 * This script:
 * 1. Finds recent ingest events that targeted HOT campaigns
 * 2. Re-triggers the ingest edge function for each contact
 * 3. The ingest re-fetches from HubSpot, re-tiers, and pushes to the correct campaign
 *
 * Prerequisites:
 * - The partial unique index must be fixed (replaced with non-partial)
 * - The reconcile fix must be deployed (no-routing leads not deleted)
 * - The ingest fix must be deployed (clears removed_at, checks errors)
 *
 * Usage:
 *   node scripts/recover-hot-leads.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_DELAY_MS = 500 // Rate limit between ingest calls

// Fixed campaign ID mappings: HOT → NEW, OLD
const HOT_TO_CAMPAIGNS = {
  '272': { new: '234', old: '235' }, // ACT
  '273': { new: '230', old: '231' }, // NSW
  '274': { new: '226', old: '227' }, // QLD
  '275': { new: '242', old: '243' }, // SA
  '276': { new: '238', old: '239' }, // VIC
  '277': { new: '222', old: '223' }, // WA
}

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
const ingestUrl = `${supabaseUrl}/functions/v1/ringcx-lead-ingest`

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  console.log(`\n=== HOT Lead Recovery ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`)

  // Step 1: Find all recent ingest events targeting HOT campaigns
  // These are leads that were pushed to RingCX but had no routing record created
  const { data: events, error: evtErr } = await supabase
    .from('lead_routing_events')
    .select('contact_id, to_campaign_id, to_tier, details, created_at')
    .eq('event_type', 'ingested')
    .eq('to_tier', 'HOT')
    .gte('created_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })

  if (evtErr) {
    console.error('Failed to query ingest events:', evtErr)
    process.exit(1)
  }

  console.log(`Found ${events.length} HOT ingest events from last 72h`)

  // Deduplicate by contact_id (keep most recent)
  const contactMap = new Map()
  for (const evt of events) {
    if (!contactMap.has(evt.contact_id)) {
      contactMap.set(evt.contact_id, evt)
    }
  }

  // Also check for orphaned routing records (leads that were in HOT but marked orphaned)
  const { data: orphans, error: orphErr } = await supabase
    .from('ringcx_lead_routing')
    .select('contact_id, hot_campaign_id, new_campaign_id, old_campaign_id')
    .eq('current_tier', 'HOT')
    .eq('removal_reason', 'aging_orphan_not_in_ringcx')
    .gte('lead_date', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())

  if (!orphErr && orphans) {
    console.log(`Found ${orphans.length} orphaned HOT routing records from last 72h`)
    for (const orphan of orphans) {
      if (!contactMap.has(orphan.contact_id)) {
        contactMap.set(orphan.contact_id, {
          contact_id: orphan.contact_id,
          to_campaign_id: orphan.hot_campaign_id,
          details: {
            hot_campaign_id: orphan.hot_campaign_id,
            new_campaign_id: orphan.new_campaign_id,
            old_campaign_id: orphan.old_campaign_id,
          },
        })
      }
    }
  }

  const contacts = [...contactMap.values()]
  console.log(`\nTotal unique contacts to re-ingest: ${contacts.length}\n`)

  if (contacts.length === 0) {
    console.log('Nothing to recover.')
    return
  }

  // Step 2: For each contact, look up campaign IDs from routing or events
  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < contacts.length; i++) {
    const evt = contacts[i]
    const contactId = evt.contact_id
    const hotCampaignId = evt.details?.hot_campaign_id || evt.to_campaign_id
    const mapping = HOT_TO_CAMPAIGNS[hotCampaignId]

    if (!hotCampaignId || !mapping) {
      console.log(`  [${i + 1}/${contacts.length}] SKIP ${contactId} — unknown HOT campaign ${hotCampaignId}`)
      skipped++
      continue
    }

    const body = {
      contactId,
      hotCampaignId,
      newCampaignId: evt.details?.new_campaign_id || mapping.new,
      oldCampaignId: evt.details?.old_campaign_id || mapping.old,
    }

    if (DRY_RUN) {
      console.log(`  [${i + 1}/${contacts.length}] DRY RUN ${contactId} → HOT ${body.hotCampaignId}`)
      succeeded++
      continue
    }

    try {
      const res = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify(body),
      })

      const result = await res.json()

      if (result.success) {
        const status = result.skipped ? `SKIPPED (${result.reason})` : `OK → ${result.tier || 'HOT'}`
        console.log(`  [${i + 1}/${contacts.length}] ${contactId}: ${status}`)
        succeeded++
      } else {
        console.error(`  [${i + 1}/${contacts.length}] ${contactId}: FAILED — ${result.error}`)
        failed++
      }
    } catch (err) {
      console.error(`  [${i + 1}/${contacts.length}] ${contactId}: ERROR — ${err.message}`)
      failed++
    }

    // Rate limit
    if (i < contacts.length - 1) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  console.log(`\n=== Recovery Complete ===`)
  console.log(`  Succeeded: ${succeeded}`)
  console.log(`  Failed:    ${failed}`)
  console.log(`  Skipped:   ${skipped}`)
  console.log(`  Total:     ${contacts.length}`)

  if (!DRY_RUN) {
    console.log(`\nNOTE: The reconcile cron will automatically fill NEW/OLD campaign deficits.`)
    console.log(`Monitor the reconcile logs and RingCX admin to verify leads are accumulating.`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
