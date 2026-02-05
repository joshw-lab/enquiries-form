# RingCentral OAuth Setup Guide

This guide walks you through the one-time OAuth authorization process to obtain RingCentral API tokens.

## Overview

The RingCentral OAuth initialization system consists of:
- **Database Migration**: Creates `ringcentral_auth` and `error_log` tables
- **ringcentral-auth-init**: Admin-protected function to generate OAuth authorization URL
- **ringcentral-auth-callback**: Handles OAuth callback and saves tokens
- **gchat-notify.ts**: Shared utility for error notifications

## Prerequisites

1. RingCentral application credentials:
   - Client ID: `5rDEgouDAQwb6TfXKfMkqH`
   - Client Secret: (to be set via environment variable)

2. Supabase project configured with:
   - Project ID: `rzvuzdwhvahwqqhzmuli`
   - Service role key
   - Supabase CLI installed

## Step 1: Run Database Migration

First, apply the migration to create the necessary tables:

\`\`\`bash
supabase db push
\`\`\`

This creates:
- `ringcentral_auth` table (with initial row containing client ID)
- `error_log` table for error logging

### Update Client Secret

After the migration, update the client secret in the database:

\`\`\`sql
-- Via Supabase Dashboard SQL Editor or CLI
UPDATE ringcentral_auth
SET rc_client_secret = 'YOUR_ACTUAL_CLIENT_SECRET_HERE'
WHERE rc_client_id = '5rDEgouDAQwb6TfXKfMkqH';
\`\`\`

## Step 2: Deploy Edge Functions

Deploy the OAuth initialization functions:

\`\`\`bash
# Deploy the initialization function
supabase functions deploy ringcentral-auth-init

# Deploy the callback function
supabase functions deploy ringcentral-auth-callback
\`\`\`

## Step 3: Set Environment Variables

Set the required environment variables:

\`\`\`bash
# Generate a strong random admin secret
# Example: openssl rand -base64 32

# Set the admin secret for protecting the init endpoint
supabase secrets set ADMIN_SECRET=your-random-secret-key-here

# Optional: Set Google Chat webhook for error notifications
supabase secrets set GCHAT_ERROR_WEBHOOK_URL=your-gchat-webhook-url
\`\`\`

Required environment variables:
- `ADMIN_SECRET` - Protects the init endpoint (required)
- `SUPABASE_URL` - Automatically set by Supabase
- `SUPABASE_SERVICE_ROLE_KEY` - Automatically set by Supabase
- `GCHAT_ERROR_WEBHOOK_URL` - Optional, for error notifications

## Step 4: Run OAuth Authorization

### 4.1 Access the Init Endpoint

Call the initialization endpoint with your admin key:

\`\`\`bash
curl -H "x-admin-key: your-random-secret-key-here" \
  https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcentral-auth-init
\`\`\`

This will return an HTML page with an authorization link.

### 4.2 Authorize in Browser

1. Open the returned HTML page in a browser (or copy the authorization URL)
2. Click the "Authorize RingCentral Access" link
3. Sign in to RingCentral if prompted
4. Grant the requested permissions
5. You'll be redirected to the callback URL automatically

### 4.3 Verify Success

After authorization, you should see a success page displaying:
- Token expiration time
- Confirmation that refresh token is saved
- Instructions to delete the initialization functions

## Step 5: Verify Token Storage

Check that tokens were saved correctly:

\`\`\`sql
-- Via Supabase Dashboard SQL Editor
SELECT
  rc_client_id,
  rc_access_token IS NOT NULL as has_access_token,
  rc_refresh_token IS NOT NULL as has_refresh_token,
  rc_access_token_expires_at,
  last_refreshed_at
FROM ringcentral_auth;
\`\`\`

Expected result:
- `has_access_token`: `true`
- `has_refresh_token`: `true`
- `rc_access_token_expires_at`: Future timestamp
- `last_refreshed_at`: Recent timestamp

## Step 6: Test Integration

Test that your RingCentral integration works with the new tokens. Your existing functions should now be able to use the tokens from the database.

## Step 7: Security Cleanup (CRITICAL)

Once setup is complete and verified, **immediately delete** the initialization functions:

\`\`\`bash
# Delete the init function
supabase functions delete ringcentral-auth-init

# Delete the callback function
supabase functions delete ringcentral-auth-callback
\`\`\`

**Why this is critical:**
- These functions are only needed once for initial setup
- Leaving them deployed creates unnecessary security exposure
- The init function has admin access to generate auth URLs
- The callback function can overwrite existing tokens

## How Token Refresh Works

After initial setup, your application should:

1. Read `rc_access_token` from the `ringcentral_auth` table
2. Check if token is expired using `rc_access_token_expires_at`
3. If expired, use `rc_refresh_token` to obtain new access token
4. Update the database with new `rc_access_token` and `rc_access_token_expires_at`

Token TTL constant: `RC_TOKEN_TTL_MS = 55 * 60 * 1000` (55 minutes)

## Database Schema

### ringcentral_auth Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `rc_client_id` | TEXT | RingCentral application client ID |
| `rc_client_secret` | TEXT | RingCentral application client secret |
| `rc_refresh_token` | TEXT | OAuth refresh token (long-lived) |
| `rc_access_token` | TEXT | OAuth access token (expires) |
| `rc_access_token_expires_at` | TIMESTAMPTZ | When access token expires |
| `last_refreshed_at` | TIMESTAMPTZ | Last token refresh time |
| `created_at` | TIMESTAMPTZ | Record creation time |
| `updated_at` | TIMESTAMPTZ | Record update time |

### error_log Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `source` | TEXT | Error source (function name) |
| `error_message` | TEXT | Error message |
| `error_details` | JSONB | Additional error details |
| `created_at` | TIMESTAMPTZ | Error timestamp |

## Troubleshooting

### "Invalid admin key" error
- Verify `ADMIN_SECRET` is set correctly: `supabase secrets list`
- Ensure the `x-admin-key` header matches exactly

### "No authorization code received" error
- Check that RingCentral redirect URI is configured correctly
- Verify it matches: `https://{SUPABASE_URL}/functions/v1/ringcentral-auth-callback`

### "Token exchange failed" error
- Verify client secret is correct in database
- Check RingCentral application settings
- Review error logs: `SELECT * FROM error_log ORDER BY created_at DESC LIMIT 10`

### Token refresh not working
- Ensure your application logic checks token expiry
- Verify the refresh token is being used correctly
- Check for errors in the `error_log` table

## Files Created

\`\`\`
supabase/
├── migrations/
│   └── 20260129000000_create_ringcentral_auth.sql
├── functions/
│   ├── gchat-notify.ts
│   ├── ringcentral-auth-init/
│   │   └── index.ts
│   └── ringcentral-auth-callback/
│       └── index.ts
\`\`\`

## Security Best Practices

1. **Never commit secrets** - Use environment variables
2. **Rotate admin secret** - After setup, consider rotating the `ADMIN_SECRET`
3. **Delete init functions** - Remove them after successful setup
4. **Monitor error logs** - Regularly check `error_log` table
5. **Restrict database access** - Use RLS policies appropriately
6. **Secure client secret** - Store securely, never expose in code

## Support

For issues or questions:
- Check error logs in `error_log` table
- Review Supabase function logs
- Verify environment variables are set correctly
- Ensure RingCentral application is configured properly
