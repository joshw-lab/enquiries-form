import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
} from "../_shared/ringcx-lead-loader-base.ts";
import { getRingCXToken } from "../_shared/ringcentral-auth.ts";
import { notifyGChatError, notifyGChatSuccess } from "../_shared/gchat-notify.ts";

// ── Configuration ──────────────────────────────────────────────────────

// Flat list of all campaigns to reconcile. Cron rotates through one per invocation.
const ALL_CAMPAIGNS: {
  state: string;
  listId: string;
  campaignId: number;
  tier: string;
  siblingListId: string; // the other list for same state (for cross-check)
  siblingCampaignId: number;
}[] = [
  { state: "WA",  listId: "16765", campaignId: 222, tier: "NEW", siblingListId: "16766", siblingCampaignId: 223 },
  { state: "WA",  listId: "16766", campaignId: 223, tier: "OLD", siblingListId: "16765", siblingCampaignId: 222 },
  { state: "NSW", listId: "16767", campaignId: 230, tier: "NEW", siblingListId: "16768", siblingCampaignId: 231 },
  { state: "NSW", listId: "16768", campaignId: 231, tier: "OLD", siblingListId: "16767", siblingCampaignId: 230 },
  { state: "QLD", listId: "16769", campaignId: 226, tier: "NEW", siblingListId: "16770", siblingCampaignId: 227 },
  { state: "QLD", listId: "16770", campaignId: 227, tier: "OLD", siblingListId: "16769", siblingCampaignId: 226 },
  { state: "ACT", listId: "16772", campaignId: 234, tier: "NEW", siblingListId: "16771", siblingCampaignId: 235 },
  { state: "ACT", listId: "16771", campaignId: 235, tier: "OLD", siblingListId: "16772", siblingCampaignId: 234 },
  { state: "VIC", listId: "16775", campaignId: 238, tier: "NEW", siblingListId: "16780", siblingCampaignId: 239 },
  { state: "VIC", listId: "16780", campaignId: 239, tier: "OLD", siblingListId: "16775", siblingCampaignId: 238 },
  { state: "SA",  listId: "16781", campaignId: 242, tier: "NEW", siblingListId: "16782", siblingCampaignId: 243 },
  { state: "SA",  listId: "16782", campaignId: 243, tier: "OLD", siblingListId: "16781", siblingCampaignId: 242 },
];

const DELETE_BATCH_SIZE = 50;

// ── Helpers ─────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/**
 * Fetch all member contact IDs from a HubSpot list using the Lists API v3.
 */
async function fetchHubSpotListMembers(
  listId: string,
  hubspotToken: string,
): Promise<Set<string>> {
  const members = new Set<string>();
  let after: string | null = null;

  do {
    const url = `https://api.hubapi.com/crm/v3/lists/${listId}/memberships${after ? `?after=${after}` : ""}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${hubspotToken}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HubSpot Lists API ${response.status} for list ${listId}: ${errText}`);
    }

    const data = await response.json();
    for (const member of (data.results || [])) {
      members.add(String(member.recordId));
    }

    after = data.paging?.next?.after || null;
  } while (after);

  return members;
}

/**
 * Fetch all lead extern IDs from a RingCX campaign via leadSearch.
 * Returns Map of externId -> ringcxLeadId.
 */
async function fetchRingCXCampaignLeads(
  campaignId: number,
  ringcxToken: string,
): Promise<Map<string, number>> {
  const leads = new Map<string, number>();
  let page = 1;
  const pageSize = 500;

  while (true) {
    const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ringcxToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        campaignIds: [campaignId],
        campaignId: campaignId,
        page,
        maxRows: pageSize,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`RingCX leadSearch ${response.status} for campaign ${campaignId}: ${errText}`);
    }

    const data = await response.json();
    const leadList = Array.isArray(data) ? data : (data.leads || data.data || []);

    for (const lead of leadList) {
      const externId = String(lead.externId || lead.extern_id || "");
      const leadId = lead.leadId || lead.lead_id || lead.id;
      if (externId && leadId) {
        leads.set(externId, Number(leadId));
      }
    }

    // Check if we got a full page (more may exist)
    const totalCount = data.totalCount ?? leadList.length;
    if (page * pageSize >= totalCount || leadList.length < pageSize) break;
    page++;
  }

  return leads;
}

/**
 * Delete leads from a RingCX campaign.
 */
async function deleteLeadsFromCampaign(
  campaignId: number,
  leadIds: number[],
  ringcxToken: string,
): Promise<{ success: boolean; error?: string }> {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=DELETE_LEADS`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ringcxToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      campaignLeadSearchCriteria: {
        campaignId,
        leadIds,
      },
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${responseText}` };
  }

  try {
    const parsed = JSON.parse(responseText);
    if (parsed?.success === false) {
      return { success: false, error: parsed.errorMessage || "RingCX reported failure" };
    }
  } catch {
    // Non-JSON is fine if HTTP was OK
  }

  return { success: true };
}

// ── Per-campaign reconciliation logic ─────────────────────────────────

interface CampaignResult {
  state: string;
  tier: string;
  campaignId: number;
  ringcxCount: number;
  hubspotCount: number;
  excess: number;
  excessInSibling: number;
  excessOrphaned: number;
  deleted: number;
  errors: number;
}

async function reconcileCampaign(
  campaign: typeof ALL_CAMPAIGNS[0],
  hubspotToken: string,
  supabaseClient: ReturnType<typeof createClient>,
  dryRun: boolean,
): Promise<CampaignResult> {
  console.log(`[Reconcile] Processing ${campaign.state} ${campaign.tier} (campaign ${campaign.campaignId})`);

  // Fetch HubSpot list members + sibling list in parallel
  const [listMembers, siblingMembers] = await Promise.all([
    fetchHubSpotListMembers(campaign.listId, hubspotToken),
    fetchHubSpotListMembers(campaign.siblingListId, hubspotToken),
  ]);

  // Fetch RingCX campaign leads
  const ringcxToken = await getRingCXToken();
  const ringcxLeads = await fetchRingCXCampaignLeads(campaign.campaignId, ringcxToken);

  // Diff — find excess leads
  const excess: { externId: string; leadId: number; inSibling: boolean }[] = [];
  for (const [externId, leadId] of ringcxLeads) {
    if (listMembers.has(externId)) continue;
    excess.push({ externId, leadId, inSibling: siblingMembers.has(externId) });
  }

  const excessInSibling = excess.filter((e) => e.inSibling).length;
  const excessOrphaned = excess.filter((e) => !e.inSibling).length;

  console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${ringcxLeads.size} RingCX, ${listMembers.size} HS, ${excess.length} excess (${excessInSibling} sibling, ${excessOrphaned} orphan)`);

  // Delete excess leads
  const allExcessLeadIds = excess.map((e) => e.leadId);
  let deleted = 0;
  const errors: string[] = [];

  if (dryRun) {
    console.log(`[Reconcile] DRY RUN — would delete ${allExcessLeadIds.length} from campaign ${campaign.campaignId}`);
  } else if (allExcessLeadIds.length > 0) {
    const freshToken = await getRingCXToken();
    for (let i = 0; i < allExcessLeadIds.length; i += DELETE_BATCH_SIZE) {
      const batch = allExcessLeadIds.slice(i, i + DELETE_BATCH_SIZE);
      const result = await deleteLeadsFromCampaign(campaign.campaignId, batch, freshToken);
      if (result.success) {
        deleted += batch.length;
      } else {
        errors.push(`Delete batch failed: ${result.error}`);
      }
    }

    // Update routing table: soft-delete matching entries
    const now = new Date().toISOString();
    for (const e of excess) {
      await supabaseClient
        .from("ringcx_lead_routing")
        .update({
          current_tier: "ARCHIVED",
          removed_at: now,
          removal_reason: e.inSibling ? "reconcile_wrong_campaign" : "reconcile_not_in_any_list",
          updated_at: now,
        })
        .eq("contact_id", e.externId)
        .eq("current_campaign_id", String(campaign.campaignId))
        .is("removed_at", null);

      await supabaseClient.from("lead_routing_events").insert({
        contact_id: e.externId,
        event_type: e.inSibling ? "reconcile_moved" : "reconcile_archived",
        from_campaign_id: String(campaign.campaignId),
        to_campaign_id: null,
        from_tier: campaign.tier,
        to_tier: "ARCHIVED",
        ringcx_lead_id: String(e.leadId),
        details: { source: "reconcile_cron", state: campaign.state, in_sibling_list: e.inSibling },
      });
    }
  }

  // Write counts to sync_counts table for dashboard consumption
  await supabaseClient
    .from("sync_counts")
    .upsert({
      campaign_id: campaign.campaignId,
      region: campaign.state,
      tier: campaign.tier,
      hubspot_count: listMembers.size,
      ringcx_count: ringcxLeads.size - deleted, // reflect deletions made this run
      excess: excess.length - deleted,
      excess_in_sibling: excessInSibling,
      excess_orphaned: excessOrphaned,
      updated_at: new Date().toISOString(),
    }, { onConflict: "campaign_id" });

  return {
    state: campaign.state,
    tier: campaign.tier,
    campaignId: campaign.campaignId,
    ringcxCount: ringcxLeads.size,
    hubspotCount: listMembers.size,
    excess: excess.length,
    excessInSibling,
    excessOrphaned,
    deleted,
    errors: errors.length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestStart = Date.now();

  try {
    // Parse payload
    let dryRun = true;
    let forceCampaignId: number | null = null;

    try {
      const payload = await req.json();
      if (payload.dryRun === false) dryRun = false;
      if (typeof payload.campaignId === "number") forceCampaignId = payload.campaignId;
    } catch {
      // No body — defaults (dry run, auto-rotate)
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "",
    );

    const hubspotToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotToken) {
      return jsonResponse({ error: "HUBSPOT_ACCESS_TOKEN not configured" }, 500);
    }

    // ── Determine which campaigns to process ─────────────────────────
    let campaignsToProcess: typeof ALL_CAMPAIGNS;

    if (forceCampaignId !== null) {
      const found = ALL_CAMPAIGNS.filter((c) => c.campaignId === forceCampaignId);
      if (found.length === 0) return jsonResponse({ error: `Unknown campaignId: ${forceCampaignId}` }, 400);
      campaignsToProcess = found;
    } else {
      // Process ALL campaigns — no more rotation
      campaignsToProcess = ALL_CAMPAIGNS;
    }

    const mode = dryRun ? "DRY RUN" : "LIVE";
    console.log(`[Reconcile] ${mode}: Processing ${campaignsToProcess.length} campaigns`);

    // ── Process each campaign sequentially (with timeout guard) ──────
    const results: CampaignResult[] = [];
    let timedOut = false;
    const TIMEOUT_MS = 110_000; // bail at 110s (function hard limit is 120s)

    for (const campaign of campaignsToProcess) {
      if (Date.now() - requestStart > TIMEOUT_MS) {
        console.warn(`[Reconcile] Timeout approaching after ${results.length} campaigns, stopping`);
        timedOut = true;
        break;
      }

      try {
        const result = await reconcileCampaign(campaign, hubspotToken, supabaseClient, dryRun);
        results.push(result);
      } catch (err) {
        console.error(`[Reconcile] Error on ${campaign.state} ${campaign.tier}:`, (err as Error).message);
        results.push({
          state: campaign.state,
          tier: campaign.tier,
          campaignId: campaign.campaignId,
          ringcxCount: 0,
          hubspotCount: 0,
          excess: 0,
          excessInSibling: 0,
          excessOrphaned: 0,
          deleted: 0,
          errors: 1,
        });
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
    const totalExcess = results.reduce((s, r) => s + r.excess, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);
    const elapsedSec = ((Date.now() - requestStart) / 1000).toFixed(1);

    const summary = [
      `Reconcile ${mode}: ${results.length}/${campaignsToProcess.length} campaigns in ${elapsedSec}s${timedOut ? " (TIMED OUT)" : ""}`,
      `Total excess: ${totalExcess} | Deleted: ${totalDeleted} | Errors: ${totalErrors}`,
      ...results.filter((r) => r.excess > 0).map((r) =>
        `  ${r.state} ${r.tier}: ${r.excess} excess (${r.deleted} deleted)`
      ),
    ].join("\n");

    console.log(`[Reconcile] ${summary}`);

    // Notify on action or errors
    if (!dryRun && (totalDeleted > 0 || totalErrors > 0)) {
      if (totalErrors > 0) {
        await notifyGChatError({
          source: "ringcx-lead-reconcile",
          error: summary,
        });
      } else {
        await notifyGChatSuccess(summary);
      }
    }

    return jsonResponse({
      success: true,
      dryRun,
      timedOut,
      campaignsProcessed: results.length,
      campaignsTotal: campaignsToProcess.length,
      totalExcess,
      totalDeleted,
      totalErrors,
      elapsedSeconds: Number(elapsedSec),
      results,
    });
  } catch (error) {
    console.error("[Reconcile] Fatal error:", error);
    await notifyGChatError({
      source: "ringcx-lead-reconcile",
      error: (error as Error).message || "Unknown error",
    });
    return jsonResponse({ error: (error as Error).message || "Unknown error" }, 500);
  }
});
