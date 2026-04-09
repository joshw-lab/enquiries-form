/**
 * Service area postcode filter.
 *
 * Reads allowed postcodes from the `service_area_postcodes` table.
 * Falls back to allowing the lead through if the DB query fails.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let _cachedPostcodes: ReadonlySet<string> | null = null;

/**
 * Load all service area postcodes from the database.
 * Caches for the lifetime of the edge function invocation.
 */
async function loadPostcodes(
  supabase: SupabaseClient,
): Promise<ReadonlySet<string>> {
  if (_cachedPostcodes) return _cachedPostcodes;

  const { data, error } = await supabase
    .from("service_area_postcodes")
    .select("postcode")
    .limit(5000);

  if (error || !data) {
    console.error("Failed to load service area postcodes:", error);
    // Return empty set — isInServiceArea will allow through on failure
    return new Set();
  }

  _cachedPostcodes = new Set(data.map((row: { postcode: string }) => row.postcode));
  return _cachedPostcodes;
}

/**
 * Check whether a postcode is within CHF's service areas.
 *
 * - null / undefined / empty → `{ allowed: true }` (can't determine — allow through)
 * - In set → `{ allowed: true }`
 * - Not in set → `{ allowed: false, reason: "postcode_outside_service_area" }`
 * - DB load failure → `{ allowed: true }` (fail open)
 */
export async function isInServiceArea(
  postcode: string | null | undefined,
  supabase: SupabaseClient,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!postcode || !postcode.trim()) {
    return { allowed: true };
  }

  // Extract first 4-digit sequence (handles "NSW 2000", "2000 AU", etc.)
  const match = postcode.match(/\d{4}/);
  if (!match) {
    return { allowed: true };
  }

  const postcodes = await loadPostcodes(supabase);

  // If we couldn't load postcodes, fail open
  if (postcodes.size === 0) {
    return { allowed: true };
  }

  const normalised = match[0];
  if (postcodes.has(normalised)) {
    return { allowed: true };
  }

  return { allowed: false, reason: "postcode_outside_service_area" };
}
