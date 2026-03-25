-- Recordings backfill cron: runs every 5 minutes, 6am-7pm AWST.
-- Matches recent Google Drive files (from RingCX SFTP) to pending
-- call_recordings rows by contact ID + timestamp.
-- AWST = UTC+8, so 6am AWST = 22:00 UTC, 7pm AWST = 11:00 UTC.
SELECT cron.schedule(
  'recordings-backfill',
  '*/5 22-23,0-11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/recordings-backfill',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6dnV6ZHdodmFod3FxaHptdWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMzQ5NDksImV4cCI6MjA4MTYxMDk0OX0.kO2tiChRPhE8_QBJQOTwMCh1TiMGX30GTpeNABWZPdc'
    ),
    body := '{"mode":"cron"}'::jsonb
  );
  $$
);
