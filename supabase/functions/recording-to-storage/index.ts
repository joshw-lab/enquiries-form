import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Max recordings to process per batch invocation
const BATCH_SIZE = 20;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN") || null;
    if (!hubspotAccessToken) {
      throw new Error("HUBSPOT_ACCESS_TOKEN not set");
    }

    // Find recordings where VM script has set storage_url (MP3 uploaded)
    // but HubSpot hasn't been updated yet.
    const { data: pending, error: fetchError } = await supabase
      .from("call_recordings")
      .select("id, hubspot_call_id, agent_id, storage_url")
      .eq("backup_status", "uploaded")
      .not("storage_url", "is", null)
      .not("hubspot_call_id", "is", null)
      .is("hubspot_updated_at", null)
      .order("call_start", { ascending: false })
      .limit(BATCH_SIZE);

    if (fetchError) throw new Error(`Query failed: ${fetchError.message}`);

    if (!pending || pending.length === 0) {
      console.log("No recordings to sync to HubSpot");
      return new Response(
        JSON.stringify({ success: true, message: "No recordings to sync", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Syncing ${pending.length} recordings to HubSpot...`);

    let succeeded = 0;
    let failed = 0;
    const results: Array<{ id: string; status: string; hubspotOwnerId?: string | null; error?: string }> = [];

    for (const rec of pending) {
      try {
        // Look up HubSpot owner from agent_mappings
        let hubspotOwnerId: string | null = null;
        if (rec.agent_id) {
          const { data: agentMap } = await supabase
            .from("agent_mappings")
            .select("hubspot_owner_id")
            .eq("ringcx_agent_id", rec.agent_id)
            .maybeSingle();
          hubspotOwnerId = agentMap?.hubspot_owner_id || null;
        }

        // Build HubSpot properties
        const hsProperties: Record<string, string> = {
          hs_call_recording_url: rec.storage_url,
        };
        if (hubspotOwnerId) {
          hsProperties.hubspot_owner_id = hubspotOwnerId;
        }

        // PATCH HubSpot call
        const hsRes = await fetch(
          `https://api.hubapi.com/crm/v3/objects/calls/${rec.hubspot_call_id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${hubspotAccessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ properties: hsProperties }),
          }
        );

        if (hsRes.ok) {
          await supabase
            .from("call_recordings")
            .update({ hubspot_updated_at: new Date().toISOString() })
            .eq("id", rec.id);

          console.log(`  ${rec.hubspot_call_id} synced (URL + ${hubspotOwnerId ? "owner " + hubspotOwnerId : "no owner"})`);
          results.push({ id: rec.id, status: "synced", hubspotOwnerId });
          succeeded++;
        } else {
          const errText = await hsRes.text();
          console.error(`  ${rec.hubspot_call_id} failed: ${errText.substring(0, 200)}`);
          results.push({ id: rec.id, status: "failed", error: errText.substring(0, 200) });
          failed++;
        }
      } catch (err) {
        console.error(`  ${rec.id} error: ${err.message}`);
        results.push({ id: rec.id, status: "failed", error: err.message });
        failed++;
      }
    }

    console.log(`Done: ${succeeded} synced, ${failed} failed`);

    return new Response(
      JSON.stringify({ success: true, processed: pending.length, succeeded, failed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
