-- Create ringcx_webhook_logs table for call disposition webhooks
CREATE TABLE IF NOT EXISTS ringcx_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT,
  contact_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_contact_id
  ON ringcx_webhook_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_created_at
  ON ringcx_webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ringcx_logs_status
  ON ringcx_webhook_logs(status);

-- Enable Row Level Security
ALTER TABLE ringcx_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Create policy for service role access
DROP POLICY IF EXISTS "Service role can manage webhook logs" ON ringcx_webhook_logs;
CREATE POLICY "Service role can manage webhook logs"
  ON ringcx_webhook_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);
