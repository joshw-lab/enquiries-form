-- Create hubspot_form_submissions table for audit trail
CREATE TABLE IF NOT EXISTS hubspot_form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'web',
  submitted_by JSONB,
  contact JSONB,
  form_data JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for querying
CREATE INDEX IF NOT EXISTS idx_form_submissions_created_at
  ON hubspot_form_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_disposition
  ON hubspot_form_submissions((form_data->>'disposition'));

-- Create ringcx_webhook_logs table for call disposition webhooks
CREATE TABLE IF NOT EXISTS ringcx_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  hubspot_call_id TEXT,
  hubspot_contact_id TEXT,
  status TEXT DEFAULT 'received',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for webhook logs
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_call_id
  ON ringcx_webhook_logs(call_id);
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_created_at
  ON ringcx_webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_status
  ON ringcx_webhook_logs(status);

-- Enable Row Level Security
ALTER TABLE hubspot_form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ringcx_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Create policies for service role access
CREATE POLICY "Service role can manage form submissions"
  ON hubspot_form_submissions
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can manage webhook logs"
  ON ringcx_webhook_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);
