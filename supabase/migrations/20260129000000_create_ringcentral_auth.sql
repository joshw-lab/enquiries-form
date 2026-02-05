-- Create ringcentral_auth table for OAuth token management
CREATE TABLE IF NOT EXISTS ringcentral_auth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_client_id TEXT NOT NULL,
  rc_client_secret TEXT NOT NULL,
  rc_refresh_token TEXT,
  rc_access_token TEXT,
  rc_access_token_expires_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE ringcentral_auth ENABLE ROW LEVEL SECURITY;

-- Create policy for service role access
CREATE POLICY "Service role can manage ringcentral auth"
  ON ringcentral_auth
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create error_log table for logging errors
CREATE TABLE IF NOT EXISTS error_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;

-- Create policy for service role access
CREATE POLICY "Service role can manage error logs"
  ON error_log
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create index for error logs
CREATE INDEX IF NOT EXISTS idx_error_log_created_at
  ON error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_source
  ON error_log(source);

-- Insert initial row with client_id (single row table pattern)
-- Only insert if table is empty
INSERT INTO ringcentral_auth (rc_client_id, rc_client_secret)
SELECT '5rDEgouDAQwb6TfXKfMkqH', 'PLACEHOLDER_SECRET'
WHERE NOT EXISTS (SELECT 1 FROM ringcentral_auth);
