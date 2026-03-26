/**
 * Rate-limited HubSpot API fetch for Next.js server routes.
 * Acquires a slot from the Postgres token bucket before each request.
 */

import { getSupabaseServerClient } from './api-clients'

const MAX_RETRIES = 12
const RETRY_DELAY_MS = 150
const BACKOFF_429_MS = 1100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSlot(): Promise<boolean> {
  const supabase = getSupabaseServerClient()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, error } = await supabase.rpc('hubspot_acquire_slot')

    if (error) {
      // RPC not available — fall through without rate limiting
      console.warn('[RateLimit] hubspot_acquire_slot RPC failed:', error.message)
      return true
    }

    if (data === true) return true
    await sleep(RETRY_DELAY_MS)
  }

  console.warn('[RateLimit] Could not acquire HubSpot slot after max retries')
  return false
}

/**
 * Rate-limited fetch to HubSpot API.
 * Drop-in replacement for fetch() when calling api.hubapi.com.
 */
export async function hubspotFetch(
  url: string,
  options: RequestInit,
): Promise<Response> {
  await acquireSlot()

  const response = await fetch(url, options)

  if (response.status === 429) {
    console.warn(`[RateLimit] HubSpot 429 on ${url} — backing off ${BACKOFF_429_MS}ms`)
    await sleep(BACKOFF_429_MS)
    await acquireSlot()
    return fetch(url, options)
  }

  return response
}
