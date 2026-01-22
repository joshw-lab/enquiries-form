import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { google } from 'https://esm.sh/googleapis@126.0.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    // Set up Google Calendar API
    const serviceAccount = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') || '{}')

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly']
    })

    const calendar = google.calendar({ version: 'v3', auth })

    // Query calendar for specific day
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)

    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    const response = await calendar.events.list({
      calendarId: mapping.calendar_id,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    })

    const events = response.data.items || []

    // Filter for available slots
    const availableSlots = events
      .filter(event => event.summary === '(No title)' && event.start?.dateTime)
      .map(event => {
        const startTime = new Date(event.start!.dateTime!)
        const hour = startTime.getHours()

        let period = 'morning'
        if (hour >= 12 && hour < 17) period = 'afternoon'
        if (hour >= 17) period = 'evening'

        return {
          event_id: event.id,
          datetime: event.start!.dateTime,
          time: startTime.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          }),
          hour: startTime.getHours(),
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
