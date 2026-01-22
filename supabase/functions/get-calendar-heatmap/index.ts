import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { google } from 'https://esm.sh/googleapis@126.0.0'

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

    // Set up Google Calendar API
    const serviceAccount = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') || '{}')

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly']
    })

    const calendar = google.calendar({ version: 'v3', auth })

    // Query calendar for next N days
    const now = new Date()
    const futureDate = new Date()
    futureDate.setDate(now.getDate() + days_ahead)

    const response = await calendar.events.list({
      calendarId: mapping.calendar_id,
      timeMin: now.toISOString(),
      timeMax: futureDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    })

    const events = response.data.items || []

    // Filter for available slots "(No title)"
    const availableSlots = events.filter(event =>
      event.summary === '(No title)' && event.start?.dateTime
    )

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
