import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getRingCXToken } from '../_shared/ringcentral-auth.ts';
import { notifyGChatError } from '../_shared/gchat-notify.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Campaign type definitions: maps HubSpot property names to campaign types
const CAMPAIGN_TYPES = [
  { name: 'New',        campaignIdField: 'n0_new_list_id',      leadIdField: 'n0_new_rc_campaign_leadid' },
  { name: 'Old',        campaignIdField: 'n0_old_list_id',      leadIdField: 'old_rc_campaign_leadid' },
  { name: 'NewHitlist', campaignIdField: 'n0_new_hitlist_id',   leadIdField: 'new_hitlist_rc_campaign_leadid' },
  { name: 'OldHitlist', campaignIdField: 'n0_old_hitlist_id',   leadIdField: 'old_hitlist_rc_campaign_leadid' },
];

const HUBSPOT_PROPERTIES = CAMPAIGN_TYPES.flatMap(c => [c.campaignIdField, c.leadIdField]);

async function removeLeadFromCampaign(
  campaignId: number,
  leadIds: number[],
  accountId: string,
  ringcxToken: string,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const deleteUrl = `https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/${accountId}/campaignLeads/actions?leadAction=DELETE_LEADS`;

  const payload = {
    campaignLeadSearchCriteria: {
      campaignId,
      leadIds,
    },
  };

  console.log(`Removing leads from campaign ${campaignId}:`, JSON.stringify(payload));

  const response = await fetch(deleteUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ringcxToken}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = { raw: responseText };
  }

  if (!response.ok) {
    console.error(`Lead removal failed for campaign ${campaignId}:`, response.status, responseData);
    return { success: false, error: `HTTP ${response.status}: ${JSON.stringify(responseData)}`, data: responseData };
  }

  if (responseData?.success === false) {
    const errorMsg = responseData.errorMessage || 'RingCX reported failure';
    console.error(`RingCX operation failed for campaign ${campaignId}:`, errorMsg);
    return { success: false, error: errorMsg, data: responseData };
  }

  return { success: true, data: responseData };
}

async function handleContactIdRemoval(contactId: string, accountId: string, ringcxToken: string) {
  // Fetch contact properties from HubSpot
  const hubspotToken = Deno.env.get('HUBSPOT_ACCESS_TOKEN');
  if (!hubspotToken) {
    return jsonResponse({ error: 'Missing HUBSPOT_ACCESS_TOKEN' }, 500);
  }

  const propsQuery = HUBSPOT_PROPERTIES.join(',');
  const hsUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${propsQuery}`;
  console.log(`Fetching HubSpot contact ${contactId}`);

  const hsResponse = await fetch(hsUrl, {
    headers: {
      'Authorization': `Bearer ${hubspotToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!hsResponse.ok) {
    const hsError = await hsResponse.text();
    console.error('HubSpot fetch failed:', hsResponse.status, hsError);
    return jsonResponse({ error: `HubSpot fetch failed: ${hsResponse.status}` }, 502);
  }

  const hsData = await hsResponse.json();
  const props = hsData.properties || {};

  // Build removal tasks for each campaign type
  const results = [];
  let anyRemoved = false;

  for (const ct of CAMPAIGN_TYPES) {
    const campaignId = props[ct.campaignIdField];
    const leadId = props[ct.leadIdField];

    if (!campaignId || !leadId) {
      const reason = !campaignId && !leadId ? 'no campaignId or leadId'
        : !campaignId ? 'no campaignId'
        : 'no leadId';
      console.log(`[${ct.name}] Skipping: ${reason}`);
      results.push({ campaign: ct.name, campaignId: campaignId || null, leadId: leadId || null, skipped: true, reason });
      continue;
    }

    const numCampaignId = parseInt(campaignId, 10);
    const numLeadId = parseInt(leadId, 10);

    if (isNaN(numCampaignId) || isNaN(numLeadId)) {
      console.log(`[${ct.name}] Skipping: invalid numeric values (campaign=${campaignId}, lead=${leadId})`);
      results.push({ campaign: ct.name, campaignId, leadId, skipped: true, reason: 'invalid numeric values' });
      continue;
    }

    const result = await removeLeadFromCampaign(numCampaignId, [numLeadId], accountId, ringcxToken);

    if (result.success) {
      console.log(`[${ct.name}] Removed lead ${numLeadId} from campaign ${numCampaignId}`);
      results.push({ campaign: ct.name, campaignId: numCampaignId, leadId: numLeadId, removed: true });
      anyRemoved = true;
    } else {
      console.error(`[${ct.name}] Failed:`, result.error);
      results.push({ campaign: ct.name, campaignId: numCampaignId, leadId: numLeadId, removed: false, error: result.error });
      await notifyGChatError({
        source: 'remove-lead',
        error: `Failed to remove lead from ${ct.name} campaign: ${result.error}`,
        details: { contactId, campaignId: numCampaignId, leadId: numLeadId },
      });
    }
  }

  const allSkipped = results.every(r => r.skipped);
  if (allSkipped) {
    console.log(`No campaigns to remove for contact ${contactId}`);
  }

  return jsonResponse({
    success: !allSkipped || anyRemoved,
    contactId,
    message: allSkipped ? 'No campaigns had both campaignId and leadId' : 'Removal complete',
    results,
  });
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    // Parse request body
    const requestData = await req.json();
    const { contactId, ringcxLeadId, leadIds, campaignId, accountId: requestAccountId } = requestData;

    // Get account ID (request overrides env default)
    const accountId = requestAccountId || Deno.env.get('RINGCX_ACCOUNT_ID');
    if (!accountId) {
      return jsonResponse({ error: 'Missing accountId' }, 400);
    }

    // Get RingCX access token
    let ringcxToken: string;
    try {
      ringcxToken = await getRingCXToken();
    } catch (authError) {
      console.error('Token acquisition failed:', authError);
      return jsonResponse({ error: `Authentication failed: ${(authError as Error).message}` }, 401);
    }

    // --- New: contactId-based removal (removes from all campaigns) ---
    if (contactId) {
      return await handleContactIdRemoval(String(contactId), accountId, ringcxToken);
    }

    // --- Legacy: explicit campaignId + leadId(s) ---
    let leadIdsToDelete: number[] = [];
    if (leadIds && Array.isArray(leadIds)) {
      leadIdsToDelete = leadIds.map((id: string | number) => typeof id === 'string' ? parseInt(id, 10) : id);
    } else if (ringcxLeadId) {
      leadIdsToDelete = [typeof ringcxLeadId === 'string' ? parseInt(ringcxLeadId, 10) : ringcxLeadId];
    }

    if (leadIdsToDelete.length === 0) {
      return jsonResponse({ error: 'contactId, ringcxLeadId, or leadIds array is required' }, 400);
    }

    if (!campaignId) {
      return jsonResponse({ error: 'campaignId is required when using ringcxLeadId/leadIds' }, 400);
    }

    const result = await removeLeadFromCampaign(
      typeof campaignId === 'string' ? parseInt(campaignId, 10) : campaignId,
      leadIdsToDelete,
      accountId,
      ringcxToken,
    );

    if (!result.success) {
      await notifyGChatError({
        source: 'remove-lead',
        error: `Lead removal failed: ${result.error}`,
        details: { leadIds: leadIdsToDelete, campaignId },
      });
      return jsonResponse({
        success: false,
        message: result.error,
        leadIds: leadIdsToDelete,
        campaignId,
        data: result.data,
      }, 422);
    }

    console.log('Lead(s) removed successfully');
    return jsonResponse({
      success: true,
      message: 'Lead(s) removed successfully',
      deletedLeadIds: leadIdsToDelete,
      campaignId,
      data: result.data,
    });

  } catch (error) {
    console.error('Request error:', error);
    await notifyGChatError({ source: 'remove-lead', error: (error as Error).message || 'Unknown error' });
    return jsonResponse({ error: `Internal error: ${(error as Error).message}` }, 500);
  }
});
