import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/ringcx-lead-loader-base.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
  );

  const hubspotToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
  if (!hubspotToken) {
    return new Response(JSON.stringify({ error: "No HUBSPOT_ACCESS_TOKEN" }), { status: 500 });
  }

  // Find lead_loads rows missing contact names
  const { data: rows, error } = await supabase
    .from("lead_loads")
    .select("id, contact_id")
    .is("contact_first_name", null)
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Deduplicate contact IDs
  const contactIds = [...new Set(rows.map((r: { contact_id: string }) => r.contact_id))];
  console.log(`Backfilling ${rows.length} rows across ${contactIds.length} contacts`);

  let updated = 0;
  let failed = 0;

  for (const contactId of contactIds) {
    try {
      const res = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,state,zip,email,phone,mobilephone`,
        { headers: { Authorization: `Bearer ${hubspotToken}` } }
      );

      if (!res.ok) {
        console.warn(`HubSpot ${res.status} for contact ${contactId}`);
        failed++;
        continue;
      }

      const contact = await res.json();
      const p = contact.properties || {};

      const updateData = {
        contact_first_name: p.firstname || null,
        contact_last_name: p.lastname || null,
        contact_state: p.state || null,
        contact_postcode: p.zip || null,
        contact_email: p.email || null,
        contact_phone: p.phone || p.mobilephone || null,
      };

      const { error: updateError } = await supabase
        .from("lead_loads")
        .update(updateData)
        .eq("contact_id", contactId)
        .is("contact_first_name", null);

      if (updateError) {
        console.warn(`DB update failed for ${contactId}: ${updateError.message}`);
        failed++;
      } else {
        updated++;
      }

      // Rate limit: ~5 req/sec
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`Error for ${contactId}:`, err);
      failed++;
    }
  }

  return new Response(
    JSON.stringify({ success: true, totalRows: rows.length, contactsUpdated: updated, contactsFailed: failed }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
