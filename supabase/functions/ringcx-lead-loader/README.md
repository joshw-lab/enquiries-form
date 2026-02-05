# RingCX Lead Loader Edge Function

This edge function pushes leads from HubSpot to RingCX campaigns using the RingCX Lead Loader API.

## Overview

When a contact is added to a specific HubSpot list, this function:
1. Receives a webhook from HubSpot
2. Fetches the contact's data from HubSpot
3. Reads the `ringcx_campaignid` property from the contact
4. Pushes the lead to the RingCX campaign using the Lead Loader API

## Setup

### 1. HubSpot Contact Property

Ensure the HubSpot contact has a custom property called `ringcx_campaignid` that contains the RingCX campaign ID (e.g., "182").

### 2. Deploy the Edge Function

```bash
supabase functions deploy ringcx-lead-loader
```

### 3. Configure HubSpot Webhook

1. Go to HubSpot Settings → Integrations → Private Apps (or use your app)
2. Navigate to Webhooks
3. Create a new webhook subscription:
   - **Webhook URL**: `https://[your-supabase-project].supabase.co/functions/v1/ringcx-lead-loader`
   - **Trigger**: Contact list membership
   - **List**: Select the list that should trigger lead loading
   - **Event**: When contact is added to list

### 4. Environment Variables

The function requires these environment variables (already configured):
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for database access
- `HUBSPOT_ACCESS_TOKEN` - HubSpot API access token

RingCentral credentials are fetched from the `ringcentral_auth` table.

## API Endpoint

**URL**: `/functions/v1/ringcx-lead-loader`
**Method**: POST
**Content-Type**: application/json

### Request Payload (from HubSpot)

```json
{
  "subscriptionType": "contact.propertyChange",
  "portalId": 12345678,
  "objectId": 123456,
  "propertyName": "hs_list_membership",
  "propertyValue": "list_id",
  "changeSource": "IMPORT",
  "eventId": 987654321,
  "subscriptionId": 12345,
  "attemptNumber": 0
}
```

### Response

**Success (200)**:
```json
{
  "success": true,
  "message": "Lead pushed to RingCX successfully",
  "contactId": "123456",
  "campaignId": "182"
}
```

**Error (400/404/500)**:
```json
{
  "success": false,
  "error": "Error message here"
}
```

## RingCX Lead Loader API

The function calls the RingCX Lead Loader API:

```
POST https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/44510001/campaigns/{campaignId}/leadLoader/direct
```

### Lead Data Sent

```json
{
  "externId": "123456",
  "firstName": "John",
  "lastName": "Doe",
  "address1": "123 Main St",
  "city": "Perth",
  "state": "WA",
  "zip": "6000",
  "email": "john@example.com",
  "phone1": "+61412345678",
  "phone2": "+61498765432"
}
```

## Phone Number Formatting

The function automatically formats phone numbers to E.164 format:
- Australian local: `0412 345 678` → `+61412345678`
- International: `+61 4 1234 5678` → `+61412345678`

## Error Handling

- Errors are logged to the `error_log` table in Supabase
- If the contact doesn't have `ringcx_campaignid`, the function returns a 400 error
- If RingCX API fails, the function returns a 500 error with details

## Testing

### Test with curl

```bash
curl -X POST https://[your-project].supabase.co/functions/v1/ringcx-lead-loader \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your-anon-key]" \
  -d '{
    "objectId": 123456,
    "portalId": 47417644
  }'
```

### Check Logs

```bash
supabase functions logs ringcx-lead-loader
```

## Troubleshooting

### Contact missing ringcx_campaignid
**Error**: "Contact does not have a RingCX Campaign ID"

**Solution**: Add the `ringcx_campaignid` property to the contact in HubSpot.

### RingCentral token expired
**Error**: "Failed to get RingCX access token"

**Solution**: The function automatically refreshes tokens. Check the `ringcentral_auth` table has valid credentials.

### HubSpot contact not found
**Error**: "Failed to fetch contact from HubSpot"

**Solution**: Ensure the `objectId` in the webhook payload is a valid HubSpot contact ID.

## Campaign ID Configuration

Each contact can be assigned to a different campaign by setting their `ringcx_campaignid` property:
- Campaign 182: Set `ringcx_campaignid` = "182"
- Campaign 183: Set `ringcx_campaignid` = "183"
- etc.

The campaign ID determines which RingCX campaign receives the lead.
