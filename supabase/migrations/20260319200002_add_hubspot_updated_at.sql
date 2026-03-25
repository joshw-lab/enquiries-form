-- Track when HubSpot call engagement was last updated with recording URL + owner.
-- Used by recording-to-storage cron to find records needing HubSpot sync.
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS hubspot_updated_at TIMESTAMPTZ;
