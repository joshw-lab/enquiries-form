import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface DialStatsRequest {
  startDate: string;
  endDate: string;
  agent?: string;
}

interface DialStatsResponse {
  totalOutboundDials: number;
  dialsByAgent: Record<string, number>;
}

/**
 * Check if a value is an unresolved RingCX template variable (e.g. "#agent_username#")
 */
function isTemplateVar(value: string | undefined): boolean {
  if (!value) return false;
  return /^#[a-z_]+#$/i.test(value.trim());
}

/**
 * Build agent display name from webhook payload.
 * Matches the logic in ringcx-disposition-webhook/index.ts.
 * Returns "No Agent" for system-handled dials with no agent assigned.
 */
function getAgentName(payload: Record<string, unknown>): string {
  const firstName = payload.agent_first_name as string | undefined;
  const lastName = payload.agent_last_name as string | undefined;

  // Use agent_username as the primary source — agent_first_name often
  // contains the full email address (same as agent_username)
  const username = (payload.agent_username as string) || "";

  // Unresolved template variable or empty = system dial with no agent
  if (!username || isTemplateVar(username)) {
    return "No Agent";
  }

  // Email format: extract name from "coley.j+44510001_7734@company.com"
  if (username.includes("@")) {
    const namePart = username.split("@")[0].split("+")[0];
    return namePart
      .split(/[._]/)
      .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  return username;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { startDate, endDate, agent }: DialStatsRequest = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Query ringcx_webhook_logs for the date range
    // Each row = one dial attempt (both auto-fire and disposition webhooks are logged)
    // We deduplicate by call_id since each call may trigger 2 webhooks
    let query = supabase
      .from("ringcx_webhook_logs")
      .select("call_id, payload")
      .gte("processed_at", `${startDate}T00:00:00Z`)
      .lte("processed_at", `${endDate}T23:59:59Z`);

    const { data: logs, error: queryError } = await query;

    if (queryError) {
      console.error("Query error:", queryError);
      return new Response(
        JSON.stringify({ error: queryError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Deduplicate by call_id — keep the first occurrence per call
    const seenCallIds = new Set<string>();
    const uniqueLogs: Array<{ call_id: string; payload: Record<string, unknown> }> = [];

    for (const log of logs || []) {
      if (!seenCallIds.has(log.call_id)) {
        seenCallIds.add(log.call_id);
        uniqueLogs.push(log);
      }
    }

    // Count total and group by agent
    const dialsByAgent: Record<string, number> = {};

    for (const log of uniqueLogs) {
      const agentName = getAgentName(log.payload || {});
      dialsByAgent[agentName] = (dialsByAgent[agentName] || 0) + 1;
    }

    let totalOutboundDials = uniqueLogs.length;

    // Apply agent filter if requested
    if (agent) {
      totalOutboundDials = dialsByAgent[agent] || 0;
    }

    console.log(`Dial stats: ${uniqueLogs.length} unique dials (from ${(logs || []).length} webhook logs), ${Object.keys(dialsByAgent).length} agents`);

    return new Response(
      JSON.stringify({
        totalOutboundDials,
        dialsByAgent: agent ? { [agent]: totalOutboundDials } : dialsByAgent,
      } as DialStatsResponse),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in ringcx-dial-stats:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
