/**
 * Rate-limited HubSpot API fetch wrapper.
 * Acquires a slot from the Postgres token bucket before each request.
 * Retries with backoff if rate limited (both our limiter and HubSpot 429s).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_RETRIES = 12;        // max attempts (12 × 150ms = ~1.8s max wait)
const RETRY_DELAY_MS = 150;    // delay between slot acquisition attempts
const BACKOFF_429_MS = 1100;   // delay after HubSpot 429 (just over 1 second)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  _supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "",
  );
  return _supabase;
}

/**
 * Acquire a HubSpot rate limit slot. Waits up to ~1.8s for a slot.
 * Returns true if acquired, false if timed out.
 */
async function acquireSlot(supabase?: SupabaseClient): Promise<boolean> {
  const sb = supabase || getSupabase();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, error } = await sb.rpc("hubspot_acquire_slot");

    if (error) {
      // RPC not available (migration not applied?) — fall through without rate limiting
      console.warn("[RateLimit] hubspot_acquire_slot RPC failed:", error.message);
      return true;
    }

    if (data === true) return true;

    // No slot available — wait and retry
    await sleep(RETRY_DELAY_MS);
  }

  console.warn("[RateLimit] Could not acquire HubSpot slot after max retries");
  return false;
}

/**
 * Rate-limited fetch to HubSpot API.
 * Acquires a token bucket slot before each request.
 * Automatically retries on 429 with backoff.
 */
export async function hubspotFetch(
  url: string,
  options: RequestInit,
  supabase?: SupabaseClient,
): Promise<Response> {
  // Acquire rate limit slot
  await acquireSlot(supabase);

  const response = await fetch(url, options);

  // Handle HubSpot 429 — wait and retry once
  if (response.status === 429) {
    console.warn(`[RateLimit] HubSpot 429 on ${url} — backing off ${BACKOFF_429_MS}ms`);
    await sleep(BACKOFF_429_MS);
    await acquireSlot(supabase);
    return fetch(url, options);
  }

  return response;
}

export { acquireSlot };
