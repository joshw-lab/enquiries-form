import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyGChatError } from "../gchat-notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RINGCENTRAL_TOKEN_URL = "https://platform.ringcentral.com/restapi/oauth/token";
const RC_TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutes

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Generate success page
 */
function generateSuccessPage(expiresAt: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Success - RingCentral OAuth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #28a745;
    }
    .success {
      background: #d4edda;
      border: 1px solid #28a745;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
      color: #155724;
    }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
      color: #856404;
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
    }
    ul {
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅ RingCentral OAuth Setup Complete</h1>

    <div class="success">
      <strong>Success!</strong> RingCentral authentication has been initialized successfully.
    </div>

    <h2>Token Information:</h2>
    <ul>
      <li><strong>Access Token Expires:</strong> ${expiresAt}</li>
      <li><strong>Refresh Token:</strong> Saved (will be used to automatically renew access)</li>
      <li><strong>Status:</strong> Ready for use</li>
    </ul>

    <div class="warning">
      <strong>⚠️ Important - Security Cleanup Required:</strong>
      <p>For security, you MUST delete these initialization functions now that setup is complete:</p>
      <pre><code>supabase functions delete ringcentral-auth-init
supabase functions delete ringcentral-auth-callback</code></pre>
    </div>

    <h2>Next Steps:</h2>
    <ol>
      <li>Test your RingCentral integration with existing functions</li>
      <li>Verify token refresh is working automatically</li>
      <li><strong>Delete the initialization functions (see above)</strong></li>
      <li>Monitor error logs for any authentication issues</li>
    </ol>

    <h3>Testing:</h3>
    <p>Your existing RingCentral functions should now work automatically. The system will:</p>
    <ul>
      <li>Use the access token for API calls</li>
      <li>Automatically refresh the token when it expires</li>
      <li>Log any errors to the database and Google Chat</li>
    </ul>
  </div>
</body>
</html>
  `;
}

/**
 * Generate error page
 */
function generateErrorPage(error: string, details?: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - RingCentral OAuth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .error {
      background: #f8d7da;
      border: 1px solid #dc3545;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
      color: #721c24;
    }
    pre {
      background: #f4f4f4;
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ OAuth Authorization Failed</h1>
    <div class="error">
      <strong>Error:</strong> ${error}
      ${details ? `<pre>${details}</pre>` : ""}
    </div>
    <p>Please contact your administrator or check the error logs for more details.</p>
  </div>
</body>
</html>
  `;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TokenResponse> {
  // Create Basic auth header
  const credentials = btoa(`${clientId}:${clientSecret}`);

  // Build request body
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(RINGCENTRAL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Log error to database
 */
async function logError(
  supabaseClient: ReturnType<typeof createClient>,
  source: string,
  error: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await supabaseClient.from("error_log").insert({
      source,
      error_message: error,
      error_details: details || null,
    });
  } catch (logError) {
    console.error("Failed to log error to database:", logError);
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let supabaseClient: ReturnType<typeof createClient> | null = null;

  try {
    // Extract authorization code from query parameters
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Check for OAuth error
    if (error) {
      const errorMsg = `OAuth authorization failed: ${error} - ${errorDescription || "No description"}`;
      console.error(errorMsg);
      return new Response(
        generateErrorPage(error, errorDescription || undefined),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 400,
        }
      );
    }

    if (!code) {
      return new Response(
        generateErrorPage("No authorization code received", "The callback URL must include a 'code' parameter."),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 400,
        }
      );
    }

    // Initialize Supabase client
    supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch existing auth record to get credentials
    const { data: authData, error: fetchError } = await supabaseClient
      .from("ringcentral_auth")
      .select("*")
      .single();

    if (fetchError || !authData) {
      const errorMsg = "Failed to fetch RingCentral auth configuration from database";
      console.error(errorMsg, fetchError);
      await logError(supabaseClient, "ringcentral-auth-callback", errorMsg, { error: fetchError });
      return new Response(
        generateErrorPage(errorMsg),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 500,
        }
      );
    }

    // Warn if overwriting existing refresh token
    if (authData.rc_refresh_token) {
      console.warn("Warning: Overwriting existing refresh token");
    }

    const clientId = authData.rc_client_id;
    const clientSecret = authData.rc_client_secret;
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const redirectUri = `${supabaseUrl}/functions/v1/ringcentral-auth-callback`;

    console.log("Exchanging authorization code for tokens...");

    // Exchange code for tokens
    let tokenResponse: TokenResponse;
    try {
      tokenResponse = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
    } catch (exchangeError) {
      const errorMsg = exchangeError.message || "Token exchange failed";
      console.error("Token exchange error:", exchangeError);
      await logError(supabaseClient, "ringcentral-auth-callback", errorMsg, {
        error: exchangeError.message,
      });
      await notifyGChatError({
        source: "ringcentral-auth-callback",
        error: errorMsg,
        details: { exchangeError: exchangeError.message },
      });
      return new Response(
        generateErrorPage("Token exchange failed", exchangeError.message),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 500,
        }
      );
    }

    // Calculate expiry timestamp
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (tokenResponse.expires_in * 1000));

    console.log("Token exchange successful. Saving to database...");

    // Update database with tokens
    const { error: updateError } = await supabaseClient
      .from("ringcentral_auth")
      .update({
        rc_refresh_token: tokenResponse.refresh_token,
        rc_access_token: tokenResponse.access_token,
        rc_access_token_expires_at: expiresAt.toISOString(),
        last_refreshed_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", authData.id);

    if (updateError) {
      const errorMsg = "Failed to save tokens to database";
      console.error(errorMsg, updateError);
      await logError(supabaseClient, "ringcentral-auth-callback", errorMsg, { error: updateError });
      await notifyGChatError({
        source: "ringcentral-auth-callback",
        error: errorMsg,
        details: { updateError },
      });
      return new Response(
        generateErrorPage(errorMsg, JSON.stringify(updateError, null, 2)),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 500,
        }
      );
    }

    console.log("RingCentral OAuth setup completed successfully");
    console.log(`Access token expires at: ${expiresAt.toISOString()}`);

    return new Response(
      generateSuccessPage(expiresAt.toLocaleString()),
      {
        headers: { ...corsHeaders, "Content-Type": "text/html" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error in ringcentral-auth-callback:", error);

    if (supabaseClient) {
      await logError(supabaseClient, "ringcentral-auth-callback", error.message || "Unknown error", {
        error: error.message,
        stack: error.stack,
      });
      await notifyGChatError({
        source: "ringcentral-auth-callback",
        error: error.message || "Unknown error occurred",
        details: { error: error.message, stack: error.stack },
      });
    }

    return new Response(
      generateErrorPage(error.message || "Unknown error occurred"),
      {
        headers: { ...corsHeaders, "Content-Type": "text/html" },
        status: 500,
      }
    );
  }
});
