-- Lead routing events log — tracks all routing state changes for timeline display
-- Replaces deriving move events from timestamp columns on ringcx_lead_routing

CREATE TABLE IF NOT EXISTS lead_routing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'ingested',          -- first push to a campaign
    'skipped_duplicate', -- duplicate detected, push skipped to preserve state
    'moved_hot_to_new',  -- aging cron moved HOT → NEW
    'moved_new_to_old',  -- mover moved NEW → OLD
    'moved_manual'       -- manual/ad-hoc move
  )),
  from_campaign_id TEXT,
  to_campaign_id TEXT,
  from_tier TEXT CHECK (from_tier IS NULL OR from_tier IN ('HOT', 'NEW', 'OLD')),
  to_tier TEXT CHECK (to_tier IS NULL OR to_tier IN ('HOT', 'NEW', 'OLD')),
  ringcx_lead_id TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for timeline lookups by contact
CREATE INDEX idx_routing_events_contact ON lead_routing_events (contact_id, created_at DESC);

-- Index for monitoring/reporting
CREATE INDEX idx_routing_events_type ON lead_routing_events (event_type, created_at DESC);

-- RLS
ALTER TABLE lead_routing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON lead_routing_events
  FOR ALL USING (true) WITH CHECK (true);
