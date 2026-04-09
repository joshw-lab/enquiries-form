import { NextRequest, NextResponse } from 'next/server'
import { getHubSpotClient } from '@/lib/server/api-clients'

/**
 * Generate all AU phone format variants for HubSpot search.
 * Mirrors getPhoneSearchVariants() in hubspot-form-submission/index.ts
 */
function getPhoneSearchVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '')
  const variants = new Set<string>()

  let subscriber: string | null = null

  if (digits.startsWith('61') && digits.length === 11) {
    subscriber = digits.substring(2) // 61XXXXXXXXX → XXXXXXXXX
  } else if (digits.startsWith('0') && digits.length === 10) {
    subscriber = digits.substring(1) // 0XXXXXXXXX → XXXXXXXXX
  } else if (digits.length === 9) {
    subscriber = digits // XXXXXXXXX (already subscriber)
  }

  if (subscriber) {
    variants.add(`+61${subscriber}`)  // E.164
    variants.add(`0${subscriber}`)    // Local AU
    variants.add(`61${subscriber}`)   // International without +
  } else if (digits.length > 0) {
    variants.add(phone.trim())
  }

  return [...variants]
}

/**
 * Validate that input looks like a phone number (not a malformed URL param).
 * Rejects values like "{}=contact_id=123" that leak from bad screen-pop URLs.
 */
function looksLikePhone(raw: string): boolean {
  // Only allow digits, +, -, spaces, parens, dots (standard phone chars)
  if (/[^0-9+\-\s().]/i.test(raw.trim())) return false
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

export async function POST(request: NextRequest) {
  let phone: string
  try {
    const body = await request.json()
    phone = body.phone
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!phone || typeof phone !== 'string') {
    return NextResponse.json({ error: 'phone is required' }, { status: 400 })
  }

  if (!looksLikePhone(phone)) {
    console.warn(`resolve-contact: rejected non-phone input: "${phone}"`)
    return NextResponse.json({ contact_id: null, created: false })
  }

  const variants = getPhoneSearchVariants(phone)
  console.log(`resolve-contact: input="${phone}", variants=${JSON.stringify(variants)}`)

  // Build filter groups: each variant × both phone and mobilephone
  const filterGroups = variants.flatMap(value => [
    { filters: [{ propertyName: 'phone', operator: 'EQ', value }] },
    { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value }] },
  ])

  const hubspot = getHubSpotClient()

  try {
    // HubSpot allows max 5 filterGroups per request — batch if needed
    for (let i = 0; i < filterGroups.length; i += 5) {
      const batch = filterGroups.slice(i, i + 5)
      const searchResult = await hubspot.searchContacts({
        filterGroups: batch,
        properties: ['hs_object_id', 'phone', 'mobilephone', 'firstname', 'lastname', 'email'],
        limit: 1,
      })

      if (searchResult.total > 0) {
        const contact = searchResult.results[0] as { id: string; properties?: Record<string, string> }
        return NextResponse.json({
          contact_id: contact.properties?.hs_object_id || contact.id,
          created: false,
        })
      }
    }

    // No match — do NOT create a contact. The form submission handles creation with full data.
    console.log(`resolve-contact: no match found for phone="${phone}" (${variants.length} variants searched)`)
    return NextResponse.json({ contact_id: null, created: false })
  } catch (err) {
    console.error('resolve-contact error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'HubSpot API error' },
      { status: 502 }
    )
  }
}
