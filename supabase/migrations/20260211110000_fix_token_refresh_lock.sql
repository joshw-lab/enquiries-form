-- Fix: claim the refresh slot inside the lock by updating last_refreshed_at immediately.
-- This way the second concurrent caller sees the fresh timestamp and skips,
-- even though the actual RC API call hasn't happened yet.

CREATE OR REPLACE FUNCTION acquire_token_refresh_lock(
  min_interval_seconds INT DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  auth_row RECORD;
  seconds_since_last NUMERIC;
BEGIN
  -- Advisory lock ID 8675309 — arbitrary but unique to this function.
  -- pg_advisory_xact_lock blocks concurrent callers until this TX commits.
  PERFORM pg_advisory_xact_lock(8675309);

  SELECT * INTO auth_row FROM ringcentral_auth LIMIT 1;

  IF auth_row IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'No auth row found');
  END IF;

  -- Check if we refreshed too recently (prevents double-fire from cron overlap or retries)
  seconds_since_last := EXTRACT(EPOCH FROM (now() - COALESCE(auth_row.last_refreshed_at, '1970-01-01'::timestamptz)));

  IF seconds_since_last < min_interval_seconds THEN
    RETURN jsonb_build_object(
      'status', 'skipped',
      'message', format('Token was refreshed %s seconds ago (min interval: %s)', round(seconds_since_last), min_interval_seconds),
      'last_refreshed_at', auth_row.last_refreshed_at,
      'rc_access_token_expires_at', auth_row.rc_access_token_expires_at
    );
  END IF;

  -- CLAIM the slot: update last_refreshed_at NOW so any concurrent caller
  -- that acquires the lock after this TX commits will see a recent timestamp and skip.
  -- The Edge Function will overwrite this again with the real time after the RC API call.
  UPDATE ringcentral_auth SET last_refreshed_at = now() WHERE id = auth_row.id;

  -- Return current auth data so the Edge Function can use it for the refresh call
  RETURN jsonb_build_object(
    'status', 'proceed',
    'id', auth_row.id,
    'rc_client_id', auth_row.rc_client_id,
    'rc_client_secret', auth_row.rc_client_secret,
    'rc_refresh_token', auth_row.rc_refresh_token,
    'rc_access_token_expires_at', auth_row.rc_access_token_expires_at,
    'last_refreshed_at', auth_row.last_refreshed_at
  );
END;
$$;
