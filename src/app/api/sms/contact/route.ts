import { NextRequest, NextResponse } from 'next/server'
import { getHubSpotClient } from '@/lib/server/api-clients'
import { toE164AU } from '@/lib/server/twilio'

export async function GET(request: NextRequest) {
  const contactId = request.nextUrl.searchParams.get('contact_id')
  if (!contactId) {
    return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
  }

  const hubspot = getHubSpotClient()

  try {
    const contact = await hubspot.getContactById(contactId, [
      'firstname', 'lastname', 'phone', 'mobilephone', 'email',
    ])
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const props = contact.properties || {}
    const rawPhone = props.mobilephone || props.phone || ''
    const phoneE164 = rawPhone ? toE164AU(rawPhone) : null

    return NextResponse.json({
      contact_id: contact.id,
      first_name: props.firstname ?? null,
      last_name: props.lastname ?? null,
      email: props.email ?? null,
      phone_raw: rawPhone || null,
      phone_e164: phoneE164,
    })
  } catch (err) {
    console.error('sms/contact error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'HubSpot error' },
      { status: 502 },
    )
  }
}
