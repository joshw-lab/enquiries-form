import { NextResponse } from 'next/server'
import type { CalendarResponse, Region, RegionCalendarData, CalendarDaySlot } from '@/lib/dashboard-types'
import { REGIONS } from '@/lib/dashboard-types'
import {
  getGoogleCalendarClient,
  getCalendarIdsFromDb,
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
    const calendarIds = await getCalendarIdsFromDb()

    const now = new Date()
    const in72h = new Date(now.getTime() + 72 * 3_600_000)
    const in7d = new Date(now.getTime() + 7 * 86_400_000)

    const regions = {} as Record<Region, RegionCalendarData>

    await Promise.all(
      REGIONS.map(async (region) => {
        const calId = calendarIds[region]
        if (!calId) {
          regions[region] = { ...EMPTY_CALENDAR, daily: [] }
          return
        }

        try {
          // Fetch all events for the next 7 days (includes the 72h window)
          const events = await calendar.listEvents(calId, now.toISOString(), in7d.toISOString())

          // Only count timed events (not all-day)
          const timed = events.filter((e) => e.start?.dateTime)

          // 72h window
          const events72h = timed.filter((e) => new Date(e.start.dateTime!) <= in72h)
          const booked72h = events72h.filter(isBooked).length

          // 7d window
          const booked7d = timed.filter(isBooked).length

          // Daily breakdown for drill panel (next 7 days)
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

          regions[region] = {
            slots72h: { booked: booked72h, total: events72h.length },
            slots7d: { booked: booked7d, total: timed.length },
            daily,
          }
        } catch (e) {
          console.warn(`Calendar fetch failed for ${region}:`, (e as Error).message)
          regions[region] = { ...EMPTY_CALENDAR, daily: [] }
        }
      })
    )

    const response: CalendarResponse = {
      regions,
      lastFetched: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (e) {
    console.error('Calendar API error:', e)
    // Return empty data so the UI doesn't break
    const regions = {} as Record<Region, RegionCalendarData>
    for (const r of REGIONS) {
      regions[r] = { ...EMPTY_CALENDAR, daily: [] }
    }
    return NextResponse.json({ regions, lastFetched: new Date().toISOString() } as CalendarResponse)
  }
}
