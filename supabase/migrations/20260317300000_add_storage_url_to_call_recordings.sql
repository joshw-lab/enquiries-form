-- Add storage_url column for Supabase Storage audio playback URLs.
-- These are direct public URLs that work with <audio> elements (proper CORS + Range headers).
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS storage_url TEXT;
