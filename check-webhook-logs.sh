#!/bin/bash
# Script to check RingCX webhook logs and diagnose issues

echo "=== RingCX Webhook Diagnostics ==="
echo ""

# Extract project ref from URL
PROJECT_REF="rzvuzdwhvahwqqhzmuli"

echo "1. Checking if function is deployed..."
echo "---"
supabase functions list --project-ref $PROJECT_REF 2>&1
echo ""

echo "2. Checking function logs (last 20 entries)..."
echo "---"
supabase functions logs ringcx-disposition-webhook --project-ref $PROJECT_REF 2>&1 | head -50
echo ""

echo "3. Checking environment secrets..."
echo "---"
supabase secrets list --project-ref $PROJECT_REF 2>&1
echo ""

echo "=== WEBHOOK ENDPOINT ==="
echo "Your webhook URL should be:"
echo "https://$PROJECT_REF.supabase.co/functions/v1/ringcx-disposition-webhook"
echo ""

echo "=== TEST WEBHOOK ==="
echo "To test manually, run:"
echo "curl -X POST https://$PROJECT_REF.supabase.co/functions/v1/ringcx-disposition-webhook \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{"
echo "    \"call_id\": \"test-$(date +%s)\","
echo "    \"extern_id\": \"YOUR_HUBSPOT_CONTACT_ID\","
echo "    \"agent_id\": \"TEST001\","
echo "    \"agent_username\": \"test@example.com\","
echo "    \"ani\": \"0412345678\","
echo "    \"dnis\": \"1300123456\","
echo "    \"call_duration\": \"300\","
echo "    \"agent_disposition\": \"booked\""
echo "  }'"
echo ""
