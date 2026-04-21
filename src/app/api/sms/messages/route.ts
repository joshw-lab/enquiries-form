import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/server/api-clients'

export async function GET(request: NextRequest) {
  const phone = request.nextUrl.searchParams.get('phone')
  if (!phone) {
    return NextResponse.json({ error: 'phone is required' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, direction, from_number, to_number, body, status, twilio_sid, error_code, created_at')
    .eq('phone_e164', phone)
    .order('created_at', { ascending: true })
    .limit(500)

  if (error) {
    console.error('sms/messages error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ messages: data ?? [] })
}
