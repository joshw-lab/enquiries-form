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

    // Validate required fields
    // Accept either ringcxLeadId (numeric lead ID) or leadIds array
    const { ringcxLeadId, leadIds, campaignId, accountId: requestAccountId } = requestData;

    // Build lead IDs array
    let leadIdsToDelete: number[] = [];
    if (leadIds && Array.isArray(leadIds)) {
      leadIdsToDelete = leadIds.map((id: string | number) => typeof id === 'string' ? parseInt(id, 10) : id);
    } else if (ringcxLeadId) {
      leadIdsToDelete = [typeof ringcxLeadId === 'string' ? parseInt(ringcxLeadId, 10) : ringcxLeadId];
    }

    if (leadIdsToDelete.length === 0) {
      return jsonResponse({ error: 'ringcxLeadId or leadIds array is required' }, 400);
    }

    if (!campaignId) {
      return jsonResponse({ error: 'campaignId is required' }, 400);
    }

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

    // Build delete URL using RingCX Lead Actions API
    // PUT /api/v1/admin/accounts/{accountId}/campaignLeads/actions?leadAction=DELETE_LEADS
    const deleteUrl = `https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/${accountId}/campaignLeads/actions?leadAction=DELETE_LEADS`;
    console.log(`Removing leads at: ${deleteUrl}`);

    // Build request body per RingCX API spec
    const payload = {
      campaignLeadSearchCriteria: {
        campaignId: typeof campaignId === 'string' ? parseInt(campaignId, 10) : campaignId,
        leadIds: leadIdsToDelete,
      },
    };

    console.log('Delete payload:', JSON.stringify(payload));

    // Call RingCX API to remove leads
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
      console.error('Lead removal failed:', response.status, responseData);
      await notifyGChatError({ source: 'remove-lead', error: `Lead removal failed: ${JSON.stringify(responseData)}`, details: { leadIds: leadIdsToDelete, campaignId } });
      return jsonResponse({ error: `Lead removal failed: ${JSON.stringify(responseData)}` }, response.status);
    }

    console.log('Lead(s) removed successfully');
    return jsonResponse({
      success: true,
      message: 'Lead(s) removed successfully',
      deletedLeadIds: leadIdsToDelete,
      campaignId: campaignId,
      data: responseData,
    });

  } catch (error) {
    console.error('Request error:', error);
    await notifyGChatError({ source: 'remove-lead', error: (error as Error).message || 'Unknown error' });
    return jsonResponse({ error: `Internal error: ${(error as Error).message}` }, 500);
  }
});
