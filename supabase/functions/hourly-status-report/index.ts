import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Resend free tier: can only send to account owner until domain is verified.
// Change to ringcentral-alerts-monitoring@completehomefiltration.com.au after domain verification.
const ALERT_EMAIL = "josh.w@completehomefiltration.com.au";
const SENDER_EMAIL = "onboarding@resend.dev";

serve(async (_req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    const resendApiKey = Deno.env.get("RESEND_API_KEY") || Deno.env.get("RESEND_API_Key");
    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured");
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const hourLabel = `${now.toISOString().slice(0, 13)}:00 AEST`; // approximate

    // --- 1. Leads loaded (from lead_loads table) ---
    const { count: leadsLoaded } = await supabase
      .from("lead_loads")
      .select("*", { count: "exact", head: true })
      .gte("created_at", oneHourAgo);

    // --- 2. Calls made (distinct call_id from webhook logs) ---
    const { data: callRows } = await supabase
      .from("ringcx_webhook_logs")
      .select("call_id")
      .gte("created_at", oneHourAgo);

    const uniqueCallIds = new Set((callRows || []).map((r: { call_id: string }) => r.call_id));
    const callsMade = uniqueCallIds.size;

    // --- 3. HubSpot call events (webhooks that created HS calls) ---
    const { count: hubspotCalls } = await supabase
      .from("ringcx_webhook_logs")
      .select("*", { count: "exact", head: true })
      .gte("created_at", oneHourAgo)
      .not("hubspot_call_id", "is", null);

    // Also count form-submission-originated HS calls
    const { count: formHubspotCalls } = await supabase
      .from("hubspot_form_submissions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", oneHourAgo)
      .not("hubspot_call_id", "is", null);

    const totalHubspotEvents = (hubspotCalls || 0) + (formHubspotCalls || 0);

    // --- 4. Recordings archived (backed up to Google Drive) ---
    const { count: recordingsArchived } = await supabase
      .from("call_recordings")
      .select("*", { count: "exact", head: true })
      .eq("backup_status", "uploaded")
      .gte("backed_up_at", oneHourAgo);

    // --- 5. Average lead-to-call time ---
    // Join lead_loads with ringcx_webhook_logs on contact_id, find first call per contact
    const { data: leadLoadRows } = await supabase
      .from("lead_loads")
      .select("contact_id, created_at")
      .gte("created_at", oneHourAgo);

    let avgLeadToCallMinutes: number | null = null;
    if (leadLoadRows && leadLoadRows.length > 0) {
      const contactIds = [...new Set(leadLoadRows.map((r: { contact_id: string }) => r.contact_id))];

      // Get first call per contact from webhook logs
      const { data: callLogs } = await supabase
        .from("ringcx_webhook_logs")
        .select("contact_id, created_at")
        .in("contact_id", contactIds)
        .gte("created_at", oneHourAgo)
        .order("created_at", { ascending: true });

      if (callLogs && callLogs.length > 0) {
        // Build map of first call time per contact
        const firstCallMap = new Map<string, string>();
        for (const row of callLogs) {
          if (!firstCallMap.has(row.contact_id)) {
            firstCallMap.set(row.contact_id, row.created_at);
          }
        }

        // Calculate deltas
        const deltas: number[] = [];
        for (const lead of leadLoadRows) {
          const firstCall = firstCallMap.get(lead.contact_id);
          if (firstCall) {
            const deltaMs = new Date(firstCall).getTime() - new Date(lead.created_at).getTime();
            if (deltaMs >= 0) {
              deltas.push(deltaMs);
            }
          }
        }

        if (deltas.length > 0) {
          const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          avgLeadToCallMinutes = Math.round(avgMs / 60000 * 10) / 10; // 1 decimal
        }
      }
    }

    // --- 6. Errors needing attention ---
    const { data: errors } = await supabase
      .from("error_log")
      .select("source, error_message, error_details, created_at")
      .gte("created_at", oneHourAgo)
      .order("created_at", { ascending: false });

    const errorCount = errors?.length || 0;

    // Group errors by source + message pattern
    const errorGroups = new Map<string, { count: number; source: string; message: string; contactIds: string[] }>();
    for (const err of errors || []) {
      // Normalize message for grouping (strip contact-specific IDs)
      const key = `${err.source}::${err.error_message?.replace(/Contact \d+/g, "Contact X").replace(/\d{5,}/g, "ID")}`;
      const group = errorGroups.get(key) || { count: 0, source: err.source, message: err.error_message, contactIds: [] };
      group.count++;
      const cid = err.error_details?.contactId;
      if (cid && !group.contactIds.includes(cid)) {
        group.contactIds.push(cid);
      }
      errorGroups.set(key, group);
    }

    // --- Build email body ---
    const avgDisplay = avgLeadToCallMinutes !== null ? `${avgLeadToCallMinutes} min` : "N/A (no matched calls)";
    const errEmoji = errorCount > 0 ? "🚨" : "✅";

    // Same line-by-line format for both HTML and plain text
    const line = (emoji: string, text: string) =>
      `<p style="font-family: sans-serif; font-size: 15px; margin: 6px 0;">${emoji} ${text}</p>`;

    let errorDetailsHtml = "";
    if (errorGroups.size > 0) {
      const rows = [...errorGroups.values()]
        .sort((a, b) => b.count - a.count)
        .map((g) => {
          const contacts = g.contactIds.length > 0
            ? g.contactIds.slice(0, 5).join(", ") + (g.contactIds.length > 5 ? ` +${g.contactIds.length - 5} more` : "")
            : "";
          return `<p style="font-family: monospace; font-size: 12px; margin: 4px 0 4px 24px; color: #d32f2f;">[${g.count}x] ${g.source}: ${(g.message || "Unknown").substring(0, 120)}${contacts ? ` — ${contacts}` : ""}</p>`;
        })
        .join("");

      errorDetailsHtml = `
        <hr style="border: none; border-top: 1px solid #eee; margin: 12px 0;">
        <p style="font-family: sans-serif; font-size: 13px; font-weight: bold; color: #d32f2f; margin: 8px 0;">Errors:</p>
        ${rows}`;
    }

    const html = `
      <div style="max-width: 600px;">
        ${line("✅", `Leads Loaded: ${leadsLoaded || 0} (${errEmoji} ${errorCount} errors)`)}
        ${line("✅", `Calls Made: ${callsMade} (${totalHubspotEvents} HubSpot events)`)}
        ${line("✅", `Recordings Archived: ${recordingsArchived || 0}`)}
        ${line("✅", `Avg Lead-to-Call: ${avgDisplay}`)}
        ${errorDetailsHtml}
      </div>`;

    // Build dynamic subject with AWST date/time
    const awst = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const dayName = days[awst.getUTCDay()];
    const monthName = months[awst.getUTCMonth()];
    const dayNum = awst.getUTCDate();
    let hour = awst.getUTCHours();
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;

    const subject = `${errEmoji} RingCX Hourly — ${dayName} ${monthName} ${dayNum}, ${hour}${ampm}`;

    const textLines = [
      `✅ Leads Loaded: ${leadsLoaded || 0} (${errEmoji} ${errorCount} errors)`,
      `✅ Calls Made: ${callsMade} (${totalHubspotEvents} HubSpot events)`,
      `✅ Recordings Archived: ${recordingsArchived || 0}`,
      `✅ Avg Lead-to-Call: ${avgDisplay}`,
    ];

    if (errorGroups.size > 0) {
      textLines.push("", "--- Errors ---");
      for (const g of [...errorGroups.values()].sort((a, b) => b.count - a.count)) {
        textLines.push(`[${g.count}x] ${g.source}: ${g.message?.substring(0, 120)}`);
      }
    }

    // Send email
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: SENDER_EMAIL,
        to: ALERT_EMAIL,
        subject,
        text: textLines.join("\n"),
        html,
      }),
    });

    if (!emailResponse.ok) {
      const errText = await emailResponse.text();
      console.error("Resend email failed:", emailResponse.status, errText);
      return new Response(JSON.stringify({ error: "Email send failed", details: errText }), { status: 500 });
    }

    // Also send to Google Chat if configured
    const webhookUrl = Deno.env.get("GOOGLE_CHAT_WEBHOOK_URL");
    if (webhookUrl) {
      const chatText = textLines.join("\n");
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chatText }),
      }).catch((err) => console.error("GChat send failed:", err));
    }

    console.log(`Hourly report sent: ${leadsLoaded || 0} leads, ${callsMade} calls, ${errorCount} errors`);
    return new Response(JSON.stringify({
      success: true,
      leadsLoaded: leadsLoaded || 0,
      callsMade,
      hubspotEvents: totalHubspotEvents,
      recordingsArchived: recordingsArchived || 0,
      avgLeadToCallMinutes,
      errorCount,
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Hourly report failed:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});
