-- Create call_recordings table for tracking recording backup pipeline
CREATE TABLE IF NOT EXISTS call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RingCX call identifiers
  call_id TEXT NOT NULL,                    -- UII (unique interaction identifier)
  ringcx_recording_url TEXT,                -- Pre-signed RingCX recording URL (expires)

  -- Call metadata (denormalized from webhook for quick access)
  call_direction TEXT,                      -- INBOUND / OUTBOUND
  call_duration_seconds INTEGER,
  call_start TIMESTAMPTZ,
  disposition TEXT,
  phone_number TEXT,                        -- Customer phone (E.164)

  -- Agent info
  agent_id TEXT,
  agent_name TEXT,

  -- HubSpot references
  hubspot_contact_id TEXT,
  hubspot_call_id TEXT,

  -- Recording backup status
  backup_status TEXT NOT NULL DEFAULT 'pending',  -- pending, downloading, uploaded, failed, no_recording
  backup_error TEXT,
  backup_attempts INTEGER DEFAULT 0,

  -- Google Drive storage
  gdrive_file_id TEXT,
  gdrive_file_url TEXT,
  gdrive_file_name TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  backed_up_at TIMESTAMPTZ
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_recordings_call_id
  ON call_recordings(call_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_status
  ON call_recordings(backup_status);
CREATE INDEX IF NOT EXISTS idx_call_recordings_created_at
  ON call_recordings(call_start DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_agent
  ON call_recordings(agent_name);
CREATE INDEX IF NOT EXISTS idx_call_recordings_disposition
  ON call_recordings(disposition);

-- Enable Row Level Security
ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS "Service role can manage call recordings" ON call_recordings;
CREATE POLICY "Service role can manage call recordings"
  ON call_recordings
  FOR ALL
  USING (true)
  WITH CHECK (true);
