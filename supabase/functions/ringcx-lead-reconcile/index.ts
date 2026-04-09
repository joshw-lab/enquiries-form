import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  CAMPAIGN_TIMEZONE,
  getHubSpotContact,
  pushLeadToRingCX,
  createHubSpotNote,
} from "../_shared/ringcx-lead-loader-base.ts";
import { getRingCXToken } from "../_shared/ringcentral-auth.ts";
import { notifyGChatError, notifyGChatSuccess } from "../_shared/gchat-notify.ts";
import { hubspotFetch } from "../_shared/hubspot-rate-limit.ts";

// ── Configuration ──────────────────────────────────────────────────────

// Campaigns with HubSpot list backing — full bidirectional reconcile.
const LIST_CAMPAIGNS: {
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

// HOT campaigns — no HubSpot list, reconciled against routing table.
const HOT_CAMPAIGNS: { state: string; campaignId: number }[] = [
  { state: "ACT", campaignId: 272 },
  { state: "NSW", campaignId: 273 },
  { state: "QLD", campaignId: 274 },
  { state: "SA",  campaignId: 275 },
  { state: "VIC", campaignId: 276 },
  { state: "WA",  campaignId: 277 },
];

// Archive campaign — count only, no reconciliation.
const ARCHIVE_CAMPAIGN = { state: "ALL", campaignId: 289, tier: "ARCHIVED" };

// State → HOT campaign ID mapping (for routing records created by reconcile)
const STATE_TO_HOT: Record<string, string> = {
  ACT: "272", NSW: "273", QLD: "274", SA: "275", VIC: "276", WA: "277",
};

// Combined for backwards compat
const ALL_CAMPAIGNS = LIST_CAMPAIGNS;

const DELETE_BATCH_SIZE = 50;
const LOAD_BATCH_SIZE = 10; // load missing leads in smaller batches (each requires HS API call)

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
    const response = await hubspotFetch(url, {
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

interface CampaignLeads {
  /** Map of externId -> leadId (one per unique contact) */
  unique: Map<string, number>;
  /** Total lead count including duplicates (matches RingCX UI count) */
  totalCount: number;
  /** LeadIds of duplicate entries to delete */
  duplicateLeadIds: number[];
}

/**
 * Fetch all leads from a RingCX campaign via leadSearch.
 * Identifies unique contacts and duplicate entries.
 */
async function fetchRingCXCampaignLeads(
  campaignId: number,
  ringcxToken: string,
): Promise<CampaignLeads> {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ringcxToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      campaignIds: [campaignId],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`RingCX leadSearch ${response.status} for campaign ${campaignId}: ${errText}`);
  }

  const data = await response.json();
  const leadList = Array.isArray(data) ? data : (data.leads || data.data || []);

  const unique = new Map<string, number>();
  const duplicateLeadIds: number[] = [];

  for (const lead of leadList) {
    const externId = String(lead.externId || lead.extern_id || "");
    const leadId = Number(lead.leadId || lead.lead_id || lead.id || 0);
    if (!externId || !leadId) continue;

    if (unique.has(externId)) {
      // Duplicate — mark for deletion
      duplicateLeadIds.push(leadId);
    } else {
      unique.set(externId, leadId);
    }
  }

  return { unique, totalCount: leadList.length, duplicateLeadIds };
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

/**
 * Format a phone number to E.164 for RingCX loading.
 * Returns null if the phone is invalid/empty.
 */
function formatPhoneForRingCX(phone: string): string | null {
  if (!phone || !phone.trim()) return null;

  // Extract embedded AU phone from freetext
  const embeddedMatch = phone.match(/\b(0[2-9]\d{8})\b/);
  if (embeddedMatch) phone = embeddedMatch[1];

  let digits = phone.replace(/[^\d+]/g, "");

  // Strip duplicate + signs (e.g. "+61+61..." → "+6161...")
  if (digits.indexOf("+", 1) > 0) {
    digits = "+" + digits.substring(1).replace(/\+/g, "");
  }

  // Handle various AU formats
  if (digits.startsWith("+610") && digits.length === 13) {
    // Redundant zero after country code: +610402… → +61402…
    digits = "+61" + digits.substring(4);
  } else if (digits.startsWith("+6161") && digits.length === 14) {
    // Doubled country code: +6161412862794 (14 chars after + dedup) → +61412862794
    digits = "+61" + digits.substring(5);
  } else if (digits.startsWith("+61")) {
    // Already E.164
  } else if (digits.startsWith("6161") && digits.length === 13) {
    // Doubled country code without +
    digits = "+61" + digits.substring(4);
  } else if (digits.startsWith("610") && digits.length === 12) {
    // Redundant zero without +: 610402… → +61402…
    digits = "+61" + digits.substring(3);
  } else if (digits.startsWith("61") && digits.length >= 11) {
    digits = "+" + digits;
  } else if (/^\+4\d{8}$/.test(digits)) {
    // AU mobile with stripped leading 0: +437730983 → +61437730983
    digits = "+61" + digits.substring(1);
  } else if (digits.startsWith("0") && digits.length === 10) {
    digits = "+61" + digits.substring(1);
  } else if (digits.length === 9 && !digits.startsWith("0")) {
    digits = "+61" + digits;
  } else if (digits.startsWith("+")) {
    // Other international format — keep as-is
  } else {
    return null;
  }

  // Validate E.164
  if (/^\+\d{7,15}$/.test(digits)) return digits;
  return null;
}

/**
 * Log a sync failure to the sync_failures table for dashboard visibility.
 */
function humanizeFailureForNote(failureType: string, reason: string, campaign: typeof ALL_CAMPAIGNS[0]): string {
  const campaign_label = `${campaign.state} ${campaign.tier}`;
  if (failureType === "invalid_phone") {
    return `[Automated] This contact could not be loaded into the ${campaign_label} dialler campaign because no valid Australian phone number was found on the record. Please review and update the phone number to ensure this lead can be dialled.`;
  }
  if (failureType === "ringcx_push_failed") {
    const phoneMatch = reason.match(/leadPhone="([^"]+)"/);
    const phone = phoneMatch ? phoneMatch[1] : "unknown";
    if (!phone.startsWith("+61")) {
      return `[Automated] This contact could not be loaded into the ${campaign_label} dialler campaign because the phone number (${phone}) is not a valid Australian number. RingCX only accepts AU numbers for dialling. Please update the phone number if an Australian number is available.`;
    }
    return `[Automated] This contact could not be loaded into the ${campaign_label} dialler campaign due to a phone number formatting issue (${phone}). Please review and correct the phone number.`;
  }
  if (failureType === "hubspot_fetch_failed") {
    return `[Automated] This contact could not be loaded into the ${campaign_label} dialler campaign because the contact record could not be retrieved from HubSpot. This may indicate a data issue.`;
  }
  return `[Automated] This contact could not be loaded into the ${campaign_label} dialler campaign. Reason: ${reason}`;
}

async function logSyncFailure(
  supabase: ReturnType<typeof createClient>,
  contactId: string,
  campaign: typeof ALL_CAMPAIGNS[0],
  failureType: string,
  reason: string,
  hubspotToken: string,
) {
  try {
    // Check if we already logged this failure (avoid duplicate notes)
    const { data: existing } = await supabase
      .from("sync_failures")
      .select("contact_id")
      .eq("contact_id", contactId)
      .eq("campaign_id", campaign.campaignId)
      .maybeSingle();

    await supabase.from("sync_failures").upsert({
      contact_id: contactId,
      campaign_id: campaign.campaignId,
      region: campaign.state,
      tier: campaign.tier,
      failure_type: failureType,
      reason,
      updated_at: new Date().toISOString(),
    }, { onConflict: "contact_id,campaign_id" });

    // Write HubSpot note only on first occurrence
    if (!existing) {
      const noteBody = humanizeFailureForNote(failureType, reason, campaign);
      const noteResult = await createHubSpotNote(contactId, noteBody, hubspotToken);
      if (noteResult.success) {
        console.log(`[Reconcile] Wrote HubSpot note for ${contactId} (${failureType})`);
      } else {
        console.warn(`[Reconcile] Failed to write HubSpot note for ${contactId}: ${noteResult.error}`);
      }
    }
  } catch {
    console.warn(`[Reconcile] Could not log sync failure for ${contactId}`);
  }
}

// Campaign ID field mapping for getHubSpotContact
const CAMPAIGN_ID_FIELDS: Record<string, string> = {
  NEW: "n0_new_list_id",
  OLD: "n0_old_list_id",
};

interface CampaignResult {
  state: string;
  tier: string;
  campaignId: number;
  ringcxTotal: number;    // total leads in RingCX (including dupes)
  ringcxUnique: number;   // unique contacts
  hubspotCount: number;
  duplicates: number;
  excess: number;
  excessInSibling: number;
  excessOrphaned: number;
  excessDisposed: number;
  deleted: number;
  missing: number;        // leads in HS but not in RC
  loaded: number;         // missing leads successfully loaded to RC
  loadFailed: number;     // missing leads that failed to load
  errors: number;
}

async function reconcileCampaign(
  campaign: typeof ALL_CAMPAIGNS[0],
  hubspotToken: string,
  supabaseClient: ReturnType<typeof createClient>,
  dryRun: boolean,
  hotExternIds: Set<string>,
): Promise<CampaignResult> {
  console.log(`[Reconcile] Processing ${campaign.state} ${campaign.tier} (campaign ${campaign.campaignId})`);

  // Fetch HubSpot list members sequentially (parallel would burst the rate limiter)
  const listMembers = await fetchHubSpotListMembers(campaign.listId, hubspotToken);
  const siblingMembers = await fetchHubSpotListMembers(campaign.siblingListId, hubspotToken);

  // Fetch RingCX campaign leads (includes duplicate detection)
  const ringcxToken = await getRingCXToken();
  const ringcxData = await fetchRingCXCampaignLeads(campaign.campaignId, ringcxToken);

  console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${ringcxData.totalCount} total (${ringcxData.unique.size} unique, ${ringcxData.duplicateLeadIds.length} dupes), ${listMembers.size} HS`);

  // Fetch contacts with terminal dispositions that have no active routing
  // (i.e. they were disposed but somehow still in RingCX + HubSpot list)
  const ringcxExternIds = [...ringcxData.unique.keys()];
  let disposedContacts = new Set<string>();
  if (ringcxExternIds.length > 0) {
    // Batch query: find contacts that have been terminally disposed
    const { data: disposedRows } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("contact_id")
      .not("removed_at", "is", null)
      .like("removal_reason", "disposition:%")
      .in("contact_id", ringcxExternIds);

    if (disposedRows && disposedRows.length > 0) {
      // Exclude any that have been actively re-ingested (have a newer active record)
      const disposedIds = disposedRows.map((r) => r.contact_id);
      const { data: activeRows } = await supabaseClient
        .from("ringcx_lead_routing")
        .select("contact_id")
        .is("removed_at", null)
        .in("contact_id", disposedIds);

      const activeContactIds = new Set((activeRows || []).map((r) => r.contact_id));
      disposedContacts = new Set(disposedIds.filter((id) => !activeContactIds.has(id)));

      if (disposedContacts.size > 0) {
        console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${disposedContacts.size} disposed contacts still in campaign`);
      }
    }
  }

  // Diff — find excess leads (not in HubSpot list OR terminally disposed)
  const excess: { externId: string; leadId: number; inSibling: boolean; isDisposed: boolean }[] = [];
  for (const [externId, leadId] of ringcxData.unique) {
    const isDisposed = disposedContacts.has(externId);
    if (listMembers.has(externId) && !isDisposed) continue;
    excess.push({ externId, leadId, inSibling: siblingMembers.has(externId), isDisposed });
  }

  const excessInSibling = excess.filter((e) => e.inSibling && !e.isDisposed).length;
  const excessOrphaned = excess.filter((e) => !e.inSibling && !e.isDisposed).length;
  const excessDisposed = excess.filter((e) => e.isDisposed).length;

  // Combine: duplicates + excess leads = all to delete
  const allDeleteIds = [...ringcxData.duplicateLeadIds, ...excess.map((e) => e.leadId)];
  let deleted = 0;
  const errors: string[] = [];

  console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${excess.length} excess + ${ringcxData.duplicateLeadIds.length} dupes = ${allDeleteIds.length} to delete`);

  if (dryRun) {
    console.log(`[Reconcile] DRY RUN — would delete ${allDeleteIds.length} from campaign ${campaign.campaignId}`);
  } else if (allDeleteIds.length > 0) {
    const freshToken = await getRingCXToken();
    for (let i = 0; i < allDeleteIds.length; i += DELETE_BATCH_SIZE) {
      const batch = allDeleteIds.slice(i, i + DELETE_BATCH_SIZE);
      const result = await deleteLeadsFromCampaign(campaign.campaignId, batch, freshToken);
      if (result.success) {
        deleted += batch.length;
      } else {
        errors.push(`Delete batch failed: ${result.error}`);
      }
    }

    // Update routing table for excess leads (not dupes — dupes have same externId)
    const now = new Date().toISOString();
    for (const e of excess) {
      const removalReason = e.isDisposed
        ? "reconcile_disposed_still_active"
        : e.inSibling ? "reconcile_wrong_campaign" : "reconcile_not_in_any_list";

      // For disposed leads, the routing record already has removed_at set —
      // only update if there's an active routing record
      await supabaseClient
        .from("ringcx_lead_routing")
        .update({
          current_tier: "ARCHIVED",
          removed_at: now,
          removal_reason: removalReason,
          updated_at: now,
        })
        .eq("contact_id", e.externId)
        .eq("current_campaign_id", String(campaign.campaignId))
        .is("removed_at", null);

      const eventType = e.isDisposed
        ? "reconcile_archived"
        : e.inSibling ? "reconcile_moved" : "reconcile_archived";

      await supabaseClient.from("lead_routing_events").insert({
        contact_id: e.externId,
        event_type: eventType,
        from_campaign_id: String(campaign.campaignId),
        to_campaign_id: null,
        from_tier: campaign.tier,
        to_tier: "ARCHIVED",
        ringcx_lead_id: String(e.leadId),
        details: {
          source: "reconcile_cron",
          state: campaign.state,
          in_sibling_list: e.inSibling,
          was_disposed: e.isDisposed,
        },
      });
    }
  }

  // ── Load missing leads (HS has, RC doesn't) ────────────────────────
  const missingContactIds: string[] = [];
  for (const memberId of listMembers) {
    if (!ringcxData.unique.has(memberId)) {
      missingContactIds.push(memberId);
    }
  }

  let loaded = 0;
  let loadFailed = 0;

  console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${missingContactIds.length} missing from RingCX`);

  // Filter out contacts that should NOT be loaded into this campaign:
  // 1. Already actively routed to another campaign (prevents duplicates across campaigns)
  // 2. Recently terminally disposed within 30 days (prevents re-loading booked/disposed leads)
  let loadableContactIds = missingContactIds;
  if (missingContactIds.length > 0) {
    const excludeIds = new Set<string>();

    // Guard 0: Skip contacts currently in ANY HOT campaign (RingCX source of truth)
    // This catches leads that have no routing record (legacy loads, race conditions)
    for (const contactId of missingContactIds) {
      if (hotExternIds.has(contactId)) {
        excludeIds.add(contactId);
      }
    }
    if (excludeIds.size > 0) {
      console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${excludeIds.size} missing contacts skipped (found in HOT campaign in RingCX)`);
    }

    // Guard 1: Skip contacts already active in ANY campaign (HOT, NEW, OLD)
    const { data: activeRouting } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("contact_id, current_campaign_id, current_tier")
      .is("removed_at", null)
      .in("contact_id", missingContactIds);

    if (activeRouting && activeRouting.length > 0) {
      for (const r of activeRouting) {
        // Skip if active in a different campaign (e.g., already in HOT, don't also load into NEW)
        if (String(r.current_campaign_id) !== String(campaign.campaignId)) {
          excludeIds.add(r.contact_id);
        }
      }
      if (excludeIds.size > 0) {
        console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${excludeIds.size} missing contacts skipped (active in another campaign)`);
      }
    }

    // Guard 2: Skip contacts with terminal dispositions in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: disposedMissing } = await supabaseClient
      .from("ringcx_lead_routing")
      .select("contact_id")
      .not("removed_at", "is", null)
      .like("removal_reason", "disposition:%")
      .in("contact_id", missingContactIds)
      .gte("removed_at", thirtyDaysAgo);

    if (disposedMissing && disposedMissing.length > 0) {
      const disposedCount = disposedMissing.filter((r: { contact_id: string }) => !excludeIds.has(r.contact_id)).length;
      for (const r of disposedMissing) {
        excludeIds.add(r.contact_id);
      }
      if (disposedCount > 0) {
        console.log(`[Reconcile] ${campaign.state} ${campaign.tier}: ${disposedCount} missing contacts skipped (disposed within 30d)`);
      }
    }

    if (excludeIds.size > 0) {
      loadableContactIds = missingContactIds.filter((id) => !excludeIds.has(id));
    }
  }

  if (loadableContactIds.length > 0 && !dryRun) {
    const campaignIdField = CAMPAIGN_ID_FIELDS[campaign.tier] || "n0_new_list_id";
    let loadToken = await getRingCXToken();

    for (let i = 0; i < loadableContactIds.length; i += LOAD_BATCH_SIZE) {
      const batch = loadableContactIds.slice(i, i + LOAD_BATCH_SIZE);

      for (const contactId of batch) {
        try {
          // Fetch contact details from HubSpot
          const hsResult = await getHubSpotContact(contactId, hubspotToken, campaignIdField);
          if (!hsResult.success || !hsResult.contact) {
            const reason = `HubSpot fetch failed: ${hsResult.error || "unknown"}`;
            console.warn(`[Reconcile] Skip ${contactId}: ${reason}`);
            await logSyncFailure(supabaseClient, contactId, campaign, "hubspot_fetch_failed", reason, hubspotToken);
            loadFailed++;
            continue;
          }

          const props = hsResult.contact.properties || {};
          const phone = props.phone || props.mobilephone || "";
          const formattedPhone = formatPhoneForRingCX(phone);

          if (!formattedPhone) {
            const reason = `No valid phone number (raw: "${phone}")`;
            console.warn(`[Reconcile] Skip ${contactId}: ${reason}`);
            await logSyncFailure(supabaseClient, contactId, campaign, "invalid_phone", reason, hubspotToken);
            loadFailed++;
            continue;
          }

          // Guard 3: Skip contacts with lead_date < 72h — they belong in HOT, not NEW
          // Also skip contacts with NO lead_date — cannot determine age
          if (campaign.tier === "NEW") {
            const leadDateRaw = props.lead_date || props.createdate;
            if (!leadDateRaw) {
              console.log(`[Reconcile] Skip ${contactId}: no lead_date or createdate — cannot verify 72h threshold`);
              await logSyncFailure(supabaseClient, contactId, campaign, "no_lead_date",
                "No lead_date or createdate — cannot verify 72h threshold for NEW", hubspotToken);
              loadFailed++;
              continue;
            }
            const ageHours = (Date.now() - new Date(leadDateRaw).getTime()) / (1000 * 60 * 60);
            if (ageHours < 72) {
              console.log(`[Reconcile] Skip ${contactId}: lead_date is ${Math.round(ageHours)}h old (< 72h) — should be in HOT campaign, not NEW`);
              continue;
            }
          }

          // Build lead data
          const leadData = {
            externId: contactId,
            firstName: props.firstname || undefined,
            lastName: props.lastname || undefined,
            email: props.email || undefined,
            phone1: formattedPhone,
            phone2: formatPhoneForRingCX(props.mobilephone || "") || undefined,
            address1: props.address || undefined,
            city: props.city || undefined,
            state: props.state || undefined,
            zip: props.zip || undefined,
            numContacted: Number(props.num_contacted_notes) || 0,
          };

          // Push to RingCX
          const pushResult = await pushLeadToRingCX(
            String(campaign.campaignId),
            leadData,
            loadToken,
            "NORMAL",
          );

          if (pushResult.success) {
            loaded++;

            // Create routing record so aging/disposition systems can track this lead
            const now = new Date().toISOString();
            await supabaseClient.from("ringcx_lead_routing").upsert({
              contact_id: contactId,
              current_campaign_id: String(campaign.campaignId),
              current_tier: campaign.tier,
              lead_date: props.lead_date || props.createdate || now,
              ingested_at: now,
              new_campaign_id: campaign.tier === "NEW" ? String(campaign.campaignId) : String(campaign.siblingCampaignId),
              old_campaign_id: campaign.tier === "OLD" ? String(campaign.campaignId) : String(campaign.siblingCampaignId),
              hot_campaign_id: STATE_TO_HOT[campaign.state] || null,
              contact_state: props.state || campaign.state || null,
              contact_phone: formattedPhone || null,
              moved_to_new_at: campaign.tier !== "HOT" ? now : null,
              moved_to_old_at: campaign.tier === "OLD" ? now : null,
              updated_at: now,
            }, { onConflict: "contact_id" }).then(() => {}).catch((e: unknown) =>
              console.warn(`[Reconcile] Failed to upsert routing for ${contactId}:`, e)
            );

            await supabaseClient.from("lead_routing_events").insert({
              contact_id: contactId,
              event_type: "reconcile_loaded",
              from_campaign_id: null,
              to_campaign_id: String(campaign.campaignId),
              from_tier: null,
              to_tier: campaign.tier,
              details: { source: "reconcile", lead_date: props.lead_date || null },
            }).then(() => {}).catch((e: unknown) =>
              console.warn(`[Reconcile] Failed to log routing event for ${contactId}:`, e)
            );
          } else {
            const reason = pushResult.error || "Unknown push error";
            console.warn(`[Reconcile] Failed to load ${contactId}: ${reason}`);
            await logSyncFailure(supabaseClient, contactId, campaign, "ringcx_push_failed", reason, hubspotToken);
            loadFailed++;
          }
        } catch (err) {
          const reason = (err as Error).message || "Unknown error";
          console.error(`[Reconcile] Error loading ${contactId}:`, reason);
          await logSyncFailure(supabaseClient, contactId, campaign, "unknown_error", reason, hubspotToken);
          loadFailed++;
        }
      }

      // Refresh token between batches (5-min expiry)
      if (i + LOAD_BATCH_SIZE < loadableContactIds.length) {
        loadToken = await getRingCXToken();
      }
    }
  } else if (loadableContactIds.length > 0 && dryRun) {
    console.log(`[Reconcile] DRY RUN — would load ${loadableContactIds.length} missing leads into campaign ${campaign.campaignId}`);
  }

  // Write counts to sync_counts table for dashboard consumption
  const postDeleteTotal = ringcxData.totalCount - deleted;
  const postLoadTotal = postDeleteTotal + loaded;
  await supabaseClient
    .from("sync_counts")
    .upsert({
      campaign_id: campaign.campaignId,
      region: campaign.state,
      tier: campaign.tier,
      hubspot_count: listMembers.size,
      ringcx_count: postLoadTotal,
      excess: Math.max(0, excess.length - deleted + ringcxData.duplicateLeadIds.length),
      excess_in_sibling: excessInSibling,
      excess_orphaned: excessOrphaned,
      missing: Math.max(0, missingContactIds.length - loaded),
      load_failed: loadFailed,
      updated_at: new Date().toISOString(),
    }, { onConflict: "campaign_id" });

  return {
    state: campaign.state,
    tier: campaign.tier,
    campaignId: campaign.campaignId,
    ringcxTotal: ringcxData.totalCount,
    ringcxUnique: ringcxData.unique.size,
    hubspotCount: listMembers.size,
    duplicates: ringcxData.duplicateLeadIds.length,
    excess: excess.length,
    excessInSibling,
    excessOrphaned,
    excessDisposed,
    deleted,
    missing: missingContactIds.length,
    loaded,
    loadFailed,
    errors: errors.length,
  };
}

// ── HOT campaign reconciliation ─────────────────────────────────────────
// HOT campaigns have no HubSpot list. Source of truth = ringcx_lead_routing.
// We remove duplicates, disposed leads, and leads with no active routing record.

interface HotCampaignResult {
  state: string;
  tier: "HOT";
  campaignId: number;
  ringcxTotal: number;
  ringcxUnique: number;
  routingCount: number;  // active routing records for this campaign
  duplicates: number;
  disposed: number;
  noRouting: number;
  deleted: number;
  errors: number;
}

async function reconcileHotCampaign(
  campaign: typeof HOT_CAMPAIGNS[0],
  supabaseClient: ReturnType<typeof createClient>,
  dryRun: boolean,
): Promise<HotCampaignResult> {
  console.log(`[Reconcile] Processing HOT ${campaign.state} (campaign ${campaign.campaignId})`);

  const ringcxToken = await getRingCXToken();
  const ringcxData = await fetchRingCXCampaignLeads(campaign.campaignId, ringcxToken);

  // Fetch active routing records for this HOT campaign
  const { data: activeRoutes } = await supabaseClient
    .from("ringcx_lead_routing")
    .select("contact_id")
    .eq("current_campaign_id", String(campaign.campaignId))
    .is("removed_at", null);

  const activeContactIds = new Set((activeRoutes || []).map((r: { contact_id: string }) => r.contact_id));

  console.log(`[Reconcile] HOT ${campaign.state}: ${ringcxData.totalCount} total (${ringcxData.unique.size} unique, ${ringcxData.duplicateLeadIds.length} dupes), ${activeContactIds.size} active routing`);

  // Check each unique RingCX lead against routing table
  const disposedLeadIds: number[] = [];
  const noRoutingLeadIds: number[] = [];
  const skippedNoRouting: string[] = [];

  for (const [externId, leadId] of ringcxData.unique) {
    if (!activeContactIds.has(externId)) {
      // Check if it has a disposed routing record
      const { data: disposedRow } = await supabaseClient
        .from("ringcx_lead_routing")
        .select("contact_id, removal_reason")
        .eq("contact_id", externId)
        .not("removed_at", "is", null)
        .limit(1)
        .maybeSingle();

      if (disposedRow) {
        disposedLeadIds.push(leadId);
      } else {
        // DON'T delete no-routing leads — they may be valid leads whose routing
        // was moved to NEW/OLD by aging but whose RingCX move didn't complete.
        // Previously this deleted them, causing HOT campaigns to empty out.
        skippedNoRouting.push(externId);
        console.warn(`[Reconcile] HOT ${campaign.state}: Lead ${externId} (leadId=${leadId}) has no active routing — SKIPPING deletion`);
      }
    }
  }

  // Delete: duplicates + disposed ONLY (no longer deleting no-routing leads)
  const allDeleteIds = [...ringcxData.duplicateLeadIds, ...disposedLeadIds];
  let deleted = 0;
  let errors = 0;

  console.log(`[Reconcile] HOT ${campaign.state}: ${ringcxData.duplicateLeadIds.length} dupes, ${disposedLeadIds.length} disposed, ${skippedNoRouting.length} no-routing (SKIPPED) = ${allDeleteIds.length} to delete`);

  if (dryRun) {
    console.log(`[Reconcile] DRY RUN — would delete ${allDeleteIds.length} from HOT ${campaign.state}`);
  } else if (allDeleteIds.length > 0) {
    const freshToken = await getRingCXToken();
    for (let i = 0; i < allDeleteIds.length; i += DELETE_BATCH_SIZE) {
      const batch = allDeleteIds.slice(i, i + DELETE_BATCH_SIZE);
      const result = await deleteLeadsFromCampaign(campaign.campaignId, batch, freshToken);
      if (result.success) {
        deleted += batch.length;
      } else {
        console.error(`[Reconcile] HOT ${campaign.state} delete batch failed: ${result.error}`);
        errors++;
      }
    }
  }

  // Write counts (no-routing leads are now preserved, not deleted)
  const postDeleteCount = ringcxData.unique.size - disposedLeadIds.length;
  await supabaseClient
    .from("sync_counts")
    .upsert({
      campaign_id: campaign.campaignId,
      region: campaign.state,
      tier: "HOT",
      hubspot_count: activeContactIds.size,  // routing table = source of truth
      ringcx_count: Math.max(0, ringcxData.totalCount - deleted),
      excess: Math.max(0, (ringcxData.unique.size - deleted) - activeContactIds.size),
      missing: Math.max(0, activeContactIds.size - postDeleteCount),
      updated_at: new Date().toISOString(),
    }, { onConflict: "campaign_id" });

  return {
    state: campaign.state,
    tier: "HOT",
    campaignId: campaign.campaignId,
    ringcxTotal: ringcxData.totalCount,
    ringcxUnique: ringcxData.unique.size,
    routingCount: activeContactIds.size,
    duplicates: ringcxData.duplicateLeadIds.length,
    disposed: disposedLeadIds.length,
    noRouting: skippedNoRouting.length,
    deleted,
    errors,
  };
}

// ── Counts-only mode ────────────────────────────────────────────────────
// Fast refresh: just fetch total counts from both APIs, write to sync_counts.
// No member diffing, no deletions. Completes all campaigns in ~30-40s.

async function fetchHubSpotListSize(listId: string, hubspotToken: string): Promise<number> {
  const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/lists/${listId}`, {
    headers: { Authorization: `Bearer ${hubspotToken}` },
  });
  if (!res.ok) throw new Error(`HubSpot Lists API ${res.status} for list ${listId}`);
  const raw = await res.json();
  const data = raw.list ?? raw;
  return Number(data.size ?? 0);
}

async function fetchRingCXCampaignCount(campaignId: number, ringcxToken: string): Promise<number> {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ringcxToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ campaignIds: [campaignId] }),
  });
  if (!response.ok) throw new Error(`RingCX leadSearch ${response.status} for campaign ${campaignId}`);
  const data = await response.json();
  const leadList = Array.isArray(data) ? data : (data.leads || data.data || []);
  return leadList.length;
}

async function runCountsOnly(
  supabaseClient: ReturnType<typeof createClient>,
  hubspotToken: string,
): Promise<Response> {
  const requestStart = Date.now();
  const ringcxToken = await getRingCXToken();
  const results: { state: string; tier: string; campaignId: number; hubspotCount: number; ringcxCount: number }[] = [];
  const totalCampaigns = LIST_CAMPAIGNS.length + HOT_CAMPAIGNS.length + 1; // +1 for archive

  // 1. LIST campaigns — fetch HS list size + RCX count in parallel per campaign
  for (const campaign of LIST_CAMPAIGNS) {
    try {
      const hsCount = await fetchHubSpotListSize(campaign.listId, hubspotToken);
      const rcxCount = await fetchRingCXCampaignCount(campaign.campaignId, ringcxToken);

      await supabaseClient
        .from("sync_counts")
        .upsert({
          campaign_id: campaign.campaignId,
          region: campaign.state,
          tier: campaign.tier,
          hubspot_count: hsCount,
          ringcx_count: rcxCount,
          updated_at: new Date().toISOString(),
        }, { onConflict: "campaign_id" });

      results.push({
        state: campaign.state,
        tier: campaign.tier,
        campaignId: campaign.campaignId,
        hubspotCount: hsCount,
        ringcxCount: rcxCount,
      });
    } catch (err) {
      console.error(`[CountsOnly] Error on ${campaign.state} ${campaign.tier}:`, (err as Error).message);
    }
  }

  // 2. HOT campaigns — routing table as expected count, RingCX for actual
  for (const campaign of HOT_CAMPAIGNS) {
    try {
      const [routingResult, rcxCount] = await Promise.all([
        supabaseClient
          .from("ringcx_lead_routing")
          .select("contact_id", { count: "exact", head: true })
          .eq("current_campaign_id", String(campaign.campaignId))
          .is("removed_at", null),
        fetchRingCXCampaignCount(campaign.campaignId, ringcxToken),
      ]);

      const routingCount = routingResult.count ?? 0;

      await supabaseClient
        .from("sync_counts")
        .upsert({
          campaign_id: campaign.campaignId,
          region: campaign.state,
          tier: "HOT",
          hubspot_count: routingCount,  // routing table = expected count
          ringcx_count: rcxCount,
          updated_at: new Date().toISOString(),
        }, { onConflict: "campaign_id" });

      results.push({
        state: campaign.state,
        tier: "HOT",
        campaignId: campaign.campaignId,
        hubspotCount: routingCount,
        ringcxCount: rcxCount,
      });
    } catch (err) {
      console.error(`[CountsOnly] Error on HOT ${campaign.state}:`, (err as Error).message);
    }
  }

  // 3. Archive campaign — RingCX count only (no expected count)
  try {
    const rcxCount = await fetchRingCXCampaignCount(ARCHIVE_CAMPAIGN.campaignId, ringcxToken);

    await supabaseClient
      .from("sync_counts")
      .upsert({
        campaign_id: ARCHIVE_CAMPAIGN.campaignId,
        region: ARCHIVE_CAMPAIGN.state,
        tier: ARCHIVE_CAMPAIGN.tier,
        hubspot_count: 0,  // no source list
        ringcx_count: rcxCount,
        updated_at: new Date().toISOString(),
      }, { onConflict: "campaign_id" });

    results.push({
      state: ARCHIVE_CAMPAIGN.state,
      tier: ARCHIVE_CAMPAIGN.tier,
      campaignId: ARCHIVE_CAMPAIGN.campaignId,
      hubspotCount: 0,
      ringcxCount: rcxCount,
    });
  } catch (err) {
    console.error(`[CountsOnly] Error on ARCHIVE:`, (err as Error).message);
  }

  const elapsedSec = ((Date.now() - requestStart) / 1000).toFixed(1);
  console.log(`[CountsOnly] Refreshed ${results.length}/${totalCampaigns} campaigns in ${elapsedSec}s`);

  return jsonResponse({
    success: true,
    mode: "countsOnly",
    campaignsProcessed: results.length,
    campaignsTotal: totalCampaigns,
    elapsedSeconds: Number(elapsedSec),
    results,
  });
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
    let countsOnly = false;

    try {
      const payload = await req.json();
      if (payload.dryRun === false) dryRun = false;
      if (typeof payload.campaignId === "number") forceCampaignId = payload.campaignId;
      if (payload.countsOnly === true) countsOnly = true;
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

    // ── Counts-only fast path ────────────────────────────────────────
    if (countsOnly) {
      return await runCountsOnly(supabaseClient, hubspotToken);
    }

    // ── Full reconcile mode ──────────────────────────────────────────
    // Check if the forced campaign is a HOT campaign
    const forcedHot = forceCampaignId !== null
      ? HOT_CAMPAIGNS.find((c) => c.campaignId === forceCampaignId)
      : null;

    let campaignsToProcess: typeof LIST_CAMPAIGNS = [];
    let hotCampaignsToProcess: typeof HOT_CAMPAIGNS = [];

    if (forceCampaignId !== null) {
      if (forcedHot) {
        hotCampaignsToProcess = [forcedHot];
      } else {
        const found = LIST_CAMPAIGNS.filter((c) => c.campaignId === forceCampaignId);
        if (found.length === 0) return jsonResponse({ error: `Unknown campaignId: ${forceCampaignId}` }, 400);
        campaignsToProcess = found;
      }
    } else {
      campaignsToProcess = LIST_CAMPAIGNS;
      hotCampaignsToProcess = HOT_CAMPAIGNS;
    }

    const totalToProcess = campaignsToProcess.length + hotCampaignsToProcess.length;
    const mode = dryRun ? "DRY RUN" : "LIVE";
    console.log(`[Reconcile] ${mode}: Processing ${totalToProcess} campaigns (${campaignsToProcess.length} list + ${hotCampaignsToProcess.length} hot)`);

    // ── Pre-fetch HOT campaign leads for cross-campaign guard ──────
    // This is the definitive check — RingCX source of truth, not routing table
    const hotExternIds = new Set<string>();
    if (campaignsToProcess.length > 0) {
      const ringcxToken = await getRingCXToken();
      console.log(`[Reconcile] Pre-fetching HOT campaign leads for cross-campaign guard...`);
      for (const hc of HOT_CAMPAIGNS) {
        try {
          const data = await fetchRingCXCampaignLeads(hc.campaignId, ringcxToken);
          for (const externId of data.unique.keys()) hotExternIds.add(externId);
        } catch (err) {
          console.warn(`[Reconcile] Failed to fetch HOT ${hc.state} (${hc.campaignId}):`, (err as Error).message);
        }
      }
      console.log(`[Reconcile] HOT cross-check: ${hotExternIds.size} contacts currently in HOT campaigns`);
    }

    // ── Process each campaign sequentially (with timeout guard) ──────
    const results: CampaignResult[] = [];
    const hotResults: HotCampaignResult[] = [];
    let timedOut = false;
    const TIMEOUT_MS = 110_000;

    // List-backed campaigns first (they take longer)
    for (const campaign of campaignsToProcess) {
      if (Date.now() - requestStart > TIMEOUT_MS) {
        console.warn(`[Reconcile] Timeout approaching after ${results.length + hotResults.length} campaigns, stopping`);
        timedOut = true;
        break;
      }

      try {
        const result = await reconcileCampaign(campaign, hubspotToken, supabaseClient, dryRun, hotExternIds);
        results.push(result);
      } catch (err) {
        const errMsg = (err as Error).message || String(err);
        console.error(`[Reconcile] Error on ${campaign.state} ${campaign.tier}:`, errMsg);
        results.push({
          state: campaign.state,
          tier: campaign.tier,
          campaignId: campaign.campaignId,
          ringcxTotal: 0,
          ringcxUnique: 0,
          hubspotCount: 0,
          duplicates: 0,
          excess: 0,
          excessInSibling: 0,
          excessOrphaned: 0,
          excessDisposed: 0,
          deleted: 0,
          missing: 0,
          loaded: 0,
          loadFailed: 0,
          errors: 1,
          errorMessage: errMsg,
        } as CampaignResult & { errorMessage: string });
      }
    }

    // HOT campaigns (faster — no HubSpot list fetching)
    if (!timedOut) {
      for (const campaign of hotCampaignsToProcess) {
        if (Date.now() - requestStart > TIMEOUT_MS) {
          console.warn(`[Reconcile] Timeout approaching during HOT campaigns, stopping`);
          timedOut = true;
          break;
        }

        try {
          const result = await reconcileHotCampaign(campaign, supabaseClient, dryRun);
          hotResults.push(result);
        } catch (err) {
          console.error(`[Reconcile] Error on HOT ${campaign.state}:`, (err as Error).message);
          hotResults.push({
            state: campaign.state,
            tier: "HOT",
            campaignId: campaign.campaignId,
            ringcxTotal: 0,
            ringcxUnique: 0,
            routingCount: 0,
            duplicates: 0,
            disposed: 0,
            noRouting: 0,
            deleted: 0,
            errors: 1,
          });
        }
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    const totalDeleted = results.reduce((s, r) => s + r.deleted, 0) + hotResults.reduce((s, r) => s + r.deleted, 0);
    const totalExcess = results.reduce((s, r) => s + r.excess, 0);
    const totalLoaded = results.reduce((s, r) => s + r.loaded, 0);
    const totalLoadFailed = results.reduce((s, r) => s + r.loadFailed, 0);
    const totalMissing = results.reduce((s, r) => s + r.missing, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0) + hotResults.reduce((s, r) => s + r.errors, 0);
    const totalHotDisposed = hotResults.reduce((s, r) => s + r.disposed, 0);
    const totalHotNoRouting = hotResults.reduce((s, r) => s + r.noRouting, 0);
    const elapsedSec = ((Date.now() - requestStart) / 1000).toFixed(1);

    const processedCount = results.length + hotResults.length;
    const summaryLines = [
      `Reconcile ${mode}: ${processedCount}/${totalToProcess} campaigns in ${elapsedSec}s${timedOut ? " (TIMED OUT)" : ""}`,
      `List: Excess ${totalExcess} (${totalDeleted} deleted) | Missing ${totalMissing} (${totalLoaded} loaded, ${totalLoadFailed} failed)`,
    ];
    if (hotResults.length > 0) {
      summaryLines.push(`HOT: ${totalHotDisposed} disposed, ${totalHotNoRouting} no-routing removed`);
    }
    if (totalErrors > 0) summaryLines.push(`Errors: ${totalErrors}`);

    for (const r of results) {
      if (r.excess > 0 || r.missing > 0 || r.loadFailed > 0) {
        const parts = [];
        if (r.excess > 0) parts.push(`${r.excess} excess (${r.deleted} deleted)`);
        if (r.missing > 0) parts.push(`${r.missing} missing (${r.loaded} loaded)`);
        if (r.loadFailed > 0) parts.push(`${r.loadFailed} load failures`);
        summaryLines.push(`  ${r.state} ${r.tier}: ${parts.join(", ")}`);
      }
    }
    for (const r of hotResults) {
      if (r.disposed > 0 || r.noRouting > 0 || r.duplicates > 0) {
        const parts = [];
        if (r.disposed > 0) parts.push(`${r.disposed} disposed`);
        if (r.noRouting > 0) parts.push(`${r.noRouting} no-routing`);
        if (r.duplicates > 0) parts.push(`${r.duplicates} dupes`);
        summaryLines.push(`  ${r.state} HOT: ${parts.join(", ")} (${r.deleted} deleted)`);
      }
    }
    const summary = summaryLines.join("\n");

    console.log(`[Reconcile] ${summary}`);

    if (!dryRun && (totalDeleted > 0 || totalLoaded > 0 || totalErrors > 0 || totalLoadFailed > 0)) {
      if (totalErrors > 0 || totalLoadFailed > 0) {
        await notifyGChatError({ source: "ringcx-lead-reconcile", error: summary });
      } else {
        await notifyGChatSuccess(summary);
      }
    }

    return jsonResponse({
      success: true,
      dryRun,
      timedOut,
      campaignsProcessed: processedCount,
      campaignsTotal: totalToProcess,
      totalExcess,
      totalDeleted,
      totalMissing,
      totalLoaded,
      totalLoadFailed,
      totalHotDisposed,
      totalHotNoRouting,
      totalErrors,
      elapsedSeconds: Number(elapsedSec),
      listResults: results,
      hotResults,
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
