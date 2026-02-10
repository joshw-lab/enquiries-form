-- Allow anon (dashboard) read-only access to call_recordings
CREATE POLICY "Anon can read call recordings"
  ON call_recordings
  FOR SELECT
  USING (true);
