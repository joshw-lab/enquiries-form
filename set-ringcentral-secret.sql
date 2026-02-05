-- One-time script to set RingCentral client secret
-- IMPORTANT: Replace YOUR_CLIENT_SECRET_HERE with your actual secret
-- Then run: supabase db execute -f set-ringcentral-secret.sql
-- After running, DELETE THIS FILE for security

UPDATE ringcentral_auth
SET rc_client_secret = 'YOUR_CLIENT_SECRET_HERE'
WHERE rc_client_id = '5rDEgouDAQwb6TfXKfMkqH';

-- Verify it was set (won't show the secret, just confirms it exists)
SELECT
  rc_client_id,
  rc_client_secret IS NOT NULL as secret_is_set,
  rc_client_secret != 'PLACEHOLDER_SECRET' as secret_is_updated,
  created_at
FROM ringcentral_auth;
