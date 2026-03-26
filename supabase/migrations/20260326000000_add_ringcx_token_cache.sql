-- Cache RingCX access tokens to avoid rate-limiting on the token exchange endpoint.
-- RingCX tokens are valid for ~5 minutes; caching avoids redundant exchanges.
ALTER TABLE ringcentral_auth
  ADD COLUMN IF NOT EXISTS ringcx_access_token TEXT,
  ADD COLUMN IF NOT EXISTS ringcx_token_expires_at TIMESTAMPTZ;
