-- Track each lead's position in the HOT → NEW → OLD waterfall pipeline.
-- One row per contact. Updated as the lead ages through tiers.
CREATE TABLE IF NOT EXISTS ringcx_lead_routing (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- HubSpot identity
  contact_id TEXT NOT NULL,

  -- Campaign chain (all three set at ingest time)
  hot_campaign_id TEXT,
  new_campaign_id TEXT,
  old_campaign_id TEXT,

  -- Current position
  current_campaign_id TEXT NOT NULL,
  current_tier TEXT NOT NULL CHECK (current_tier IN ('HOT', 'NEW', 'OLD')),
  ringcx_lead_id TEXT,

  -- Aging metadata
  lead_date TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ DEFAULT now(),
  moved_to_new_at TIMESTAMPTZ,
  moved_to_old_at TIMESTAMPTZ,

  -- Contact snapshot
  contact_state TEXT,
  contact_phone TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One active routing per contact
CREATE UNIQUE INDEX idx_lead_routing_contact ON ringcx_lead_routing (contact_id);

-- Fast lookup for aging cron: HOT leads past 72h threshold
CREATE INDEX idx_lead_routing_hot_aging
  ON ringcx_lead_routing (current_tier, lead_date)
  WHERE current_tier = 'HOT' AND moved_to_new_at IS NULL;

-- Fast lookup for aging cron: NEW leads past 90d threshold
CREATE INDEX idx_lead_routing_new_aging
  ON ringcx_lead_routing (current_tier, lead_date)
  WHERE current_tier = 'NEW' AND moved_to_old_at IS NULL;

-- General time-based queries
CREATE INDEX idx_lead_routing_created ON ringcx_lead_routing (created_at DESC);

-- RLS (same pattern as lead_loads)
ALTER TABLE ringcx_lead_routing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on lead routing"
  ON ringcx_lead_routing
  FOR ALL
  USING (true)
  WITH CHECK (true);
