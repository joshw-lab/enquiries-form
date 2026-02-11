import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyGChatError } from "../gchat-notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Minimum seconds between refreshes — prevents double-fire from cron overlap
const MIN_REFRESH_INTERVAL_SECONDS = 120;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    // Step 1: Acquire advisory lock and check staleness atomically.
    // This prevents race conditions where two callers both read the same
    // single-use refresh token and one gets OAU-210.
    const { data: lockResult, error: lockError } = await supabaseClient
      .rpc("acquire_token_refresh_lock", {
        min_interval_seconds: MIN_REFRESH_INTERVAL_SECONDS,
      });

    if (lockError) {
      throw new Error(`Lock acquisition failed: ${lockError.message}`);
    }

    if (!lockResult || typeof lockResult !== "object") {
      throw new Error(`Unexpected lock result: ${JSON.stringify(lockResult)}`);
    }

    // If skipped (refreshed too recently), return success without touching RC API
    if (lockResult.status === "skipped") {
      console.log(`Token refresh skipped: ${lockResult.message}`);
      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          message: lockResult.message,
          last_refreshed_at: lockResult.last_refreshed_at,
          expires_at: lockResult.rc_access_token_expires_at,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    if (lockResult.status === "error") {
      throw new Error(lockResult.message || "Lock returned error status");
    }

    // Step 2: We have the lock and auth data — proceed with refresh
    const authId = lockResult.id;
    const clientId = lockResult.rc_client_id;
    const clientSecret = lockResult.rc_client_secret;
    const refreshToken = lockResult.rc_refresh_token;

    if (!refreshToken) {
      throw new Error("No refresh token stored — manual OAuth re-auth required");
    }

    console.log(`Refreshing RC token (last refreshed: ${lockResult.last_refreshed_at || "never"})...`);

    const credentials = btoa(`${clientId}:${clientSecret}`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const response = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const statusCode = response.status;

      // Parse RC error for specific handling
      let errorCode = "";
      try {
        const errorJson = JSON.parse(errorText);
        errorCode = errorJson.errorCode || errorJson.error || "";
      } catch (_) {
        // errorText isn't JSON, that's fine
      }

      // OAU-210 = refresh token already used or invalid
      if (errorCode === "OAU-210" || errorText.includes("OAU-210")) {
        const msg = `RC refresh token is invalid/already-used (OAU-210). ` +
          `This means the token chain is broken. Manual re-auth required via ringcentral-auth-init.`;
        console.error(msg);
        throw new Error(msg);
      }

      throw new Error(`RC token refresh failed (${statusCode}): ${errorText}`);
    }

    const tokenData = await response.json();
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + (tokenData.expires_in * 1000));

    // Step 3: Save new tokens to database
    const { error: updateError } = await supabaseClient
      .from("ringcentral_auth")
      .update({
        rc_access_token: tokenData.access_token,
        rc_refresh_token: tokenData.refresh_token,
        rc_access_token_expires_at: newExpiresAt.toISOString(),
        last_refreshed_at: now.toISOString(),
      })
      .eq("id", authId);

    if (updateError) {
      // Critical: we got new tokens from RC but couldn't save them.
      // The old refresh token is now invalid. Log everything.
      const msg = `CRITICAL: Got new tokens from RC but failed to save: ${updateError.message}. ` +
        `New refresh token may be lost — manual re-auth may be needed.`;
      console.error(msg);
      console.error(`New access token expires: ${newExpiresAt.toISOString()}`);
      throw new Error(msg);
    }

    console.log(`RC token refreshed successfully. New expiry: ${newExpiresAt.toISOString()}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Token refreshed successfully",
        expires_at: newExpiresAt.toISOString(),
        refreshed_at: now.toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("Token refresh error:", error);

    try {
      await supabaseClient.from("error_log").insert({
        source: "ringcentral-token-refresh",
        error_message: error.message || "Unknown error during token refresh",
        error_details: { error: error.message, stack: error.stack },
      });
    } catch (logError) {
      console.error("Failed to log error to database:", logError);
    }

    await notifyGChatError({
      source: "ringcentral-token-refresh",
      error: error.message || "Unknown error during token refresh",
      details: { error: error.message },
    });

    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
