-- Store dial priority decision data on each lead load for queue visibility.
ALTER TABLE lead_loads
  ADD COLUMN dial_priority TEXT DEFAULT 'NORMAL',
  ADD COLUMN priority_reason TEXT,
  ADD COLUMN priority_context JSONB;

CREATE INDEX idx_lead_loads_priority ON lead_loads (dial_priority, created_at DESC);

-- Backfill existing rows as UNKNOWN (loaded before priority tracking)
UPDATE lead_loads SET dial_priority = 'UNKNOWN' WHERE dial_priority IS NULL;
