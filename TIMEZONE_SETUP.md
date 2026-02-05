# RingCX Webhook Timezone Configuration

## Overview

The webhook now supports **dynamic timezone detection** based on the HubSpot user's configured timezone. This ensures call timestamps are logged correctly for agents in different timezones (Perth, Sydney, etc.).

## How It Works

1. RingCX sends `agent_extern_id` in the webhook payload
2. Webhook looks up the agent in the `agent_mappings` table
3. Fetches the HubSpot owner's timezone from HubSpot API
4. Converts the call timestamp using the agent's timezone
5. Logs the call with the correct timestamp in HubSpot

## Setup Steps

### Step 1: Get HubSpot Owner IDs

You need to find the HubSpot owner ID for each agent. There are two ways:

#### Method A: From HubSpot URL
1. Go to HubSpot Settings → Users & Teams
2. Click on a user
3. Copy the owner ID from the URL: `https://app.hubspot.com/settings/.../users/{OWNER_ID}/profile`

#### Method B: Using HubSpot API
```bash
# Get all owners
curl -H "Authorization: Bearer YOUR_HUBSPOT_TOKEN" \
  "https://api.hubapi.com/crm/v3/owners"

# Search by email
curl -H "Authorization: Bearer YOUR_HUBSPOT_TOKEN" \
  "https://api.hubapi.com/crm/v3/owners?email=agent@cleanwaterfilters.com.au"
```

### Step 2: Get RingCX Agent External IDs

The `agent_extern_id` is sent by RingCX in the webhook. You can:

1. Check the RingCX webhook configuration for the field name (e.g., `#agent_extern_id#`)
2. Look at existing webhook logs in Supabase:
   ```sql
   SELECT DISTINCT payload->>'agent_extern_id' as agent_extern_id
   FROM ringcx_webhook_logs
   WHERE payload->>'agent_extern_id' IS NOT NULL;
   ```

### Step 3: Add Agent Mappings

Add mappings to the database via Supabase SQL Editor:

```sql
INSERT INTO agent_mappings (agent_extern_id, hubspot_owner_id, agent_name)
VALUES
  ('ringcx-agent-josh', '123456789', 'Josh Williams'),
  ('ringcx-agent-sarah', '987654321', 'Sarah Smith');
```

Or use the Supabase dashboard:
1. Go to Table Editor → agent_mappings
2. Click "Insert" → "Insert row"
3. Fill in the values

### Step 4: Verify HubSpot User Timezone

Make sure each HubSpot user has their timezone set correctly:

1. Go to HubSpot Settings → Users & Teams
2. Click on a user
3. Check the "Time zone" field
4. Update if needed (e.g., "Australia/Perth" or "Australia/Sydney")

### Step 5: Configure RingCX Webhook

Ensure RingCX is sending the `agent_extern_id` field:

```
POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-disposition-webhook

Body:
{
  "agent_extern_id": "#agent_extern_id#",  // ← Must be included
  "extern_id": "#extern_id#",
  "call_id": "#uii#",
  ...
}
```

## Testing

Test the timezone handling with a curl command:

```bash
# Replace with actual values
curl -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-disposition-webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "call_id": "test-'$(date +%s)'",
    "extern_id": "YOUR_HUBSPOT_CONTACT_ID",
    "agent_id": "TEST001",
    "agent_extern_id": "YOUR_AGENT_EXTERN_ID",
    "agent_username": "test@example.com",
    "ani": "0412345678",
    "dnis": "0430363930",
    "call_duration": "120",
    "call_start": "2026-02-05 14:30:00",
    "call_direction": "OUTBOUND",
    "agent_disposition": "booked"
  }'
```

Check the Supabase function logs to see:
```
Mapped agent YOUR_AGENT_EXTERN_ID to HubSpot owner 123456789
Using agent timezone: Australia/Perth
Parsed as Australia/Perth datetime: ...
```

## Fallback Behavior

If no agent mapping is found or timezone cannot be determined:
- **Default timezone**: AWST (Australia/Perth, UTC+8)
- Webhook will still log the call but may show incorrect time for Sydney-based agents

## Troubleshooting

### Issue: Call time still wrong

**Check:**
1. Agent mapping exists: `SELECT * FROM agent_mappings WHERE agent_extern_id = 'YOUR_ID';`
2. HubSpot owner ID is correct
3. HubSpot user timezone is set correctly
4. RingCX is sending `agent_extern_id` in webhook payload

**Check logs:**
```sql
SELECT
  payload->>'agent_extern_id' as agent_extern_id,
  payload->>'call_start' as call_start,
  created_at
FROM ringcx_webhook_logs
ORDER BY created_at DESC
LIMIT 5;
```

### Issue: Agent mapping not found

**Verify:**
- `agent_extern_id` value matches exactly (case-sensitive)
- Mapping was inserted into the database
- Supabase service role has access to the table

### Issue: HubSpot owner ID invalid

**Symptoms:** Error fetching owner info from HubSpot API

**Fix:**
- Verify owner ID is correct
- Check HubSpot token has `crm.objects.owners.read` scope
- Owner must be active in HubSpot

## Example Agent Mappings

```sql
-- Example mappings for different agents
INSERT INTO agent_mappings (agent_extern_id, hubspot_owner_id, agent_name)
VALUES
  -- Perth-based agent (AWST - UTC+8)
  ('josh-williams-123', '101234567', 'Josh Williams'),

  -- Sydney-based agent (AEDT - UTC+11)
  ('sarah-smith-456', '201234567', 'Sarah Smith'),

  -- Brisbane-based agent (AEST - UTC+10)
  ('mike-jones-789', '301234567', 'Mike Jones');
```

## Monitoring

View recent calls and their timezone handling:

```sql
SELECT
  created_at,
  call_id,
  payload->>'agent_extern_id' as agent_extern_id,
  payload->>'call_start' as call_start_received,
  processed_at,
  status
FROM ringcx_webhook_logs
ORDER BY created_at DESC
LIMIT 10;
```

## Notes

- Timezone detection happens **per-call** based on the agent who handled it
- If an agent's HubSpot timezone is updated, it will apply to all future calls automatically
- Past calls are not retroactively updated
- The system supports all IANA timezone formats (e.g., "Australia/Perth", "America/New_York", "Europe/London")
