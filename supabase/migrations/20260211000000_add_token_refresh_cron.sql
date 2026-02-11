-- Enable pg_net extension for scheduled HTTP calls (pg_cron is already enabled on Supabase)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule RingCentral token refresh every 30 minutes.
-- Keeps the refresh token chain alive (RC refresh tokens are single-use, 7-day TTL).
-- Uses pg_net to POST to the Edge Function.
SELECT cron.schedule(
  'ringcentral-token-refresh',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcentral-token-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{}'::jsonb
  );
  $$
);
