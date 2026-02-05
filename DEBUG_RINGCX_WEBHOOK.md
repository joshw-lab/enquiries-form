# RingCX Webhook Debugging Guide

## Quick Diagnosis Steps

### Step 1: Check Supabase Function Logs
```bash
# View recent function logs
supabase functions logs ringcx-disposition-webhook --project-ref [your-project-ref]
```

Look for:
- ✅ "Received RingCX webhook:" - Webhook is being called
- ❌ No logs at all - RingCX isn't sending webhooks OR wrong URL
- ❌ "extern_id is required" - RingCX not sending contact ID
- ❌ "Contact not found" - Invalid HubSpot contact ID
- ❌ "HubSpot create call failed" - API error with HubSpot

### Step 2: Check Database Logs
Query the `ringcx_webhook_logs` table to see what payloads are being received:

```sql
-- Check recent webhook calls
SELECT
  created_at,
  call_id,
  contact_id,
  status,
  error_message,
  payload->>'agent_disposition' as disposition,
  payload->>'extern_id' as extern_id
FROM ringcx_webhook_logs
ORDER BY created_at DESC
LIMIT 10;
```

If no rows exist:
- RingCX is not sending webhooks to your endpoint
- The webhook URL is incorrect
- The function is not deployed

### Step 3: Verify RingCX Configuration
Check that RingCX webhook is configured with:
- **URL**: `https://[project-id].supabase.co/functions/v1/ringcx-disposition-webhook`
- **Method**: POST
- **Required Fields**:
  - `#extern_id#` - HubSpot contact ID (CRITICAL)
  - `#uii#` - Call ID
  - `#agent_id#` - Agent ID
  - `#agent_username#` - Agent username
  - `#ani#` - Caller phone number
  - `#dnis#` - Dialed number
  - `#agent_disposition#` - Call disposition

### Step 4: Test with Manual Webhook Call
Create a test payload and send it manually:

```bash
curl -X POST https://[project-id].supabase.co/functions/v1/ringcx-disposition-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "call_id": "test-123",
    "extern_id": "123456789",
    "agent_id": "TEST001",
    "agent_username": "test.agent@cleanwaterfilters.com.au",
    "agent_first_name": "Test",
    "agent_last_name": "Agent",
    "ani": "0412345678",
    "dnis": "1300123456",
    "call_duration": "00:05:30",
    "call_start": "2026-02-05 14:30:00",
    "agent_disposition": "booked",
    "notes": "Test call from debugging"
  }'
```

Expected response:
```json
{
  "success": true,
  "message": "Call engagement created successfully"
}
```

### Step 5: Verify HubSpot Token
```bash
# Check if token is set
supabase secrets list --project-ref [your-project-ref]

# Test token validity
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.hubapi.com/crm/v3/objects/contacts/123456789
```

## Common Issues and Solutions

### Issue: No logs in Supabase function logs
**Cause**: RingCX is not calling the webhook OR wrong URL
**Solution**:
1. Verify webhook URL in RingCX admin
2. Check RingCX webhook status/delivery logs
3. Ensure function is deployed: `supabase functions deploy ringcx-disposition-webhook`

### Issue: "extern_id is required" error
**Cause**: RingCX not sending HubSpot contact ID
**Solution**:
1. Check RingCX webhook configuration has `#extern_id#` tag
2. Ensure the tag is mapped to the HubSpot contact ID field
3. Verify contacts in RingCX have the HubSpot ID stored

### Issue: "Contact not found in HubSpot"
**Cause**: Invalid or non-existent HubSpot contact ID
**Solution**:
1. Verify the contact ID exists in HubSpot
2. Check that RingCX has the correct contact ID stored
3. Look at payload in `ringcx_webhook_logs` table to see what ID was sent

### Issue: "HubSpot create call failed"
**Cause**: HubSpot API error (token, permissions, or invalid data)
**Solution**:
1. Check token has correct scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`
2. Verify token is not expired
3. Check error message in logs for specific HubSpot error
4. Verify disposition UUID is correct in code (lines 199-249)

### Issue: Disposition not mapped
**Cause**: RingCX sending disposition not in mapping table
**Solution**: Add new disposition to mapping in `index.ts:199-249`

### Issue: Call created but missing notes/summary
**Cause**: RingCX not sending `notes` or `summary` fields
**Solution**: These are optional - verify RingCX is configured to send them if needed

## Configuration Checklist

- [ ] Supabase function deployed
- [ ] `HUBSPOT_ACCESS_TOKEN` secret set in Supabase
- [ ] RingCX webhook URL correct
- [ ] RingCX sending `extern_id` field with HubSpot contact ID
- [ ] RingCX webhook is active/enabled
- [ ] HubSpot token has correct scopes
- [ ] Test contact exists in HubSpot
- [ ] Database table `ringcx_webhook_logs` exists

## Monitoring Queries

```sql
-- Check webhook success rate (last 24 hours)
SELECT
  status,
  COUNT(*) as count,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM ringcx_webhook_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- Check recent errors
SELECT
  created_at,
  call_id,
  error_message,
  payload
FROM ringcx_webhook_logs
WHERE error_message IS NOT NULL
ORDER BY created_at DESC
LIMIT 5;

-- Check if specific call was logged
SELECT * FROM ringcx_webhook_logs
WHERE call_id = 'YOUR_CALL_ID';
```

## Contact Information
Function location: `supabase/functions/ringcx-disposition-webhook/index.ts`
Database table: `ringcx_webhook_logs`
