-- Add soft-delete and reconciliation support to lead routing tables.
-- Enables the ringcx-lead-reconcile function to archive orphaned leads.

-- 1. Add soft-delete columns to ringcx_lead_routing
ALTER TABLE ringcx_lead_routing
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removal_reason TEXT;

-- 2. Replace the unique index with a partial index (allows archived + active rows for same contact)
DROP INDEX IF EXISTS idx_lead_routing_contact;
CREATE UNIQUE INDEX idx_lead_routing_contact ON ringcx_lead_routing (contact_id) WHERE removed_at IS NULL;

-- 3. Index for filtering active-only routing entries by campaign
CREATE INDEX IF NOT EXISTS idx_lead_routing_active
  ON ringcx_lead_routing (current_campaign_id)
  WHERE removed_at IS NULL;

-- 4. Add ARCHIVED tier option
ALTER TABLE ringcx_lead_routing DROP CONSTRAINT IF EXISTS ringcx_lead_routing_current_tier_check;
ALTER TABLE ringcx_lead_routing ADD CONSTRAINT ringcx_lead_routing_current_tier_check
  CHECK (current_tier IN ('HOT', 'NEW', 'OLD', 'ARCHIVED'));

-- 5. Extend event_type constraint to include reconciliation events
ALTER TABLE lead_routing_events DROP CONSTRAINT IF EXISTS lead_routing_events_event_type_check;
ALTER TABLE lead_routing_events ADD CONSTRAINT lead_routing_events_event_type_check
  CHECK (event_type IN (
    'ingested',
    'skipped_duplicate',
    'moved_hot_to_new',
    'moved_new_to_old',
    'moved_manual',
    'reconcile_moved',      -- lead moved to correct campaign (was in wrong tier)
    'reconcile_archived',   -- lead moved to archive campaign (not in any list)
    'reconcile_orphaned'    -- routing row cleaned up (no RingCX lead to move)
  ));
