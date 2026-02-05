-- Add agent mappings to map RingCX agents to HubSpot owners
-- This allows timezone detection and proper call attribution

-- Example: Add a mapping for an agent
-- Replace the values with actual RingCX agent_extern_id and HubSpot owner ID

-- To find HubSpot owner IDs:
-- 1. Go to HubSpot Settings > Users & Teams
-- 2. Click on a user
-- 3. The owner ID is in the URL: /contacts/{OWNER_ID}/profile

-- INSERT INTO agent_mappings (agent_extern_id, hubspot_owner_id, agent_name)
-- VALUES
--   ('ringcx-agent-123', '12345678', 'Josh Williams'),
--   ('ringcx-agent-456', '87654321', 'Another Agent');

-- To get HubSpot owner ID programmatically:
-- Use HubSpot API: GET https://api.hubapi.com/crm/v3/owners?email=agent@example.com

-- Example query to view current mappings:
SELECT
  agent_extern_id,
  hubspot_owner_id,
  agent_name,
  created_at
FROM agent_mappings
ORDER BY created_at DESC;
