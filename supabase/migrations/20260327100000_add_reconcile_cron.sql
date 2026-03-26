-- Simple key-value config table for edge function state
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the reconcile rotation index
INSERT INTO app_config (key, value)
VALUES ('reconcile_campaign_index', '0')
ON CONFLICT (key) DO NOTHING;

-- Reconcile cron: every 3 minutes, processes ALL 12 campaigns per run.
-- Full cycle = single invocation. Live mode (dryRun=false).
SELECT cron.schedule(
  'ringcx-lead-reconcile',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{"dryRun": false}'::jsonb
  );
  $$
);
