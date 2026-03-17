-- Store contact identity data on lead loads for queue visibility and search.
ALTER TABLE lead_loads
  ADD COLUMN IF NOT EXISTS contact_first_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_last_name  TEXT,
  ADD COLUMN IF NOT EXISTS contact_state      TEXT,
  ADD COLUMN IF NOT EXISTS contact_postcode   TEXT,
  ADD COLUMN IF NOT EXISTS contact_email      TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone      TEXT;
