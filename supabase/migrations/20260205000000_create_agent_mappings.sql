-- Create agent_mappings table to map RingCX agents to HubSpot owners/users
-- This allows the webhook to fetch agent timezone and assign calls to the correct owner

CREATE TABLE IF NOT EXISTS agent_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_extern_id TEXT UNIQUE NOT NULL,  -- RingCX agent external ID
  hubspot_owner_id TEXT NOT NULL,        -- HubSpot owner/user ID
  agent_name TEXT,                       -- Agent display name (for reference)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_agent_mappings_extern_id
  ON agent_mappings(agent_extern_id);

-- Enable Row Level Security
ALTER TABLE agent_mappings ENABLE ROW LEVEL SECURITY;

-- Create policy for service role access
DROP POLICY IF EXISTS "Service role can manage agent mappings" ON agent_mappings;
CREATE POLICY "Service role can manage agent mappings"
  ON agent_mappings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add helpful comments
COMMENT ON TABLE agent_mappings IS 'Maps RingCX agent IDs to HubSpot owner IDs for call attribution and timezone handling';
COMMENT ON COLUMN agent_mappings.agent_extern_id IS 'External agent ID from RingCX (e.g., from #agent_extern_id# tag)';
COMMENT ON COLUMN agent_mappings.hubspot_owner_id IS 'HubSpot owner/user ID to assign calls to and fetch timezone from';
