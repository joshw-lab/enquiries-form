-- Add leads_rep column to agent_mappings
-- This stores the HubSpot "leads_rep" property value for each agent,
-- replacing the hardcoded AGENT_LEADS_REP_OVERRIDES map in the webhook code.
-- When NULL, the webhook falls back to using agent_name as the leads_rep value.

ALTER TABLE agent_mappings ADD COLUMN IF NOT EXISTS leads_rep TEXT;

COMMENT ON COLUMN agent_mappings.leads_rep IS 'HubSpot leads_rep value for this agent. If NULL, agent_name is used instead.';

-- Populate from the previously hardcoded overrides
UPDATE agent_mappings SET leads_rep = 'Amani Neates' WHERE agent_name = 'Amani Neate';
UPDATE agent_mappings SET leads_rep = 'Ben' WHERE agent_name = 'Belinda';
UPDATE agent_mappings SET leads_rep = 'Jean Claude Guilllemain' WHERE agent_name = 'JC Guillemain';
UPDATE agent_mappings SET leads_rep = 'Bao' WHERE agent_name = 'Jason';
UPDATE agent_mappings SET leads_rep = 'Jono N' WHERE agent_name = 'Jono Ngo';
UPDATE agent_mappings SET leads_rep = 'Larissa' WHERE agent_name = 'Larissa James';
UPDATE agent_mappings SET leads_rep = 'Michael' WHERE agent_name = 'Michael Ivory';
UPDATE agent_mappings SET leads_rep = 'Nick' WHERE agent_name = 'Nick M';
UPDATE agent_mappings SET leads_rep = 'Nicolle Lovell' WHERE agent_name = 'Nicole Lovell';
UPDATE agent_mappings SET leads_rep = 'Rebecca' WHERE agent_name = 'Rebecca Johnson';
UPDATE agent_mappings SET leads_rep = 'Simon' WHERE agent_name = 'Simon Birsa';
UPDATE agent_mappings SET leads_rep = 'Szon' WHERE agent_name = 'Szon Tomkiewicz';
UPDATE agent_mappings SET leads_rep = 'Tim Rowley-Evans' WHERE agent_name = 'Timothy Rowley-Evans';
