import { NextRequest, NextResponse } from 'next/server'
import { getHubSpotClient, getSupabaseServerClient } from '@/lib/server/api-clients'
import { validateTwilioSignature } from '@/lib/server/twilio'

/**
 * Twilio inbound SMS webhook.
 * Configure Messaging → A message comes in → Webhook → POST {host}/api/sms/webhook
 * Returns empty TwiML so Twilio does not auto-reply.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of formData.entries()) params[k] = String(v)

  // Build the public URL Twilio signed against. Honour forwarded proto/host
  // since Vercel terminates TLS upstream.
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const url = `${proto}://${host}${request.nextUrl.pathname}`
  const signature = request.headers.get('x-twilio-signature')

  const skipValidation = process.env.TWILIO_SKIP_VALIDATION === 'true'
  if (!skipValidation) {
    const ok = validateTwilioSignature(signature, url, params)
    if (!ok) {
      console.warn('sms/webhook: invalid Twilio signature', { url })
      return new NextResponse('Invalid signature', { status: 403 })
    }
  }

  const from = params.From || ''
  const to = params.To || ''
  const body = params.Body || ''
  const sid = params.MessageSid || params.SmsMessageSid || ''

  if (!from || !to) {
    return new NextResponse('Missing From/To', { status: 400 })
  }

  // Best-effort: resolve the sender's HubSpot contact_id by phone.
  let contactId: string | null = null
  try {
    const hubspot = getHubSpotClient()
    const variants = phoneVariantsAU(from)
    const filterGroups = variants.flatMap(value => [
      { filters: [{ propertyName: 'phone', operator: 'EQ', value }] },
      { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value }] },
    ])
    for (let i = 0; i < filterGroups.length; i += 5) {
      const batch = filterGroups.slice(i, i + 5)
      const result = await hubspot.searchContacts({
        filterGroups: batch,
        properties: ['hs_object_id'],
        limit: 1,
      })
      if (result.total > 0) {
        const c = result.results[0] as { id: string; properties?: Record<string, string> }
        contactId = c.properties?.hs_object_id || c.id
        break
      }
    }
  } catch (err) {
    console.error('sms/webhook HubSpot lookup failed (continuing):', err)
  }

  const supabase = getSupabaseServerClient()
  const { error } = await supabase.from('sms_messages').insert({
    contact_id: contactId,
    phone_e164: from, // the other party
    direction: 'inbound',
    from_number: from,
    to_number: to,
    body,
    twilio_sid: sid || null,
    status: 'received',
  })
  if (error) {
    console.error('sms/webhook insert error:', error)
    return new NextResponse('Log failure', { status: 500 })
  }

  // Empty TwiML = no auto-reply
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

function phoneVariantsAU(raw: string): string[] {
  const digits = raw.replace(/\D/g, '')
  const variants = new Set<string>()
  let subscriber: string | null = null
  if (digits.startsWith('61') && digits.length === 11) subscriber = digits.substring(2)
  else if (digits.startsWith('0') && digits.length === 10) subscriber = digits.substring(1)
  else if (digits.length === 9) subscriber = digits
  if (subscriber) {
    variants.add(`+61${subscriber}`)
    variants.add(`0${subscriber}`)
    variants.add(`61${subscriber}`)
  } else if (raw) {
    variants.add(raw.trim())
  }
  return [...variants]
}
