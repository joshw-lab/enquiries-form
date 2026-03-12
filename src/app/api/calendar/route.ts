import { NextResponse } from 'next/server'
import type { CalendarResponse, RegionCalendarData, CalendarDaySlot, ServiceAreaCalendar } from '@/lib/dashboard-types'
import {
  getGoogleCalendarClient,
  getServiceAreaCalendars,
  type CalendarEvent,
} from '@/lib/server/api-clients'

/**
 * A calendar event is "booked" if it has a real summary (customer name).
 * Available/empty slots have null, empty, or "(No title)" summary.
 */
function isBooked(event: CalendarEvent): boolean {
  const s = event.summary
  return !!s && s !== '(No title)' && s.trim() !== ''
}

const EMPTY_CALENDAR: RegionCalendarData = {
  slots72h: { booked: 0, total: 0 },
  slots7d: { booked: 0, total: 0 },
  daily: [],
}

export async function GET() {
  try {
    const calendar = getGoogleCalendarClient()
    const serviceAreas = await getServiceAreaCalendars()

    const now = new Date()
    const in72h = new Date(now.getTime() + 72 * 3_600_000)
    const in7d = new Date(now.getTime() + 7 * 86_400_000)

    const results: ServiceAreaCalendar[] = await Promise.all(
      serviceAreas.map(async (sa) => {
        try {
          const events = await calendar.listEvents(sa.calendarId, now.toISOString(), in7d.toISOString())
          const timed = events.filter((e) => e.start?.dateTime)

          // 72h window
          const events72h = timed.filter((e) => new Date(e.start.dateTime!) <= in72h)
          const booked72h = events72h.filter(isBooked).length

          // 7d window
          const booked7d = timed.filter(isBooked).length

          // Daily breakdown (next 7 days)
          const daily: CalendarDaySlot[] = []
          for (let i = 0; i < 7; i++) {
            const dayStart = new Date(now)
            dayStart.setDate(dayStart.getDate() + i)
            dayStart.setHours(0, 0, 0, 0)

            const dayEnd = new Date(dayStart)
            dayEnd.setDate(dayEnd.getDate() + 1)

            const dayEvents = timed.filter((e) => {
              const t = new Date(e.start.dateTime!)
              return t >= dayStart && t < dayEnd
            })

            const dayName = dayStart.toLocaleDateString('en-AU', {
              weekday: 'short',
              timeZone: 'Australia/Perth',
            })
            const dayNum = dayStart.toLocaleDateString('en-AU', {
              day: 'numeric',
              timeZone: 'Australia/Perth',
            })

            daily.push({
              day: `${dayName} ${dayNum}`,
              date: dayStart.toISOString().split('T')[0],
              booked: dayEvents.filter(isBooked).length,
              total: dayEvents.length,
            })
          }

          return {
            serviceArea: sa.serviceArea,
            region: sa.region,
            data: {
              slots72h: { booked: booked72h, total: events72h.length },
              slots7d: { booked: booked7d, total: timed.length },
              daily,
            },
          }
        } catch (e) {
          console.warn(`Calendar fetch failed for ${sa.serviceArea} (${sa.region}):`, (e as Error).message)
          return {
            serviceArea: sa.serviceArea,
            region: sa.region,
            data: { ...EMPTY_CALENDAR, daily: [] },
          }
        }
      })
    )

    const response: CalendarResponse = {
      serviceAreas: results,
      lastFetched: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (e) {
    console.error('Calendar API error:', e)
    return NextResponse.json({ serviceAreas: [], lastFetched: new Date().toISOString() } as CalendarResponse)
  }
}
