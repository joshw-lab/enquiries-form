-- Add hubspot_call_id column to track HubSpot call engagement ID on form submissions
ALTER TABLE hubspot_form_submissions
ADD COLUMN IF NOT EXISTS hubspot_call_id TEXT;
