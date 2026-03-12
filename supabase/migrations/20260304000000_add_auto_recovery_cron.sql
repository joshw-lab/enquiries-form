-- Auto-Recovery Cron
-- Runs every 30 minutes to catch missed webhooks throughout the day
-- Finds form submissions with no matching webhook and backfills HubSpot call engagements

-- 1. Create recovery_runs table for idempotency + audit trail
CREATE TABLE IF NOT EXISTS recovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date DATE NOT NULL,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  form_submission_id UUID,
  disposition TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, recovered, no_match, skipped, failed, already_recovered
  rc_call_id TEXT,
  rc_session_id TEXT,
  hubspot_call_id TEXT,
  recording_url TEXT,
  error_message TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint ensures idempotency: one recovery attempt per contact per day
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_unique ON recovery_runs(run_date, contact_id);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_runs(status);
CREATE INDEX IF NOT EXISTS idx_recovery_date ON recovery_runs(run_date DESC);

-- Allow anon/service role access
ALTER TABLE recovery_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON recovery_runs FOR ALL USING (true) WITH CHECK (true);

-- 2. Schedule the auto-recovery cron — every 30 minutes
SELECT cron.schedule(
  'auto-recovery-cron',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/auto-recovery-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{}'::jsonb
  );
  $$
);
