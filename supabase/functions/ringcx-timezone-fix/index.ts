import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  RINGCX_ACCOUNT_ID,
  RINGCX_API_BASE,
  getRingCentralAccessToken,
  corsHeaders,
} from "../_shared/ringcx-lead-loader-base.ts";

// ── Campaign → State/Timezone mapping ──
const CAMPAIGN_MAP: Record<number, { state: string; timezone: string; type: string }> = {
  // WA
  222: { state: "WA", timezone: "WA01", type: "New" },
  223: { state: "WA", timezone: "WA01", type: "Old" },
  224: { state: "WA", timezone: "WA01", type: "HitList (New)" },
  225: { state: "WA", timezone: "WA01", type: "HitList (Old)" },
  // QLD
  226: { state: "QLD", timezone: "QLD1", type: "New" },
  227: { state: "QLD", timezone: "QLD1", type: "Old" },
  228: { state: "QLD", timezone: "QLD1", type: "HitList (New)" },
  229: { state: "QLD", timezone: "QLD1", type: "HitList (Old)" },
  // NSW
  230: { state: "NSW", timezone: "NSW1", type: "New" },
  231: { state: "NSW", timezone: "NSW1", type: "Old" },
  232: { state: "NSW", timezone: "NSW1", type: "HitList (New)" },
  233: { state: "NSW", timezone: "NSW1", type: "HitList (Old)" },
  // ACT
  234: { state: "ACT", timezone: "ACT1", type: "New" },
  235: { state: "ACT", timezone: "ACT1", type: "Old" },
  236: { state: "ACT", timezone: "ACT1", type: "HitList (New)" },
  237: { state: "ACT", timezone: "ACT1", type: "HitList (Old)" },
  // VIC
  238: { state: "VIC", timezone: "VIC1", type: "New" },
  239: { state: "VIC", timezone: "VIC1", type: "Old" },
  240: { state: "VIC", timezone: "VIC1", type: "HitList (New)" },
  241: { state: "VIC", timezone: "VIC1", type: "HitList (Old)" },
  // SA
  242: { state: "SA", timezone: "SA01", type: "New" },
  243: { state: "SA", timezone: "SA01", type: "Old" },
  244: { state: "SA", timezone: "SA01", type: "HitList (New)" },
  245: { state: "SA", timezone: "SA01", type: "HitList (Old)" },
};

// ── Types ──

interface CampaignLead {
  leadId: number;
  externId: string;
  leadPhone: string;
  passCount: number;
  leadStatus: string;
  firstName?: string;
  lastName?: string;
  leadTimezone?: string;
}

interface CampaignResult {
  campaignId: number;
  state: string;
  type: string;
  timezone: string;
  rawLeads: number;
  uniqueLeads: number;
  duplicatesFound: number;
  duplicatesDeleted: number;
  uploaded: number;
  errors: string[];
}

// ── Lead extraction & deduplication ──

function extractLead(raw: any): CampaignLead | null {
  const nested = raw.campaignLead ?? {};
  const src = { ...nested, ...raw };

  const externId = String(src.externId ?? "");
  const leadPhone = String(src.leadPhone ?? "");

  if (!externId && !leadPhone) return null;

  return {
    leadId: Number(src.leadId ?? src.id ?? 0),
    externId,
    leadPhone,
    passCount: Number(src.leadPasses ?? src.passCount ?? 0),
    leadStatus: String(src.leadState ?? src.leadStatus ?? "READY"),
    firstName: src.firstName,
    lastName: src.lastName,
    leadTimezone: src.leadTimezone,
  };
}

/**
 * Deduplicate leads by externId — keep the record with the highest passCount.
 * Returns the best lead per externId AND the leadIds of duplicates to delete.
 */
function deduplicateLeads(leads: CampaignLead[]): {
  unique: CampaignLead[];
  duplicateLeadIds: number[];
  duplicates: number;
} {
  // Group all leads by externId (or leadPhone as fallback)
  const groups = new Map<string, CampaignLead[]>();

  for (const lead of leads) {
    const key = lead.externId || lead.leadPhone;
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(lead);
    groups.set(key, group);
  }

  const unique: CampaignLead[] = [];
  const duplicateLeadIds: number[] = [];

  for (const [, group] of groups) {
    // Sort by passCount descending — keep the first (highest passes)
    group.sort((a, b) => b.passCount - a.passCount);
    unique.push(group[0]);

    // All others are duplicates to delete
    for (let i = 1; i < group.length; i++) {
      if (group[i].leadId) {
        duplicateLeadIds.push(group[i].leadId);
      }
    }
  }

  return { unique, duplicateLeadIds, duplicates: duplicateLeadIds.length };
}

// ── API calls ──

async function fetchCampaignLeads(
  campaignId: number,
  token: string,
): Promise<{ leads: CampaignLead[]; totalRaw: number; error?: string }> {
  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
  const allLeads: CampaignLead[] = [];
  let totalRaw = 0;
  let page = 1;

  while (true) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ campaignId, campaignIds: [campaignId], page, maxRows: 1000 }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { leads: [], totalRaw: 0, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();
    const rawLeads = Array.isArray(result) ? result : (result.leads ?? result.data ?? []);
    totalRaw += rawLeads.length;

    for (const raw of rawLeads) {
      const lead = extractLead(raw);
      if (lead) allLeads.push(lead);
    }

    const totalCount = result.totalCount ?? result.total ?? null;
    if (totalCount !== null && totalRaw < totalCount) {
      page++;
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    break;
  }

  return { leads: allLeads, totalRaw };
}

/**
 * Bulk delete duplicate leads using the campaignLeads/actions endpoint.
 * PUT /api/v1/admin/accounts/{accountId}/campaignLeads/actions?leadAction=DELETE_LEADS
 */
async function deleteDuplicateLeads(
  leadIds: number[],
  token: string,
  dryRun: boolean,
): Promise<{ deleted: number; errors: string[] }> {
  if (dryRun || leadIds.length === 0) {
    return { deleted: leadIds.length, errors: [] };
  }

  const BATCH_SIZE = 200;
  let deleted = 0;
  const errors: string[] = [];
  const deleteUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/actions?leadAction=DELETE_LEADS`;

  for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
    const batch = leadIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const res = await fetch(deleteUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          campaignLeadSearchCriteria: { leadIds: batch },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        errors.push(`Delete batch ${batchNum}: HTTP ${res.status}: ${text}`);
        continue;
      }

      deleted += batch.length;
      console.log(`Delete batch ${batchNum}: ${batch.length} leads deleted`);
    } catch (error) {
      errors.push(`Delete batch ${batchNum}: ${error.message}`);
    }

    if (i + BATCH_SIZE < leadIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return { deleted, errors };
}

/**
 * Re-upload a clean set of leads via the lead loader with correct timezone and passCount.
 * Campaign should be empty before calling this (all leads deleted first).
 * Uses timeZoneOption: "EXPLICIT" so each lead's leadTimezone is respected.
 */
async function reloadCleanLeads(
  campaignId: number,
  leads: CampaignLead[],
  timezone: string,
  token: string,
  dryRun: boolean,
): Promise<{ uploaded: number; errors: string[] }> {
  if (dryRun || leads.length === 0) {
    return { uploaded: leads.length, errors: [] };
  }

  const url = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${campaignId}/leadLoader/direct`;
  const BATCH_SIZE = 500;
  let totalUploaded = 0;
  const errors: string[] = [];

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const uploadLeads = batch.map((lead) => {
      const record: Record<string, string | number> = {
        externId: lead.externId,
        leadPhone: lead.leadPhone,
        leadTimezone: timezone,
      };
      if (lead.firstName) record.firstName = lead.firstName;
      if (lead.lastName) record.lastName = lead.lastName;
      if (lead.passCount > 0) {
        record.passCount = lead.passCount;
        record.leadPasses = lead.passCount;
      }
      return record;
    });

    const requestBody = {
      description: `Timezone fix batch ${batchNum} — ${batch.length} leads`,
      listState: "ACTIVE",
      fileType: "COMMA",
      duplicateHandling: "RETAIN_ALL",
      timeZoneOption: "EXPLICIT",
      dialPriority: "NORMAL",
      uploadLeads,
      dncTags: [],
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const text = await res.text();
        errors.push(`Upload batch ${batchNum}: HTTP ${res.status}: ${text}`);
        continue;
      }

      const result = await res.json();
      console.log(`Upload batch ${batchNum}: supplied=${result.leadsSupplied}, accepted=${result.leadsAccepted}, inserted=${result.leadsInserted}`);

      if (result.processingStatus === "GENERAL_FAILURE" || result.leadsSupplied === 0) {
        errors.push(`Upload batch ${batchNum}: ${result.message || "processing failure"}`);
        continue;
      }

      totalUploaded += result.leadsInserted ?? batch.length;
    } catch (error) {
      errors.push(`Upload batch ${batchNum}: ${error.message}`);
    }

    if (i + BATCH_SIZE < leads.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return { uploaded: totalUploaded, errors };
}

// ── Main handler ──

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dryRun") !== "false";
    const filterState = url.searchParams.get("state")?.toUpperCase();
    const filterCampaign = url.searchParams.get("campaignId");
    const offsetParam = Number(url.searchParams.get("offset") || "0");
    const limitParam = Number(url.searchParams.get("limit") || "0");
    // mode: "delete" = only delete dupes, "update" = only upload timezone, "both" = delete then upload, "passtest" = test passCount field
    const mode = (url.searchParams.get("mode") || "both") as "delete" | "update" | "both" | "passtest";

    console.log(`=== RingCX Timezone Fix + Dedup === dryRun=${dryRun}, state=${filterState || "ALL"}, campaign=${filterCampaign || "ALL"}`);

    // Quick test mode: upload a single lead with passCount=99, then read it back
    if (mode === "passtest" && filterCampaign) {
      const cid = Number(filterCampaign);
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { token } = await getRingCentralAccessToken(supabase, false);
      if (!token) return new Response(JSON.stringify({ error: "Auth failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const loaderUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${cid}/leadLoader/direct`;
      const testExternId = "PASSCOUNT_TEST_" + Date.now();

      // Upload with passCount and leadPasses both set to 99
      const uploadRes = await fetch(loaderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          description: "Pass count field test",
          listState: "ACTIVE",
          fileType: "COMMA",
          duplicateHandling: "RETAIN_ALL",
          timeZoneOption: "EXPLICIT",
          dialPriority: "NORMAL",
          uploadLeads: [{ externId: testExternId, leadPhone: "0400000000", leadTimezone: "WA01", passCount: 99, leadPasses: 99 }],
          dncTags: [],
        }),
      });
      const uploadResult = await uploadRes.json();

      // Wait a moment then search for it
      await new Promise((r) => setTimeout(r, 1000));
      const searchUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaignLeads/leadSearch`;
      const searchRes = await fetch(searchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ campaignId: cid, campaignIds: [cid], page: 1, maxRows: 5 }),
      });
      const searchResult = await searchRes.json();
      const leads = Array.isArray(searchResult) ? searchResult : (searchResult.leads ?? searchResult.data ?? []);
      const testLead = leads.find((l: any) => (l.externId || l.campaignLead?.externId) === testExternId);

      // Clean up: delete the test lead
      if (testLead) {
        const leadId = testLead.leadId || testLead.campaignLead?.leadId;
        if (leadId) {
          await deleteDuplicateLeads([Number(leadId)], token, false);
        }
      }

      return new Response(JSON.stringify({
        test: "passCount field acceptance",
        uploadResponse: uploadResult,
        testLeadFound: !!testLead,
        testLeadPassCount: testLead ? (testLead.leadPasses ?? testLead.campaignLead?.leadPasses ?? "not found") : null,
        testLeadRaw: testLead || null,
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Single-lead test: pick one real lead from campaign, delete it, re-upload with tz+passes, verify
    if (mode === "testlead" as string && filterCampaign) {
      const cid = Number(filterCampaign);
      const { timezone } = CAMPAIGN_MAP[cid];
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { token } = await getRingCentralAccessToken(supabase, false);
      if (!token) return new Response(JSON.stringify({ error: "Auth failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      // 1. Fetch leads and pick one with passCount > 0
      const { leads } = await fetchCampaignLeads(cid, token);
      const testLead = leads.find((l) => l.passCount > 0) || leads[0];
      if (!testLead) return new Response(JSON.stringify({ error: "No leads found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const before = { externId: testLead.externId, leadId: testLead.leadId, passCount: testLead.passCount, timezone: testLead.leadTimezone };

      if (dryRun) {
        return new Response(JSON.stringify({ dryRun: true, wouldProcess: before, targetTimezone: timezone }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. Delete this one lead
      await deleteDuplicateLeads([testLead.leadId], token, false);

      // 3. Re-upload with timezone + leadPasses
      const loaderUrl = `${RINGCX_API_BASE}/admin/accounts/${RINGCX_ACCOUNT_ID}/campaigns/${cid}/leadLoader/direct`;
      const uploadRes = await fetch(loaderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          description: `Single lead test: ${testLead.externId}`,
          listState: "ACTIVE", fileType: "COMMA", duplicateHandling: "RETAIN_ALL",
          timeZoneOption: "EXPLICIT", dialPriority: "NORMAL", dncTags: [],
          uploadLeads: [{
            externId: testLead.externId, leadPhone: testLead.leadPhone,
            leadTimezone: timezone, passCount: testLead.passCount, leadPasses: testLead.passCount,
            ...(testLead.firstName ? { firstName: testLead.firstName } : {}),
            ...(testLead.lastName ? { lastName: testLead.lastName } : {}),
          }],
        }),
      });
      const uploadResult = await uploadRes.json();

      // 4. Read it back — show ALL leads with this externId to debug duplicates
      await new Promise((r) => setTimeout(r, 1000));
      const { leads: afterLeads } = await fetchCampaignLeads(cid, token);
      const allMatches = afterLeads
        .filter((l) => l.externId === testLead.externId)
        .map((l) => ({ leadId: l.leadId, passCount: l.passCount, timezone: l.leadTimezone, status: l.leadStatus }));

      const newest = allMatches.reduce((best, l) => (l.leadId > best.leadId ? l : best), allMatches[0]);

      return new Response(JSON.stringify({
        test: "single lead cycle",
        before,
        uploadPayload: { externId: testLead.externId, leadPhone: testLead.leadPhone, leadTimezone: timezone, passCount: testLead.passCount, leadPasses: testLead.passCount },
        uploadResponse: { status: uploadResult.processingResult, inserted: uploadResult.leadsInserted },
        allMatchesForExternId: allMatches,
        newestMatch: newest,
        passCountPreserved: newest ? newest.passCount === testLead.passCount : false,
        timezoneFixed: newest ? newest.timezone === timezone : false,
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Determine campaigns
    let campaignIds = Object.keys(CAMPAIGN_MAP).map(Number);

    if (filterCampaign) {
      const cid = Number(filterCampaign);
      if (!CAMPAIGN_MAP[cid]) {
        return new Response(
          JSON.stringify({ error: `Unknown campaign ID: ${filterCampaign}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      campaignIds = [cid];
    } else if (filterState) {
      campaignIds = campaignIds.filter((id) => CAMPAIGN_MAP[id].state === filterState);
      if (campaignIds.length === 0) {
        return new Response(
          JSON.stringify({ error: `No campaigns for state: ${filterState}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Auth
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { token, error: authErr } = await getRingCentralAccessToken(supabase, false);
    if (!token) {
      return new Response(
        JSON.stringify({ error: `Auth failed: ${authErr}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Process campaigns
    const results: CampaignResult[] = [];

    for (const campaignId of campaignIds) {
      const { state, timezone, type } = CAMPAIGN_MAP[campaignId];
      console.log(`\n--- Campaign ${campaignId} (${state} ${type}) → ${timezone} ---`);

      // 1. Fetch all leads
      const { leads: rawLeads, totalRaw, error: searchErr } = await fetchCampaignLeads(campaignId, token);

      if (searchErr) {
        results.push({ campaignId, state, type, timezone, rawLeads: 0, uniqueLeads: 0, duplicatesFound: 0, duplicatesDeleted: 0, uploaded: 0, errors: [searchErr] });
        continue;
      }

      // 2. Deduplicate — keep highest passCount per externId
      const { unique, duplicateLeadIds, duplicates } = deduplicateLeads(rawLeads);
      console.log(`${rawLeads.length} raw → ${unique.length} unique (${duplicates} duplicates)`);

      let duplicatesDeleted = 0;
      let uploaded = 0;
      const allErrors: string[] = [];

      if (mode === "delete") {
        // Delete only the duplicates (keep unique leads untouched)
        if (duplicateLeadIds.length > 0) {
          let idsToDelete = duplicateLeadIds;
          if (offsetParam > 0 || limitParam > 0) {
            const end = limitParam > 0 ? offsetParam + limitParam : undefined;
            idsToDelete = duplicateLeadIds.slice(offsetParam, end);
          }
          const delResult = await deleteDuplicateLeads(idsToDelete, token, dryRun);
          duplicatesDeleted = delResult.deleted;
          allErrors.push(...delResult.errors);
        }
      } else if (mode === "both") {
        // Nuclear option: delete ALL leads, then re-upload unique set with timezone
        // This guarantees no duplicates since the campaign is empty before upload
        const allLeadIds = rawLeads.map((l) => l.leadId).filter(Boolean);
        console.log(`Deleting ALL ${allLeadIds.length} leads from campaign...`);

        const delResult = await deleteDuplicateLeads(allLeadIds, token, dryRun);
        duplicatesDeleted = delResult.deleted;
        allErrors.push(...delResult.errors);

        // Re-upload unique set with timezone via lead loader
        console.log(`Re-uploading ${unique.length} clean leads with timezone ${timezone}...`);
        const uploadResult = await reloadCleanLeads(campaignId, unique, timezone, token, dryRun);
        uploaded = uploadResult.uploaded;
        allErrors.push(...uploadResult.errors);
      } else if (mode === "update") {
        // Upload only (for campaigns that are already clean)
        const uploadResult = await reloadCleanLeads(campaignId, unique, timezone, token, dryRun);
        uploaded = uploadResult.uploaded;
        allErrors.push(...uploadResult.errors);
      }

      // Include sample leads in dry-run for verification
      const sampleLeads = dryRun
        ? unique.slice(0, 5).map((l) => ({ externId: l.externId, passCount: l.passCount, leadTimezone: l.leadTimezone, leadStatus: l.leadStatus }))
        : undefined;

      results.push({ campaignId, state, type, timezone, rawLeads: rawLeads.length, uniqueLeads: unique.length, duplicatesFound: duplicates, duplicatesDeleted, uploaded, errors: allErrors, ...(sampleLeads ? { sampleLeads } : {}) });

      if (campaignIds.indexOf(campaignId) < campaignIds.length - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Summary
    const summary = {
      dryRun,
      campaignsProcessed: results.length,
      totalRawLeads: results.reduce((s, r) => s + r.rawLeads, 0),
      totalUniqueLeads: results.reduce((s, r) => s + r.uniqueLeads, 0),
      totalDuplicatesFound: results.reduce((s, r) => s + r.duplicatesFound, 0),
      totalDuplicatesDeleted: results.reduce((s, r) => s + r.duplicatesDeleted, 0),
      totalUploaded: results.reduce((s, r) => s + r.uploaded, 0),
      totalErrors: results.reduce((s, r) => s + r.errors.length, 0),
      campaigns: results,
    };

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Unhandled error:", error);
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
