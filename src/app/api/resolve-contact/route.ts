import { NextRequest, NextResponse } from 'next/server'
import { getHubSpotClient } from '@/lib/server/api-clients'

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  // Australian mobile: 04xx xxx xxx → +614xx xxx xxx
  if (digits.startsWith('0') && digits.length === 10) {
    return '+61' + digits.slice(1)
  }
  // Already international without +: 614xxxxxxxx
  if (digits.startsWith('61') && digits.length === 11) {
    return '+' + digits
  }
  return raw.trim()
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

  const normalized = normalizePhone(phone)
  const digits = phone.replace(/\D/g, '')

  // Build unique filter values to avoid duplicate filter groups
  const phoneVariants = [...new Set([phone.trim(), normalized, digits])].filter(Boolean)

  const hubspot = getHubSpotClient()

  try {
    // Search HubSpot contacts by phone (try multiple formats)
    const searchResult = await hubspot.searchContacts({
      filterGroups: phoneVariants.map(value => ({
        filters: [{ propertyName: 'phone', operator: 'EQ', value }],
      })),
      properties: ['hs_object_id', 'phone', 'firstname', 'lastname', 'email'],
      limit: 1,
    })

    if (searchResult.total > 0) {
      const contact = searchResult.results[0] as { id: string; properties?: Record<string, string> }
      return NextResponse.json({
        contact_id: contact.properties?.hs_object_id || contact.id,
        created: false,
      })
    }

    // No match — create a new contact with the normalized phone
    const newContact = await hubspot.createContact({ phone: normalized })
    return NextResponse.json({
      contact_id: newContact.id,
      created: true,
    })
  } catch (err) {
    console.error('resolve-contact error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'HubSpot API error' },
      { status: 502 }
    )
  }
}
