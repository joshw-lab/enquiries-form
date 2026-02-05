# RingCX Lead Loader - Multi-Campaign Setup

This project includes 4 separate edge functions for loading leads to RingCX campaigns based on campaign type.

## ✅ Deployed Functions

All functions are now live at:

1. **ringcx-lead-loader-new** (New campaigns)
   - URL: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-new`
   - HubSpot Field: `ringcx_campaignid_new`

2. **ringcx-lead-loader-newhitlist** (NewHitlist campaigns)
   - URL: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-newhitlist`
   - HubSpot Field: `ringcx_campaignid_newhitlist`

3. **ringcx-lead-loader-old** (Old campaigns)
   - URL: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-old`
   - HubSpot Field: `ringcx_campaignid_old`

4. **ringcx-lead-loader-oldhitlist** (OldHitlist campaigns)
   - URL: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-oldhitlist`
   - HubSpot Field: `ringcx_campaignid_oldhitlist`

## 📋 HubSpot Setup

### 1. Ensure Campaign ID Properties Exist

These 4 properties store the state-based campaign IDs:

| Property Name | Label | Type | Description |
|--------------|-------|------|-------------|
| `ringcx_campaignid_new` | RingCX Campaign ID (New) | Single-line text | Campaign ID for New leads |
| `ringcx_campaignid_newhitlist` | RingCX Campaign ID (NewHitlist) | Single-line text | Campaign ID for NewHitlist leads |
| `ringcx_campaignid_old` | RingCX Campaign ID (Old) | Single-line text | Campaign ID for Old leads |
| `ringcx_campaignid_oldhitlist` | RingCX Campaign ID (OldHitlist) | Single-line text | Campaign ID for OldHitlist leads |

### 2. Ensure Trigger Properties Exist

These properties trigger the webhooks when they change:

| Property Name | Label | Triggers Endpoint |
|--------------|-------|-------------------|
| `n0_new_list_id` | New List ID | ringcx-lead-loader-new |
| `new_hitlist_status` | New Hitlist Status | ringcx-lead-loader-newhitlist |
| `n0_old_list_id` | Old List ID | ringcx-lead-loader-old |
| `n0_old_hitlist_id` | Old Hitlist ID | ringcx-lead-loader-oldhitlist |

### 3. Set Campaign IDs by State

For each contact, set the appropriate campaign ID based on their state:

**Example:**
```
Contact in WA (Western Australia):
- ringcx_campaignid_new = "182"
- ringcx_campaignid_newhitlist = "183"
- ringcx_campaignid_old = "184"
- ringcx_campaignid_oldhitlist = "185"

Contact in NSW (New South Wales):
- ringcx_campaignid_new = "192"
- ringcx_campaignid_newhitlist = "193"
- ringcx_campaignid_old = "194"
- ringcx_campaignid_oldhitlist = "195"
```

### 4. Configure Webhooks

Set up webhooks triggered by property changes:

1. Go to **HubSpot → Settings → Integrations → Private Apps**
2. Select your app or create one
3. Navigate to **Webhooks**
4. Create 4 webhooks:

#### Webhook 1: New Leads
- **URL**: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-new`
- **Trigger**: Contact property change
- **Property**: `n0_new_list_id`
- **Event**: When property changes

#### Webhook 2: NewHitlist Leads
- **URL**: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-newhitlist`
- **Trigger**: Contact property change
- **Property**: `new_hitlist_status`
- **Event**: When property changes

#### Webhook 3: Old Leads
- **URL**: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-old`
- **Trigger**: Contact property change
- **Property**: `n0_old_list_id`
- **Event**: When property changes

#### Webhook 4: OldHitlist Leads
- **URL**: `https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-oldhitlist`
- **Trigger**: Contact property change
- **Property**: `n0_old_hitlist_id`
- **Event**: When property changes

## 🔄 How It Works

### Workflow Example (New Campaign)

1. Contact's `n0_new_list_id` property changes in HubSpot (e.g., contact added to a new list)
2. HubSpot webhook fires to: `ringcx-lead-loader-new`
3. Function receives webhook with contact ID
4. Function fetches contact data including `ringcx_campaignid_new` property
5. Function reads the campaign ID (e.g., "182" for WA New)
6. Function pushes lead to RingCX:
   ```
   POST https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/44510001/campaigns/182/leadLoader/direct
   ```
7. Lead appears in RingCX campaign 182

### State-Based Routing

Each state can have different campaign IDs:

```
Western Australia (WA):
├── New: Campaign 182
├── NewHitlist: Campaign 183
├── Old: Campaign 184
└── OldHitlist: Campaign 185

New South Wales (NSW):
├── New: Campaign 192
├── NewHitlist: Campaign 193
├── Old: Campaign 194
└── OldHitlist: Campaign 195

Victoria (VIC):
├── New: Campaign 202
├── NewHitlist: Campaign 203
├── Old: Campaign 204
└── OldHitlist: Campaign 205
```

## 🧪 Testing

### Test Each Function

```bash
# Test New campaign loader
curl -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-new \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your-anon-key]" \
  -d '{"objectId": 123456, "portalId": 47417644}'

# Test NewHitlist campaign loader
curl -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-newhitlist \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your-anon-key]" \
  -d '{"objectId": 123456, "portalId": 47417644}'

# Test Old campaign loader
curl -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-old \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your-anon-key]" \
  -d '{"objectId": 123456, "portalId": 47417644}'

# Test OldHitlist campaign loader
curl -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-lead-loader-oldhitlist \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [your-anon-key]" \
  -d '{"objectId": 123456, "portalId": 47417644}'
```

### Check Logs

```bash
# Check logs for specific campaign type
supabase functions logs ringcx-lead-loader-new
supabase functions logs ringcx-lead-loader-newhitlist
supabase functions logs ringcx-lead-loader-old
supabase functions logs ringcx-lead-loader-oldhitlist
```

## 📊 Monitoring

Each function logs with its campaign type prefix:

```
[New] Received HubSpot list webhook: {...}
[New] Fetching contact 123456 from HubSpot...
[New] Contact has campaign ID: 182
[New] Successfully pushed contact 123456 to RingCX campaign 182
```

This makes it easy to filter logs by campaign type.

## 🛠️ Maintenance

### Update Campaign IDs

To change campaign IDs for a state:
1. Go to HubSpot contact properties
2. Update the relevant `ringcx_campaignid_*` field
3. New leads will use the updated campaign ID

### Add New States

To add campaigns for a new state:
1. Set the 4 campaign ID properties on contacts in that state
2. Contacts will automatically route to the correct campaigns

### Troubleshooting

**Contact not loading to RingCX:**
- Check the contact has the correct `ringcx_campaignid_*` property set
- Verify the campaign ID exists in RingCX
- Check function logs for errors

**Wrong campaign receiving leads:**
- Verify the contact is in the correct HubSpot list
- Check which webhook was triggered
- Confirm the campaign ID property value

## 📁 Architecture

```
supabase/functions/
├── _shared/
│   └── ringcx-lead-loader-base.ts  # Shared utilities
├── ringcx-lead-loader-new/
│   └── index.ts                    # New campaign loader
├── ringcx-lead-loader-newhitlist/
│   └── index.ts                    # NewHitlist campaign loader
├── ringcx-lead-loader-old/
│   └── index.ts                    # Old campaign loader
└── ringcx-lead-loader-oldhitlist/
    └── index.ts                    # OldHitlist campaign loader
```

All functions share the same base logic from `_shared/ringcx-lead-loader-base.ts` but use different campaign ID fields.
