import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create, getNumericDate } from 'https://deno.land/x/djwt@v2.8/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Convert PEM private key to CryptoKey
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '')

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  )
}

// Get Google access token using service account
async function getGoogleAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: getNumericDate(0),
    exp: getNumericDate(60 * 60), // 1 hour
  }

  const privateKey = await importPrivateKey(serviceAccount.private_key)

  const jwt = await create({ alg: 'RS256', typ: 'JWT' }, payload, privateKey)

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok) {
    throw new Error(`Failed to get access token: ${JSON.stringify(tokenData)}`)
  }

  return tokenData.access_token
}

// Fetch calendar events using Google Calendar API
async function fetchCalendarEvents(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<any[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  })

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  const data = await response.json()

  if (!response.ok) {
    throw new Error(`Calendar API error: ${JSON.stringify(data)}`)
  }

  return data.items || []
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const { postcode, date } = await req.json()

    if (!postcode || !date) {
      return new Response(
        JSON.stringify({ error: 'Postcode and date are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    // Look up service area
    const { data: mapping, error: mappingError } = await supabaseClient
      .from('service_area_mappings')
      .select('*')
      .lte('postcode_start', postcode)
      .gte('postcode_end', postcode)
      .single()

    if (mappingError || !mapping) {
      return new Response(
        JSON.stringify({ error: 'No service area found for this postcode' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get Google access token
    const serviceAccount = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') || '{}')
    const accessToken = await getGoogleAccessToken(serviceAccount)

    // Query calendar for specific day
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)

    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    const events = await fetchCalendarEvents(
      accessToken,
      mapping.calendar_id,
      startOfDay.toISOString(),
      endOfDay.toISOString()
    )

    // Filter for available slots - check for "(No title)", empty, null, or undefined summaries
    const availableSlots = events
      .filter(event => {
        const summary = event.summary
        const isNoTitle = !summary || summary === '(No title)' || summary.trim() === ''
        return isNoTitle && event.start?.dateTime
      })
      .map(event => {
        const startTime = new Date(event.start!.dateTime!)
        // Use Australian Eastern timezone for display
        const timeStr = startTime.toLocaleTimeString('en-AU', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'Australia/Sydney'
        })

        // Get hour in Australian Eastern timezone
        const hourStr = startTime.toLocaleTimeString('en-AU', {
          hour: 'numeric',
          hour12: false,
          timeZone: 'Australia/Sydney'
        })
        const hour = parseInt(hourStr)

        let period = 'morning'
        if (hour >= 12 && hour < 17) period = 'afternoon'
        if (hour >= 17) period = 'evening'

        return {
          event_id: event.id,
          datetime: event.start!.dateTime,
          time: timeStr,
          hour,
          period
        }
      })

    // Group by period
    const groupedByPeriod = {
      morning: availableSlots.filter(s => s.period === 'morning'),
      afternoon: availableSlots.filter(s => s.period === 'afternoon'),
      evening: availableSlots.filter(s => s.period === 'evening')
    }

    return new Response(
      JSON.stringify({
        region: mapping.region,
        service_area_name: mapping.service_area_name,
        date,
        day_display: new Date(date).toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        }),
        total_slots: availableSlots.length,
        slots: availableSlots,
        grouped_by_period: groupedByPeriod
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
