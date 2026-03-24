import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { notifyGChatError } from './gchat-notify.ts';

const RC_TOKEN_URL = 'https://platform.ringcentral.com/restapi/oauth/token';
const RINGCX_AUTH_URL = 'https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken';

// Buffer times (milliseconds)
const RC_TOKEN_BUFFER_MS = 5 * 60 * 1000;      // 5 minutes
const RINGCX_TOKEN_BUFFER_MS = 1 * 60 * 1000;  // 1 minute

// Token TTLs for calculating expiry
const RC_TOKEN_TTL_MS = 55 * 60 * 1000;        // 55 minutes
const RINGCX_TOKEN_TTL_MS = 4 * 60 * 1000;     // 4 minutes

interface AuthRow {
  id: string;
  rc_client_id: string;
  rc_client_secret: string;
  rc_refresh_token: string;
  rc_access_token: string | null;
  rc_access_token_expires_at: string | null;
  ringcx_access_token: string | null;
  ringcx_access_token_expires_at: string | null;
  last_refreshed_at: string | null;
  error_log: Array<{ timestamp: string; message: string }>;
}

async function logError(supabase: SupabaseClient, message: string): Promise<void> {
  const { data: auth } = await supabase
    .from('ringcentral_auth')
    .select('id, error_log')
    .single();

  if (!auth) return;

  const errorLog = auth.error_log || [];
  errorLog.push({
    timestamp: new Date().toISOString(),
    message: message,
  });

  // Keep last 10 errors
  const trimmedLog = errorLog.slice(-10);

  await supabase
    .from('ringcentral_auth')
    .update({ error_log: trimmedLog })
    .eq('id', auth.id);
}

async function refreshRCToken(supabase: SupabaseClient, auth: AuthRow): Promise<string> {
  const credentials = `${auth.rc_client_id}:${auth.rc_client_secret}`;
  const basicAuth = btoa(credentials);

  const response = await fetch(RC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.rc_refresh_token,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    await logError(supabase, `RC token refresh failed: ${response.status} - ${errorText}`);
    await notifyGChatError({ source: 'ringcentral-auth', error: `RC token refresh failed: ${response.status} - ${errorText}` });
    throw new Error(`RC token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  const now = new Date();

  const updatePayload: Record<string, unknown> = {
    rc_access_token: data.access_token,
    rc_access_token_expires_at: new Date(now.getTime() + RC_TOKEN_TTL_MS).toISOString(),
    last_refreshed_at: now.toISOString(),
  };

  // Update refresh token if rotated
  if (data.refresh_token && data.refresh_token !== auth.rc_refresh_token) {
    updatePayload.rc_refresh_token = data.refresh_token;
    console.log('RC refresh token rotated');
  }

  await supabase
    .from('ringcentral_auth')
    .update(updatePayload)
    .eq('id', auth.id);

  console.log('RC access token refreshed');
  return data.access_token;
}

async function exchangeForRingCXToken(supabase: SupabaseClient, rcAccessToken: string): Promise<string> {
  const response = await fetch(RINGCX_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      rcAccessToken: rcAccessToken,
      rcTokenType: 'Bearer',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    await logError(supabase, `RingCX token exchange failed: ${response.status} - ${errorText}`);
    await notifyGChatError({ source: 'ringcentral-auth', error: `RingCX token exchange failed: ${response.status} - ${errorText}` });
    throw new Error(`RingCX token exchange failed: ${response.status}`);
  }

  const data = await response.json();
  const now = new Date();

  // Get auth row id for update
  const { data: auth } = await supabase
    .from('ringcentral_auth')
    .select('id')
    .single();

  if (auth) {
    await supabase
      .from('ringcentral_auth')
      .update({
        ringcx_access_token: data.accessToken,
        ringcx_access_token_expires_at: new Date(now.getTime() + RINGCX_TOKEN_TTL_MS).toISOString(),
        last_refreshed_at: now.toISOString(),
      })
      .eq('id', auth.id);
  }

  console.log('RingCX token acquired');
  return data.accessToken;
}

export async function getRingCXToken(): Promise<string> {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY')!
  );

  const { data: auth, error } = await supabase
    .from('ringcentral_auth')
    .select('*')
    .single();

  if (error || !auth) {
    throw new Error(`Failed to fetch auth credentials: ${error?.message}`);
  }

  const now = new Date();

  // Check RingCX token validity
  const ringcxExpiry = auth.ringcx_access_token_expires_at
    ? new Date(auth.ringcx_access_token_expires_at)
    : null;

  if (auth.ringcx_access_token && ringcxExpiry && ringcxExpiry > new Date(now.getTime() + RINGCX_TOKEN_BUFFER_MS)) {
    console.log('Using cached RingCX token');
    return auth.ringcx_access_token;
  }

  // Check RC token validity - if expired, refresh first
  const rcExpiry = auth.rc_access_token_expires_at
    ? new Date(auth.rc_access_token_expires_at)
    : null;

  let rcAccessToken = auth.rc_access_token;

  if (!rcAccessToken || !rcExpiry || rcExpiry <= new Date(now.getTime() + RC_TOKEN_BUFFER_MS)) {
    rcAccessToken = await refreshRCToken(supabase, auth as AuthRow);
  }

  // Exchange RC token for RingCX token
  const ringcxToken = await exchangeForRingCXToken(supabase, rcAccessToken);
  return ringcxToken;
}

export function getLeadLoaderUrl(accountId: string, campaignId: string): string {
  return `https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/${accountId}/campaigns/${campaignId}/leadLoader/direct`;
}
