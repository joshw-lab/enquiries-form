-- Add calendar event reference columns to hubspot_form_submissions
-- Used to link a booking to its Google Calendar event for description updates
ALTER TABLE hubspot_form_submissions
  ADD COLUMN IF NOT EXISTS calendar_event_id TEXT,
  ADD COLUMN IF NOT EXISTS calendar_id TEXT;
