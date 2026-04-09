#!/usr/bin/env node
/**
 * Audit & retrofit leads_rep on contacts where a water test was booked
 * but a subsequent RingCX disposition webhook overwrote the booking rep.
 *
 * Default mode: audit only (prints report of affected contacts)
 * --fix mode:   patches the original booking rep back onto affected contacts
 *
 * Usage:
 *   node scripts/audit-leads-rep.mjs            # audit report
 *   node scripts/audit-leads-rep.mjs --fix      # apply corrections
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// --- Config ---
const FIX_MODE = process.argv.includes('--fix')
const HISTORY_MODE = process.argv.includes('--history')
const HUBSPOT_API_BASE = 'https://api.hubapi.com'
const RATE_LIMIT_DELAY_MS = 120 // ~8 req/s, well under 100/10s limit
const SINCE_DATE = '2026-03-24T00:00:00+11:00' // Monday AEST

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
  console.error('Set HUBSPOT_ACCESS_TOKEN env var or add to .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// --- Step 1: Query booking submissions ---
async function getBookingSubmissions() {
  const { data, error } = await supabase
    .from('hubspot_form_submissions')
    .select('id, hubspot_contact_id, form_data, created_at')
    .eq('disposition', 'book_water_test')
    .gte('created_at', SINCE_DATE)
    .not('hubspot_contact_id', 'is', null)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching form submissions:', error.message)
    return []
  }

  // Deduplicate by hubspot_contact_id — keep most recent booking
  const byContact = new Map()
  for (const row of data) {
    if (!byContact.has(row.hubspot_contact_id)) {
      byContact.set(row.hubspot_contact_id, row)
    }
  }

  const results = []
  for (const [contactId, row] of byContact) {
    const bookingRep = row.form_data?.leadsRep
    if (!bookingRep) {
      console.warn(`  Skipping contact ${contactId} — no leadsRep in form_data`)
      continue
    }
    results.push({
      contactId,
      bookingRep,
      bookedAt: row.created_at,
    })
  }

  return results
}

// --- Step 2: Fetch current leads_rep from HubSpot ---
async function getCurrentLeadsRep(contactId) {
  const res = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=leads_rep,firstname,lastname`,
    {
      headers: { Authorization: `Bearer ${hubspotToken}` },
    }
  )

  if (res.status === 404) {
    return { notFound: true }
  }

  if (!res.ok) {
    const text = await res.text()
    return { error: text }
  }

  const data = await res.json()
  return {
    currentRep: data.properties?.leads_rep || '',
    firstName: data.properties?.firstname || '',
    lastName: data.properties?.lastname || '',
  }
}

// --- Step 2b: Fetch leads_rep property history from HubSpot ---
async function getLeadsRepHistory(contactId) {
  const res = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?propertiesWithHistory=leads_rep&properties=leads_rep,firstname,lastname`,
    {
      headers: { Authorization: `Bearer ${hubspotToken}` },
    }
  )

  if (res.status === 404) return { notFound: true }
  if (!res.ok) {
    const text = await res.text()
    return { error: text }
  }

  const data = await res.json()
  const history = data.propertiesWithHistory?.leads_rep || []
  return {
    currentRep: data.properties?.leads_rep || '',
    firstName: data.properties?.firstname || '',
    lastName: data.properties?.lastname || '',
    history: history.map(h => ({
      value: h.value || '(empty)',
      timestamp: h.timestamp,
      source: h.sourceType,
      sourceId: h.sourceId || '',
    })),
  }
}

// --- Step 3: Patch leads_rep back to booking rep ---
async function patchLeadsRep(contactId, bookingRep) {
  const res = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubspotToken}`,
      },
      body: JSON.stringify({ properties: { leads_rep: bookingRep } }),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    return { success: false, error: text }
  }

  return { success: true }
}

// --- Main ---
async function main() {
  console.log(FIX_MODE ? '=== FIX MODE ===' : '=== AUDIT MODE ===')
  console.log(`Checking book_water_test submissions since ${SINCE_DATE}\n`)

  // Step 1: Get bookings
  const bookings = await getBookingSubmissions()
  console.log(`Found ${bookings.length} unique contacts with water test bookings\n`)

  if (bookings.length === 0) {
    console.log('No bookings found in the time window.')
    return
  }

  // Step 2: Fetch current state from HubSpot and compare
  const affected = []
  const ok = []
  const notFound = []
  const errors = []

  for (let i = 0; i < bookings.length; i++) {
    const { contactId, bookingRep, bookedAt } = bookings[i]

    const result = await getCurrentLeadsRep(contactId)
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))

    if (result.notFound) {
      notFound.push({ contactId, bookingRep })
      continue
    }
    if (result.error) {
      errors.push({ contactId, bookingRep, error: result.error })
      continue
    }

    const entry = {
      contactId,
      name: `${result.firstName} ${result.lastName}`.trim() || '(no name)',
      bookingRep,
      currentRep: result.currentRep,
      bookedAt,
    }

    if (result.currentRep !== bookingRep) {
      affected.push(entry)
    } else {
      ok.push(entry)
    }
  }

  // Step 3: Print report
  console.log('─'.repeat(100))
  console.log(
    'Contact ID'.padEnd(14) +
    'Name'.padEnd(25) +
    'Booking Rep'.padEnd(20) +
    'Current Rep'.padEnd(20) +
    'Status'
  )
  console.log('─'.repeat(100))

  for (const e of affected) {
    console.log(
      e.contactId.padEnd(14) +
      e.name.substring(0, 23).padEnd(25) +
      e.bookingRep.substring(0, 18).padEnd(20) +
      e.currentRep.substring(0, 18).padEnd(20) +
      'AFFECTED'
    )
  }
  for (const e of ok) {
    console.log(
      e.contactId.padEnd(14) +
      e.name.substring(0, 23).padEnd(25) +
      e.bookingRep.substring(0, 18).padEnd(20) +
      e.currentRep.substring(0, 18).padEnd(20) +
      'OK'
    )
  }
  for (const e of notFound) {
    console.log(
      e.contactId.padEnd(14) +
      '(deleted)'.padEnd(25) +
      e.bookingRep.substring(0, 18).padEnd(20) +
      'N/A'.padEnd(20) +
      'NOT FOUND'
    )
  }

  console.log('─'.repeat(100))
  console.log(`\nSummary: ${affected.length} affected, ${ok.length} OK, ${notFound.length} not found, ${errors.length} errors`)

  if (errors.length > 0) {
    console.log('\nErrors:')
    for (const e of errors) {
      console.log(`  ${e.contactId}: ${e.error}`)
    }
  }

  // Step 3b: Show property history for affected contacts
  if (HISTORY_MODE && affected.length > 0) {
    console.log(`\n${'═'.repeat(100)}`)
    console.log('PROPERTY HISTORY: leads_rep changes for affected contacts')
    console.log('═'.repeat(100))

    for (const entry of affected) {
      const histResult = await getLeadsRepHistory(entry.contactId)
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))

      console.log(`\n▸ ${entry.contactId} — ${entry.name}`)
      console.log(`  Booking rep: ${entry.bookingRep} (booked ${new Date(entry.bookedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })})`)
      console.log(`  Current rep: ${entry.currentRep}`)

      if (histResult.error || histResult.notFound) {
        console.log(`  History: ${histResult.notFound ? 'contact not found' : histResult.error}`)
        continue
      }

      if (histResult.history.length === 0) {
        console.log('  History: (none available)')
        continue
      }

      console.log('  History (newest first):')
      for (const h of histResult.history) {
        const ts = new Date(h.timestamp).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
        console.log(`    ${ts}  →  "${h.value}"  (source: ${h.source}${h.sourceId ? ', id: ' + h.sourceId : ''})`)
      }
    }
  }

  // Step 4: Fix if requested
  if (!FIX_MODE) {
    if (affected.length > 0) {
      console.log(`\nRe-run with --fix to restore booking rep on ${affected.length} contacts.`)
    }
    return
  }

  if (affected.length === 0) {
    console.log('\nNo contacts to fix.')
    return
  }

  console.log(`\nApplying fixes to ${affected.length} contacts...\n`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < affected.length; i++) {
    const { contactId, bookingRep, name } = affected[i]

    const result = await patchLeadsRep(contactId, bookingRep)
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))

    if (result.success) {
      updated++
      console.log(`  Fixed ${contactId} (${name}): leads_rep → "${bookingRep}"`)
    } else if (result.error?.includes('404') || result.error?.includes('NOT_FOUND')) {
      skipped++
    } else {
      failed++
      console.error(`  Failed ${contactId}: ${result.error}`)
    }
  }

  console.log(`\nDone: ${updated} fixed, ${skipped} not found, ${failed} errors`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
