-- Increase aging cron frequency to prevent backlog buildup.
--
-- HOT→NEW: was every 2h during AWST business hours (7 runs/day = 140 leads/day).
-- Now every 30 min, 24/7 (48 runs/day = 960 leads/day).
-- Lead aging is time-critical — a 72h lead sitting in HOT gets the wrong
-- dial priority and displaces genuinely hot leads.
--
-- NEW→OLD: keep at daily 5am AWST (21:00 UTC). 90-day threshold means
-- a few hours' delay is immaterial.

SELECT cron.unschedule('ringcx-lead-aging-hot');

SELECT cron.schedule(
  'ringcx-lead-aging-hot',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-aging-hot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{}'::jsonb
  );
  $$
);
