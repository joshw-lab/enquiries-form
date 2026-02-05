#!/bin/bash
# Test script to send webhook and verify the created engagement in HubSpot

set -e

echo "=== RingCX Webhook Test & Verification ==="
echo ""

# Test parameters
CONTACT_ID="42694751"
TEST_TIME=$(date +"%Y-%m-%d %H:%M:%S")
CALL_ID="test-$(date +%s)"

echo "Test Call Details:"
echo "  Contact ID: $CONTACT_ID"
echo "  Call Time: $TEST_TIME"
echo "  Call ID: $CALL_ID"
echo "  Disposition: busy"
echo ""

# Send webhook
echo "1. Sending webhook to Supabase..."
WEBHOOK_RESPONSE=$(curl -s -X POST https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/ringcx-disposition-webhook \
  -H 'Content-Type: application/json' \
  -d "{
    \"call_id\": \"$CALL_ID\",
    \"extern_id\": \"$CONTACT_ID\",
    \"agent_id\": \"TEST001\",
    \"agent_username\": \"matthew.j@cleanwaterfilters.com.au\",
    \"agent_first_name\": \"Matthew\",
    \"agent_last_name\": \"Johnson\",
    \"ani\": \"370508155\",
    \"dnis\": \"430363930\",
    \"call_duration\": \"120\",
    \"call_start\": \"$TEST_TIME\",
    \"call_direction\": \"OUTBOUND\",
    \"agent_disposition\": \"Busy\",
    \"notes\": \"Test call to verify webhook accuracy\"
  }")

echo "Webhook Response:"
echo "$WEBHOOK_RESPONSE" | jq '.'
echo ""

# Extract HubSpot call ID from response
HUBSPOT_CALL_ID=$(echo "$WEBHOOK_RESPONSE" | jq -r '.callId // empty')

if [ -z "$HUBSPOT_CALL_ID" ]; then
  echo "❌ ERROR: No HubSpot call ID returned. Webhook may have failed."
  exit 1
fi

echo "✓ HubSpot Call ID: $HUBSPOT_CALL_ID"
echo ""

# Wait a moment for HubSpot to process
echo "2. Waiting 2 seconds for HubSpot to process..."
sleep 2
echo ""

# Get HubSpot access token from environment
if [ -z "$HUBSPOT_ACCESS_TOKEN" ]; then
  echo "❌ ERROR: HUBSPOT_ACCESS_TOKEN environment variable not set"
  echo "Please run: export HUBSPOT_ACCESS_TOKEN='your-token-here'"
  exit 1
fi

# Fetch the engagement from HubSpot
echo "3. Fetching engagement from HubSpot API..."
ENGAGEMENT_DATA=$(curl -s -X GET \
  "https://api.hubapi.com/crm/v3/objects/calls/$HUBSPOT_CALL_ID?properties=hs_timestamp,hs_call_title,hs_call_body,hs_call_direction,hs_call_disposition,hs_call_duration,hs_call_from_number,hs_call_to_number,hs_call_status" \
  -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN")

echo "HubSpot Engagement Data:"
echo "$ENGAGEMENT_DATA" | jq '.'
echo ""

# Parse and display key fields
echo "=== VERIFICATION ==="
echo ""

HS_TIMESTAMP=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_timestamp // empty')
HS_TITLE=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_title // empty')
HS_BODY=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_body // empty')
HS_DIRECTION=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_direction // empty')
HS_DISPOSITION=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_disposition // empty')
HS_DURATION=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_duration // empty')
HS_FROM=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_from_number // empty')
HS_TO=$(echo "$ENGAGEMENT_DATA" | jq -r '.properties.hs_call_to_number // empty')

echo "Call Title: $HS_TITLE"
echo "Direction: $HS_DIRECTION"
echo "Disposition UUID: $HS_DISPOSITION"
echo "Duration (ms): $HS_DURATION ($(($HS_DURATION / 1000))s)"
echo "From Number: $HS_FROM"
echo "To Number: $HS_TO"
echo ""

# Convert timestamp to readable date
if [ -n "$HS_TIMESTAMP" ]; then
  TIMESTAMP_SECONDS=$((HS_TIMESTAMP / 1000))
  READABLE_TIME=$(date -r $TIMESTAMP_SECONDS "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null || date -d @$TIMESTAMP_SECONDS "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null || echo "Could not parse")
  echo "Call Time (from HubSpot): $READABLE_TIME"
  echo "Call Time (raw timestamp): $HS_TIMESTAMP"
else
  echo "Call Time: Not found"
fi
echo ""

echo "Call Body:"
echo "$HS_BODY" | sed 's/<br>/\n/g'
echo ""

# Verification checks
echo "=== CHECKS ==="
CHECKS_PASSED=0
CHECKS_TOTAL=0

# Check 1: Direction should be OUTBOUND
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
if [ "$HS_DIRECTION" = "OUTBOUND" ]; then
  echo "✓ Direction is OUTBOUND"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ Direction is $HS_DIRECTION (expected OUTBOUND)"
fi

# Check 2: Disposition should be Busy UUID
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
EXPECTED_UUID="9d9162e7-6cf3-4944-bf63-4dff82258764"
if [ "$HS_DISPOSITION" = "$EXPECTED_UUID" ]; then
  echo "✓ Disposition UUID is correct (Busy)"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ Disposition UUID is $HS_DISPOSITION (expected $EXPECTED_UUID for Busy)"
fi

# Check 3: Duration should be 120000ms (120 seconds = 2 minutes)
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
if [ "$HS_DURATION" = "120000" ]; then
  echo "✓ Duration is correct (120s = 2 minutes)"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ Duration is $HS_DURATION ms (expected 120000ms)"
fi

# Check 4: From number should be +61370508155 (agent)
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
if [ "$HS_FROM" = "+61370508155" ]; then
  echo "✓ From number is correct (agent's number)"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ From number is $HS_FROM (expected +61370508155)"
fi

# Check 5: To number should be +61430363930 (contact)
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
if [ "$HS_TO" = "+61430363930" ]; then
  echo "✓ To number is correct (contact's number)"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ To number is $HS_TO (expected +61430363930)"
fi

# Check 6: Call body should show "from Matthew Johnson to [Contact]"
CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
if echo "$HS_BODY" | grep -q "Matthew Johnson"; then
  echo "✓ Call body contains agent name (Matthew Johnson)"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
else
  echo "❌ Call body does not contain agent name"
fi

echo ""
echo "=== SUMMARY ==="
echo "Checks passed: $CHECKS_PASSED / $CHECKS_TOTAL"

if [ $CHECKS_PASSED -eq $CHECKS_TOTAL ]; then
  echo "✅ All checks passed!"
  exit 0
else
  echo "⚠️  Some checks failed. Review the output above."
  exit 1
fi
