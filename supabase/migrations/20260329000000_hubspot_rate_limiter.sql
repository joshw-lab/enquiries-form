-- Distributed token bucket rate limiter for HubSpot API calls.
-- All consumers (Edge Functions + Next.js) acquire a slot before calling HubSpot.
-- Refills 8 tokens/sec (HubSpot limit is 10/sec — 2 headroom).

CREATE TABLE IF NOT EXISTS hubspot_rate_limit (
  id INT PRIMARY KEY DEFAULT 1,
  tokens NUMERIC(6,2) NOT NULL DEFAULT 8,
  max_tokens INT NOT NULL DEFAULT 8,
  refill_rate INT NOT NULL DEFAULT 8,  -- tokens per second
  last_refill TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row
INSERT INTO hubspot_rate_limit (id, tokens, last_refill)
VALUES (1, 8, NOW())
ON CONFLICT (id) DO NOTHING;

-- Atomic slot acquisition with token refill.
-- Returns TRUE if a slot was acquired, FALSE if rate limit exceeded.
-- Uses advisory lock to prevent concurrent access.
CREATE OR REPLACE FUNCTION hubspot_acquire_slot()
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_tokens NUMERIC(6,2);
  v_max INT;
  v_rate INT;
  v_last TIMESTAMPTZ;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_elapsed NUMERIC;
  v_new_tokens NUMERIC(6,2);
BEGIN
  -- Advisory lock (non-blocking) — if another caller holds it, just return false
  IF NOT pg_try_advisory_xact_lock(hashtext('hubspot_rate_limit')) THEN
    RETURN FALSE;
  END IF;

  SELECT tokens, max_tokens, refill_rate, last_refill
    INTO v_tokens, v_max, v_rate, v_last
    FROM hubspot_rate_limit
   WHERE id = 1
     FOR UPDATE;

  -- Refill based on elapsed time
  v_elapsed := EXTRACT(EPOCH FROM (v_now - v_last));
  v_new_tokens := LEAST(v_max, v_tokens + (v_elapsed * v_rate));

  IF v_new_tokens >= 1 THEN
    -- Consume one token
    UPDATE hubspot_rate_limit
       SET tokens = v_new_tokens - 1,
           last_refill = v_now
     WHERE id = 1;
    RETURN TRUE;
  ELSE
    -- No tokens available — update refill time but don't consume
    UPDATE hubspot_rate_limit
       SET tokens = v_new_tokens,
           last_refill = v_now
     WHERE id = 1;
    RETURN FALSE;
  END IF;
END;
$$;

-- Allow Edge Functions and anon to call
GRANT EXECUTE ON FUNCTION hubspot_acquire_slot() TO anon, authenticated, service_role;
