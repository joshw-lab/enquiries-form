-- Recording to storage: runs every 5 minutes, 6am-7pm AWST only.
-- Copies recordings from Google Drive to Supabase Storage for
-- inline audio playback and HubSpot recording URL updates.
-- AWST = UTC+8, so 6am AWST = 22:00 UTC, 7pm AWST = 11:00 UTC.
SELECT cron.schedule(
  'recording-to-storage',
  '*/5 22-23,0-11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/recording-to-storage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{}'::jsonb
  );
  $$
);
