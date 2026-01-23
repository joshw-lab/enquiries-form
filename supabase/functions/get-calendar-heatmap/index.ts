import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create, getNumericDate } from 'https://deno.land/x/djwt@v2.8/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ConversionPriority {
  priority: string
  label: string
  color: string
  icon: string
  conversionRate: string
  message: string
  priorityScore: number
}

function getConversionPriority(daysFromNow: number): ConversionPriority {
  if (daysFromNow === 0) {
    return {
      priority: 'CRITICAL',
      label: 'TODAY',
      color: '#DC2626',
      icon: '🔥🔥🔥',
      conversionRate: '~85%',
      message: 'Book NOW - Highest close rate',
      priorityScore: 100
    }
  }

  if (daysFromNow === 1) {
    return {
      priority: 'URGENT',
      label: 'TOMORROW',
      color: '#EA580C',
      icon: '🔥🔥🔥',
      conversionRate: '~75%',
      message: 'Next 24 hours - Very high close rate',
      priorityScore: 95
    }
  }

  if (daysFromNow === 2) {
    return {
      priority: 'HOT',
      label: 'HOT',
      color: '#F97316',
      icon: '🔥🔥',
      conversionRate: '~65%',
      message: '24-48 hours - High close rate',
      priorityScore: 85
    }
  }

  if (daysFromNow <= 7) {
    return {
      priority: 'WARM',
      label: 'WARM',
      color: '#F59E0B',
      icon: '🟠',
      conversionRate: '~50%',
      message: 'This week - Good close rate',
      priorityScore: 60
    }
  }

  return {
    priority: 'COOLING',
    label: 'COOLING',
    color: '#10B981',
    icon: '🟡',
    conversionRate: '~30%',
    message: 'Week+ out - Lower close rate',
    priorityScore: 30
  }
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
  const now = Math.floor(Date.now() / 1000)

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
    maxResults: '2500',
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
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const { postcode, days_ahead = 14 } = await req.json()

    if (!postcode) {
      return new Response(
        JSON.stringify({ error: 'Postcode is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    // Look up service area by postcode
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

    // Query calendar for next N days
    const now = new Date()
    const futureDate = new Date()
    futureDate.setDate(now.getDate() + days_ahead)

    const events = await fetchCalendarEvents(
      accessToken,
      mapping.calendar_id,
      now.toISOString(),
      futureDate.toISOString()
    )

    // Debug: Log total events and some sample summaries
    console.log(`Total events from calendar: ${events.length}`)
    if (events.length > 0) {
      const sampleSummaries = events.slice(0, 10).map(e => e.summary || '(undefined)')
      console.log(`Sample event summaries: ${JSON.stringify(sampleSummaries)}`)
    }

    // Filter for available slots - check for "(No title)", empty, null, or undefined summaries
    const availableSlots = events.filter(event => {
      const summary = event.summary
      const isNoTitle = !summary || summary === '(No title)' || summary.trim() === ''
      return isNoTitle && event.start?.dateTime
    })

    console.log(`Available slots after filter: ${availableSlots.length}`)

    // Debug: Log events that have "No title" in summary (partial match)
    const partialMatches = events.filter(e => e.summary && e.summary.toLowerCase().includes('no title'))
    console.log(`Events with "No title" in summary: ${partialMatches.length}`)
    if (partialMatches.length > 0) {
      console.log(`Partial match summaries: ${JSON.stringify(partialMatches.slice(0, 5).map(e => e.summary))}`)
    }

    // Group by day and calculate heat map
    const dailyAvailability = new Map<string, any>()

    for (let i = 0; i < days_ahead; i++) {
      const date = new Date()
      date.setDate(now.getDate() + i)
      const dateStr = date.toISOString().split('T')[0]

      const daySlots = availableSlots.filter(slot => {
        const slotDate = new Date(slot.start!.dateTime!)
        return slotDate.toISOString().split('T')[0] === dateStr
      })

      const priority = getConversionPriority(i)

      dailyAvailability.set(dateStr, {
        date: dateStr,
        day_name: date.toLocaleDateString('en-US', { weekday: 'short' }),
        day_number: date.getDate(),
        month_name: date.toLocaleDateString('en-US', { month: 'short' }),
        available_count: daySlots.length,
        ...priority
      })
    }

    // Group into urgency tiers
    const dailyArray = Array.from(dailyAvailability.values())

    const critical = dailyArray.filter(d => d.priorityScore === 100)
    const urgent = dailyArray.filter(d => d.priorityScore >= 85 && d.priorityScore < 100)
    const warm = dailyArray.filter(d => d.priorityScore >= 50 && d.priorityScore < 85)
    const cooling = dailyArray.filter(d => d.priorityScore < 50)

    return new Response(
      JSON.stringify({
        region: mapping.region,
        service_area_name: mapping.service_area_name,
        coverage_description: mapping.coverage_description,
        priority_breakdown: {
          critical: {
            label: 'TODAY',
            days: critical,
            total_slots: critical.reduce((sum, d) => sum + d.available_count, 0)
          },
          urgent: {
            label: 'NEXT 24-48 HOURS',
            days: urgent,
            total_slots: urgent.reduce((sum, d) => sum + d.available_count, 0)
          },
          warm: {
            label: 'THIS WEEK',
            days: warm,
            total_slots: warm.reduce((sum, d) => sum + d.available_count, 0)
          },
          cooling: {
            label: 'WEEK+',
            days: cooling,
            total_slots: cooling.reduce((sum, d) => sum + d.available_count, 0)
          }
        },
        total_slots_available: availableSlots.length
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
