import { NextResponse } from 'next/server'
import { getGoogleCalendarClient } from '@/lib/server/api-clients'

/**
 * POST /api/calendar/book
 * Books a calendar slot by updating the event summary to the customer name.
 * Called after successful HubSpot form submission.
 */
export async function POST(request: Request) {
  try {
    const { calendarId, eventId, customerName } = await request.json()

    if (!calendarId || !eventId || !customerName) {
      return NextResponse.json(
        { error: 'calendarId, eventId, and customerName are required' },
        { status: 400 }
      )
    }

    const calendar = getGoogleCalendarClient()
    await calendar.updateEvent(calendarId, eventId, { summary: customerName })

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Calendar book error:', e)
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/calendar/book
 * Updates the calendar event description with compiled notes.
 * Called from the thank-you page after HubSpot workflow completes.
 */
export async function PATCH(request: Request) {
  try {
    const { calendarId, eventId, description } = await request.json()

    if (!calendarId || !eventId || !description) {
      return NextResponse.json(
        { error: 'calendarId, eventId, and description are required' },
        { status: 400 }
      )
    }

    const calendar = getGoogleCalendarClient()
    await calendar.updateEvent(calendarId, eventId, { description })

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Calendar update description error:', e)
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    )
  }
}
