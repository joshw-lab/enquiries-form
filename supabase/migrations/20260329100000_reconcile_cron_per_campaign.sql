-- Replace single full-reconcile cron with per-campaign rotation + fast counts refresh.
--
-- Strategy:
--   1. */5  countsOnly       — refreshes dashboard numbers for all 19 campaigns (~18s)
--   2. */2  full reconcile   — rotates through campaigns one at a time via reconcile_cursor
--
-- Each individual campaign reconcile takes 10-30s (well within 110s Edge Function timeout).
-- Full cycle across all 18 campaigns completes in ~36 minutes.

-- Drop the old monolithic reconcile cron
SELECT cron.unschedule('ringcx-lead-reconcile');

-- ── Rotation cursor table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconcile_cursor (
  id INT PRIMARY KEY DEFAULT 1,
  campaign_index INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO reconcile_cursor (id, campaign_index) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Campaign rotation order: 12 LIST campaigns + 6 HOT campaigns = 18 total
-- The function already handles routing by campaignId, so we just pass the ID.
CREATE OR REPLACE FUNCTION get_next_reconcile_campaign_id()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  campaign_ids INT[] := ARRAY[
    -- LIST campaigns (NEW then OLD per state)
    222, 223,  -- WA
    230, 231,  -- NSW
    226, 227,  -- QLD
    234, 235,  -- ACT
    238, 239,  -- VIC
    242, 243,  -- SA
    -- HOT campaigns
    272, 273, 274, 275, 276, 277
  ];
  idx INT;
  next_id INT;
BEGIN
  SELECT campaign_index INTO idx FROM reconcile_cursor WHERE id = 1;
  idx := COALESCE(idx, 0);

  -- Wrap around
  IF idx >= array_length(campaign_ids, 1) THEN
    idx := 0;
  END IF;

  next_id := campaign_ids[idx + 1];  -- PostgreSQL arrays are 1-based

  -- Advance cursor
  UPDATE reconcile_cursor SET campaign_index = idx + 1, updated_at = NOW() WHERE id = 1;

  RETURN next_id;
END;
$$;

-- ── Cron 1: Fast counts refresh every 5 minutes ──────────────────────
SELECT cron.schedule(
  'reconcile-counts-only',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{"countsOnly": true}'::jsonb
  );
  $$
);

-- ── Cron 2: Per-campaign full reconcile every 2 minutes ──────────────
SELECT cron.schedule(
  'reconcile-per-campaign',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := format('{"dryRun": false, "campaignId": %s}', get_next_reconcile_campaign_id())::jsonb
  );
  $$
);
