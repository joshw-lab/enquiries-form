-- Add disposition column extracted from form_data JSONB
ALTER TABLE hubspot_form_submissions
  ADD COLUMN IF NOT EXISTS disposition TEXT;

-- Backfill from existing data
UPDATE hubspot_form_submissions
  SET disposition = form_data->>'disposition'
  WHERE disposition IS NULL AND form_data->>'disposition' IS NOT NULL;

-- Index for fast filtering by disposition
CREATE INDEX IF NOT EXISTS idx_form_submissions_disposition_col
  ON hubspot_form_submissions(disposition);

-- Composite index for dashboard queries (disposition + date range)
CREATE INDEX IF NOT EXISTS idx_form_submissions_disp_date
  ON hubspot_form_submissions(disposition, created_at DESC);
