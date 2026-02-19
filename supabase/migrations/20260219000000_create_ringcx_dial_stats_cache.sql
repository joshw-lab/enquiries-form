-- Cache table for RingCX dial stats to avoid hitting rate limits (2 req/min)
CREATE TABLE IF NOT EXISTS ringcx_dial_stats_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT UNIQUE NOT NULL,
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  total_outbound_dials INTEGER NOT NULL DEFAULT 0,
  dials_by_agent JSONB NOT NULL DEFAULT '{}',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dial_stats_cache_key
  ON ringcx_dial_stats_cache(cache_key);

-- Enable RLS
ALTER TABLE ringcx_dial_stats_cache ENABLE ROW LEVEL SECURITY;

-- Service role full access (edge function writes)
CREATE POLICY "Service role can manage dial stats cache"
  ON ringcx_dial_stats_cache
  FOR ALL
  USING (true)
  WITH CHECK (true);
