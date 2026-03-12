-- Track successful lead pushes to RingCX for hourly reporting.
-- Each row = one contact successfully loaded into one campaign.
CREATE TABLE IF NOT EXISTS lead_loads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_type TEXT NOT NULL,  -- 'New', 'NewHitlist', 'Old', 'OldHitlist'
  lead_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lead_loads_created ON lead_loads (created_at DESC);
