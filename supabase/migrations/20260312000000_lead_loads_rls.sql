-- Enable RLS on lead_loads
ALTER TABLE lead_loads ENABLE ROW LEVEL SECURITY;

-- Service role full access (edge functions write/read)
CREATE POLICY "Service role can manage lead loads"
  ON lead_loads
  FOR ALL
  USING (true)
  WITH CHECK (true);
