-- Clean up MP3 recordings older than 30 days from Supabase Storage.
-- Runs daily at 3am AWST (19:00 UTC) — outside business hours.
-- Deletes the storage object and nulls out storage_url so the frontend
-- falls back to the Google Drive streaming proxy.
SELECT cron.schedule(
  'cleanup-old-recordings',
  '0 19 * * *',
  $$
  -- Delete storage objects older than 30 days
  DELETE FROM storage.objects
  WHERE bucket_id = 'call-recordings'
    AND created_at < now() - interval '30 days';

  -- Clear storage_url so frontend falls back to Drive proxy
  UPDATE call_recordings
  SET storage_url = NULL
  WHERE storage_url IS NOT NULL
    AND call_start < now() - interval '30 days';
  $$
);
