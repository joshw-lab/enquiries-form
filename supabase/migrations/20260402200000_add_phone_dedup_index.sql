-- Partial index to support cross-contact phone dedup check in ringcx-lead-ingest.
-- Only indexes active (non-removed) leads with a known phone number.
CREATE INDEX IF NOT EXISTS idx_lead_routing_phone_active
  ON ringcx_lead_routing (contact_phone)
  WHERE removed_at IS NULL AND contact_phone IS NOT NULL;
