import crypto from 'crypto'

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'

export interface TwilioConfig {
  accountSid: string
  authToken: string
  fromNumber: string
}

export function getTwilioConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_FROM_NUMBER
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER')
  }
  return { accountSid, authToken, fromNumber }
}

export interface SendSmsResult {
  sid: string
  status: string
  from: string
  to: string
  body: string
  error_code: string | null
  error_message: string | null
}

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const { accountSid, authToken, fromNumber } = getTwilioConfig()
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  const form = new URLSearchParams({ To: to, From: fromNumber, Body: body })

  const res = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })

  const data = await res.json().catch(() => ({})) as Record<string, unknown>

  if (!res.ok) {
    const msg = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`
    throw new Error(`Twilio send failed: ${msg}`)
  }

  return {
    sid: String(data.sid),
    status: String(data.status ?? 'queued'),
    from: String(data.from ?? fromNumber),
    to: String(data.to ?? to),
    body: String(data.body ?? body),
    error_code: data.error_code == null ? null : String(data.error_code),
    error_message: data.error_message == null ? null : String(data.error_message),
  }
}

/**
 * Validate a Twilio webhook signature.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Signature is HMAC-SHA1(authToken, url + sortedConcatenatedParams) base64.
 */
export function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false
  const { authToken } = getTwilioConfig()

  const sortedKeys = Object.keys(params).sort()
  let data = url
  for (const k of sortedKeys) data += k + params[k]

  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64')

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Normalize an AU phone into E.164 (+61XXXXXXXXX).
 * Returns null if the number doesn't look like a valid AU mobile/landline.
 */
export function toE164AU(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('61') && digits.length === 11) return `+${digits}`
  if (digits.startsWith('0') && digits.length === 10) return `+61${digits.substring(1)}`
  if (digits.length === 9) return `+61${digits}`
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`
  return null
}
