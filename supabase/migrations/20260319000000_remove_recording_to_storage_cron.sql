-- Remove the recording-to-storage Edge Function cron job.
-- WAV→MP3 conversion and Supabase Storage upload is now handled by
-- the GCE VM script at /opt/recording-converter/convert-recordings.sh
-- The Edge Function code is preserved for manual/one-off use.
SELECT cron.unschedule('recording-to-storage');
