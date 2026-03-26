-- Track leads that failed to sync between HubSpot and RingCX.
-- Surfaced in dashboard to explain why counts don't match.
CREATE TABLE IF NOT EXISTS sync_failures (
  contact_id TEXT NOT NULL,
  campaign_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  tier TEXT NOT NULL,
  failure_type TEXT NOT NULL,  -- hubspot_fetch_failed, invalid_phone, ringcx_push_failed, unknown_error
  reason TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (contact_id, campaign_id)
);

-- Add missing/load_failed columns to sync_counts if not present
ALTER TABLE sync_counts ADD COLUMN IF NOT EXISTS missing INTEGER DEFAULT 0;
ALTER TABLE sync_counts ADD COLUMN IF NOT EXISTS load_failed INTEGER DEFAULT 0;
