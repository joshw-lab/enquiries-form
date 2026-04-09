#!/usr/bin/env node
/**
 * Audit: find contacts created by the system (resolve-contact endpoint)
 * in the last 30 days. These are blank contacts with phone but no firstname/email.
 */
import { readFileSync } from 'fs'

// Load .env.local manually
const envFile = readFileSync('.env.local', 'utf8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
}

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY
if (!HUBSPOT_API_KEY) {
  console.error('Missing HUBSPOT_API_KEY in .env.local')
  process.exit(1)
}

const API = 'https://api.hubapi.com'
const headers = {
  Authorization: `Bearer ${HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json',
}

const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

// Search for contacts created in last 30 days with phone set but no firstname
// This is the signature of resolve-contact auto-creation (blank contacts with only phone)
async function searchBlankContacts() {
  let after = undefined
  const results = []

  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'createdate', operator: 'GTE', value: thirtyDaysAgo },
            { propertyName: 'phone', operator: 'HAS_PROPERTY' },
            { propertyName: 'firstname', operator: 'NOT_HAS_PROPERTY' },
            { propertyName: 'email', operator: 'NOT_HAS_PROPERTY' },
          ],
        },
      ],
      properties: [
        'hs_object_id', 'phone', 'mobilephone', 'firstname', 'lastname',
        'email', 'createdate', 'hs_analytics_source', 'hs_all_contact_vids',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100,
    }
    if (after) body.after = after

    const res = await fetch(`${API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      console.error(`HubSpot search failed (${res.status}):`, await res.text())
      break
    }

    const data = await res.json()
    results.push(...data.results)

    if (data.paging?.next?.after) {
      after = data.paging.next.after
    } else {
      break
    }
  }

  return results
}

// Also search for contacts that HAVE firstname but were created via API
// (not form submission) — these could be the "duplicate with data" case
async function searchAPICreatedContacts() {
  let after = undefined
  const results = []

  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'createdate', operator: 'GTE', value: thirtyDaysAgo },
            { propertyName: 'hs_analytics_source', operator: 'EQ', value: 'API' },
          ],
        },
      ],
      properties: [
        'hs_object_id', 'phone', 'mobilephone', 'firstname', 'lastname',
        'email', 'createdate', 'hs_analytics_source', 'hs_lead_status',
        'lifecyclestage',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100,
    }
    if (after) body.after = after

    const res = await fetch(`${API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      console.error(`HubSpot API-source search failed (${res.status}):`, await res.text())
      break
    }

    const data = await res.json()
    results.push(...data.results)

    if (data.paging?.next?.after) {
      after = data.paging.next.after
    } else {
      break
    }
  }

  return results
}

console.log('=== Auditing system-created HubSpot contacts (last 30 days) ===\n')

console.log('--- Category 1: Blank contacts (phone only, no name/email) ---')
const blankContacts = await searchBlankContacts()
console.log(`Found: ${blankContacts.length} blank contacts\n`)
for (const c of blankContacts) {
  const p = c.properties
  console.log(`  ID: ${p.hs_object_id}  Phone: ${p.phone || '-'}  Mobile: ${p.mobilephone || '-'}  Created: ${p.createdate}`)
}

console.log('\n--- Category 2: All API-sourced contacts (potential duplicates with data) ---')
const apiContacts = await searchAPICreatedContacts()
console.log(`Found: ${apiContacts.length} API-created contacts\n`)
for (const c of apiContacts) {
  const p = c.properties
  console.log(`  ID: ${p.hs_object_id}  Name: ${(p.firstname || '') + ' ' + (p.lastname || '')}  Phone: ${p.phone || '-'}  Email: ${p.email || '-'}  Created: ${p.createdate}  Status: ${p.hs_lead_status || '-'}`)
}

// Check for phone duplicates among API-created contacts
console.log('\n--- Phone duplicate check (API-created contacts sharing phone with others) ---')
const phoneMap = new Map()
for (const c of apiContacts) {
  const phone = c.properties.phone
  if (!phone) continue
  const digits = phone.replace(/\D/g, '').slice(-9) // last 9 digits for AU comparison
  if (!phoneMap.has(digits)) phoneMap.set(digits, [])
  phoneMap.get(digits).push(c)
}

let dupeCount = 0
for (const [digits, contacts] of phoneMap) {
  if (contacts.length > 1) {
    dupeCount += contacts.length - 1
    console.log(`\n  Phone (last 9): ...${digits}`)
    for (const c of contacts) {
      const p = c.properties
      console.log(`    ID: ${p.hs_object_id}  Name: ${(p.firstname || '') + ' ' + (p.lastname || '')}  Created: ${p.createdate}`)
    }
  }
}

console.log(`\n=== Summary ===`)
console.log(`Blank contacts (resolve-contact created): ${blankContacts.length}`)
console.log(`API-sourced contacts total: ${apiContacts.length}`)
console.log(`Phone duplicates within API-sourced: ${dupeCount}`)
