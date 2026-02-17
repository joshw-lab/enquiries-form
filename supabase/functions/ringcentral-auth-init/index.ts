import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
};

const RINGCENTRAL_AUTH_URL = "https://platform.ringcentral.com/restapi/oauth/authorize";

/**
 * Generate HTML page with authorization link
 */
function generateAuthPage(authUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RingCentral OAuth Initialization</title>
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
      color: #333;
      margin-bottom: 10px;
    }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
      color: #856404;
    }
    .info {
      background: #d1ecf1;
      border: 1px solid #17a2b8;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
      color: #0c5460;
    }
    .auth-link {
      display: inline-block;
      background: #0066cc;
      color: white;
      padding: 15px 30px;
      text-decoration: none;
      border-radius: 4px;
      font-weight: bold;
      margin: 20px 0;
      transition: background 0.3s;
    }
    .auth-link:hover {
      background: #0052a3;
    }
    ol {
      line-height: 1.8;
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 RingCentral OAuth Initialization</h1>

    <div class="warning">
      <strong>⚠️ Admin Only:</strong> This is a one-time setup process. Only authorized administrators should proceed.
    </div>

    <div class="info">
      <strong>ℹ️ What this does:</strong> This will authorize the application to access RingCentral APIs and obtain a refresh token for ongoing authentication.
    </div>

    <h2>Instructions:</h2>
    <ol>
      <li>Click the authorization link below</li>
      <li>Sign in to RingCentral if prompted</li>
      <li>Grant the requested permissions</li>
      <li>You will be redirected back to complete the setup</li>
      <li><strong>After successful setup, delete these initialization functions for security</strong></li>
    </ol>

    <a href="${authUrl}" class="auth-link">Authorize RingCentral Access</a>

    <h3>Security Notes:</h3>
    <ul>
      <li>This page should only be accessed by administrators</li>
      <li>The authorization is protected by the admin secret key</li>
      <li>After setup, run: <code>supabase functions delete ringcentral-auth-init</code></li>
      <li>And: <code>supabase functions delete ringcentral-auth-callback</code></li>
    </ul>
  </div>
</body>
</html>
  `;
}

/**
 * Generate error page
 */
function generateErrorPage(error: string): string {
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
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ Error</h1>
    <div class="error">
      <strong>Error:</strong> ${error}
    </div>
  </div>
</body>
</html>
  `;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify admin secret key (from header or query param)
    const url = new URL(req.url);
    const adminKey = req.headers.get("x-admin-key") || url.searchParams.get("admin_key");
    const expectedAdminKey = Deno.env.get("ADMIN_SECRET");

    if (!expectedAdminKey) {
      console.error("ADMIN_SECRET environment variable not configured");
      return new Response(
        generateErrorPage("Server configuration error: ADMIN_SECRET not set"),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 500,
        }
      );
    }

    if (adminKey !== expectedAdminKey) {
      console.error("Invalid admin key provided");
      return new Response(
        generateErrorPage("Unauthorized: Invalid admin key"),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 401,
        }
      );
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch the RingCentral client ID from database
    const { data: authData, error: fetchError } = await supabaseClient
      .from("ringcentral_auth")
      .select("rc_client_id, rc_refresh_token")
      .single();

    if (fetchError || !authData) {
      console.error("Failed to fetch RingCentral auth config:", fetchError);
      return new Response(
        generateErrorPage("Failed to fetch RingCentral configuration from database"),
        {
          headers: { ...corsHeaders, "Content-Type": "text/html" },
          status: 500,
        }
      );
    }

    // Warn if refresh token already exists
    if (authData.rc_refresh_token) {
      console.warn("Warning: Refresh token already exists. This will overwrite it.");
    }

    const clientId = authData.rc_client_id;
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const callbackUrl = `${supabaseUrl}/functions/v1/ringcentral-auth-callback`;

    // Generate authorization URL
    const authUrl = new URL(RINGCENTRAL_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", callbackUrl);

    console.log("Generated authorization URL for client:", clientId);

    return new Response(
      generateAuthPage(authUrl.toString()),
      {
        headers: { ...corsHeaders, "Content-Type": "text/html" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error in ringcentral-auth-init:", error);
    return new Response(
      generateErrorPage(error.message || "Unknown error occurred"),
      {
        headers: { ...corsHeaders, "Content-Type": "text/html" },
        status: 500,
      }
    );
  }
});
