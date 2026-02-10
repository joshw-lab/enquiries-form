-- HubSpot users lookup table for resolving agent IDs to names
CREATE TABLE IF NOT EXISTS hubspot_users (
  user_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for name lookups
CREATE INDEX IF NOT EXISTS idx_hubspot_users_name
  ON hubspot_users(first_name, last_name);

-- Enable RLS
ALTER TABLE hubspot_users ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role can manage hubspot users"
  ON hubspot_users
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Anon key read-only access (for dashboard)
CREATE POLICY "Anon can read hubspot users"
  ON hubspot_users
  FOR SELECT
  USING (true);

COMMENT ON TABLE hubspot_users IS 'HubSpot user/owner lookup table for resolving agent IDs to display names in the reports dashboard';
