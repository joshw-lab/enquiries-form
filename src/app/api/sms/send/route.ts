import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/server/api-clients'
import { getTwilioConfig, sendSms, toE164AU } from '@/lib/server/twilio'

export async function POST(request: NextRequest) {
  let body: { contact_id?: string; to?: string; message?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const contactId = body.contact_id?.trim() || null
  const toRaw = body.to?.trim() || ''
  const message = body.message?.trim() || ''

  if (!toRaw) return NextResponse.json({ error: 'to is required' }, { status: 400 })
  if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 })
  if (message.length > 1600) {
    return NextResponse.json({ error: 'message exceeds 1600 chars' }, { status: 400 })
  }

  const to = toE164AU(toRaw)
  if (!to) return NextResponse.json({ error: `Could not normalize "${toRaw}" to E.164` }, { status: 400 })

  let result
  try {
    result = await sendSms(to, message)
  } catch (err) {
    console.error('sms/send Twilio error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Twilio error' },
      { status: 502 },
    )
  }

  const { fromNumber } = getTwilioConfig()
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('sms_messages')
    .insert({
      contact_id: contactId,
      phone_e164: to,
      direction: 'outbound',
      from_number: result.from || fromNumber,
      to_number: result.to || to,
      body: message,
      twilio_sid: result.sid,
      status: result.status,
      error_code: result.error_code,
    })
    .select()
    .single()

  if (error) {
    console.error('sms/send insert error:', error)
    // SMS was sent; surface the Twilio SID so caller isn't left hanging.
    return NextResponse.json(
      { error: `Sent but failed to log: ${error.message}`, twilio_sid: result.sid },
      { status: 500 },
    )
  }

  return NextResponse.json({ message: data })
}
