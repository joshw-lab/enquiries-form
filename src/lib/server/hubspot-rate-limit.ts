/**
 * Rate-limited HubSpot API fetch for Next.js server routes.
 * Acquires a slot from the Postgres token bucket before each request.
 * Retries 429s with exponential backoff — designed to never surface rate errors.
 */

import { getSupabaseServerClient } from './api-clients'

const SLOT_MAX_RETRIES = 30
const SLOT_RETRY_MS = 150
const MAX_429_RETRIES = 5
const INITIAL_BACKOFF_MS = 1100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSlot(): Promise<void> {
  const supabase = getSupabaseServerClient()

  for (let attempt = 0; attempt < SLOT_MAX_RETRIES; attempt++) {
    const { data, error } = await supabase.rpc('hubspot_acquire_slot')

    if (error) {
      console.warn('[RateLimit] hubspot_acquire_slot RPC failed:', error.message)
      return
    }

    if (data === true) return
    await sleep(SLOT_RETRY_MS)
  }

  console.warn('[RateLimit] Slot acquisition slow — waiting 1s safety buffer')
  await sleep(1000)
}

/**
 * Rate-limited fetch to HubSpot API.
 * Drop-in replacement for fetch() when calling api.hubapi.com.
 * Retries 429s with exponential backoff (1.1s, 2.2s, 4.4s, 8.8s, 17.6s).
 */
export async function hubspotFetch(
  url: string,
  options: RequestInit,
): Promise<Response> {
  await acquireSlot()

  let response = await fetch(url, options)

  for (let retry = 0; retry < MAX_429_RETRIES && response.status === 429; retry++) {
    const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retry)
    console.warn(`[RateLimit] HubSpot 429 on ${url} — retry ${retry + 1}/${MAX_429_RETRIES}, backoff ${backoff}ms`)
    await sleep(backoff)
    await acquireSlot()
    response = await fetch(url, options)
  }

  return response
}
