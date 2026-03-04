-- Add hubspot_contact_id column to track HubSpot sync status directly on form submissions
ALTER TABLE hubspot_form_submissions
ADD COLUMN IF NOT EXISTS hubspot_contact_id TEXT;
