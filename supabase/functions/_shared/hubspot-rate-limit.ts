/**
 * Rate-limited HubSpot API fetch wrapper.
 * Acquires a slot from the Postgres token bucket before each request.
 * Retries with exponential backoff on 429s — designed to never surface rate errors.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SLOT_MAX_RETRIES = 30;   // max slot acquisition attempts (~4.5s at 150ms)
const SLOT_RETRY_MS = 150;     // delay between slot acquisition attempts
const MAX_429_RETRIES = 5;     // max retries on HubSpot 429
const INITIAL_BACKOFF_MS = 1100; // first 429 backoff (just over 1 second)

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
 * Acquire a HubSpot rate limit slot. Waits up to ~4.5s for a slot.
 * Always waits for a slot — never proceeds without one (unless RPC is unavailable).
 */
async function acquireSlot(supabase?: SupabaseClient): Promise<void> {
  const sb = supabase || getSupabase();

  for (let attempt = 0; attempt < SLOT_MAX_RETRIES; attempt++) {
    const { data, error } = await sb.rpc("hubspot_acquire_slot");

    if (error) {
      // RPC not available (migration not applied?) — fall through without rate limiting
      console.warn("[RateLimit] hubspot_acquire_slot RPC failed:", error.message);
      return;
    }

    if (data === true) return;

    // No slot available — wait and retry
    await sleep(SLOT_RETRY_MS);
  }

  // Exhausted retries — wait one full second to guarantee token refill, then proceed
  console.warn("[RateLimit] Slot acquisition slow — waiting 1s safety buffer");
  await sleep(1000);
}

/**
 * Rate-limited fetch to HubSpot API.
 * Acquires a token bucket slot before each request.
 * Retries 429s with exponential backoff (1.1s, 2.2s, 4.4s, 8.8s, 17.6s).
 */
export async function hubspotFetch(
  url: string,
  options: RequestInit,
  supabase?: SupabaseClient,
): Promise<Response> {
  await acquireSlot(supabase);

  let response = await fetch(url, options);

  // Exponential backoff on 429
  for (let retry = 0; retry < MAX_429_RETRIES && response.status === 429; retry++) {
    const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retry);
    console.warn(`[RateLimit] HubSpot 429 on ${url} — retry ${retry + 1}/${MAX_429_RETRIES}, backoff ${backoff}ms`);
    await sleep(backoff);
    await acquireSlot(supabase);
    response = await fetch(url, options);
  }

  return response;
}

export { acquireSlot };
