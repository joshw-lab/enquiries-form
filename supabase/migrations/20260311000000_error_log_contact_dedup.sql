-- Index for fast contactId-based dedup lookups on error_log.
-- Used by hasRecentFailure() in lead loader functions to skip
-- contacts that already failed within the last hour.
CREATE INDEX IF NOT EXISTS idx_error_log_contact_dedup
  ON error_log ((error_details->>'contactId'), created_at DESC);
