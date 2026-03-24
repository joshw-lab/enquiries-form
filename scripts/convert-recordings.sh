#!/usr/bin/env bash
# Convert WAV call recordings from Google Drive to MP3 and upload to Supabase Storage.
# Runs on the ringcx-sftp-backup GCE VM via cron.
#
# Dependencies: ffmpeg, jq, gcloud, curl
# Env file: /etc/default/recording-converter (SUPABASE_KEY, HUBSPOT_TOKEN)
set -euo pipefail

LOG_FILE="/var/log/recording-converter.log"
LOCK_FILE="/tmp/recording-converter.lock"
BATCH_SIZE=50
MAX_PARALLEL=5
SUPABASE_URL="https://rzvuzdwhvahwqqhzmuli.supabase.co"
SA_KEY_FILE="/etc/rclone/ringcx-backup-sa-key.json"
ENV_FILE="/etc/default/recording-converter"
WORK_DIR=""
SUCCEEDED=0
FAILED=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cleanup() {
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Prevent concurrent runs
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  log "Another instance is running. Exiting."
  exit 0
fi

# Load secrets
if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: Env file $ENV_FILE not found"
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

if [ -z "${SUPABASE_KEY:-}" ] || [ -z "${HUBSPOT_TOKEN:-}" ]; then
  log "ERROR: SUPABASE_KEY and HUBSPOT_TOKEN must be set in $ENV_FILE"
  exit 1
fi

# Create temp working directory
WORK_DIR=$(mktemp -d /tmp/recording-converter-XXXXXX)

# Get Google access token via service account
log "Authenticating with Google..."
gcloud auth activate-service-account \
  --key-file="$SA_KEY_FILE" \
  --quiet 2>>"$LOG_FILE"
GOOGLE_TOKEN=$(gcloud auth print-access-token)

# Query Supabase for recordings needing conversion
log "Querying for unconverted recordings..."
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  "${SUPABASE_URL}/rest/v1/call_recordings?backup_status=eq.uploaded&storage_url=is.null&gdrive_file_id=not.is.null&order=call_start.desc&limit=${BATCH_SIZE}&select=id,gdrive_file_id,gdrive_file_name,hubspot_call_id")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  log "ERROR: Supabase query failed with HTTP $HTTP_CODE"
  exit 1
fi

COUNT=$(echo "$BODY" | jq 'length')
if [ "$COUNT" = "0" ]; then
  log "No recordings to convert."
  exit 0
fi

log "Found $COUNT recordings to convert (max $MAX_PARALLEL parallel)."

# Process a single recording (called in background for parallelism)
process_recording() {
  local rec="$1"
  local DB_ID GDRIVE_ID GDRIVE_NAME HUBSPOT_CALL
  local WAV_FILE MP3_FILE STORAGE_PATH PUBLIC_URL
  local DL_CODE FILE_SIZE MP3_SIZE UP_CODE DB_CODE HS_CODE

  DB_ID=$(echo "$rec" | jq -r '.id')
  GDRIVE_ID=$(echo "$rec" | jq -r '.gdrive_file_id')
  GDRIVE_NAME=$(echo "$rec" | jq -r '.gdrive_file_name // "unknown"')
  HUBSPOT_CALL=$(echo "$rec" | jq -r '.hubspot_call_id // empty')

  WAV_FILE="${WORK_DIR}/${GDRIVE_ID}.wav"
  MP3_FILE="${WORK_DIR}/${GDRIVE_ID}.mp3"
  STORAGE_PATH="${GDRIVE_ID}.mp3"
  PUBLIC_URL="${SUPABASE_URL}/storage/v1/object/public/call-recordings/${STORAGE_PATH}"

  log "Processing: ${GDRIVE_NAME} (${GDRIVE_ID})"

  # Step 1: Download WAV from Google Drive
  DL_CODE=$(curl -s -w "%{http_code}" -o "$WAV_FILE" \
    -H "Authorization: Bearer ${GOOGLE_TOKEN}" \
    "https://www.googleapis.com/drive/v3/files/${GDRIVE_ID}?alt=media&supportsAllDrives=true")

  if [ "$DL_CODE" != "200" ]; then
    log "  SKIP: Download failed (HTTP $DL_CODE)"
    rm -f "$WAV_FILE"
    return 1
  fi

  FILE_SIZE=$(wc -c < "$WAV_FILE")
  if [ "$FILE_SIZE" -lt 1024 ]; then
    log "  SKIP: Downloaded file too small (${FILE_SIZE} bytes, likely error page)"
    rm -f "$WAV_FILE"
    return 1
  fi

  # Step 2: Convert WAV to MP3 with ffmpeg
  if ! ffmpeg -y -i "$WAV_FILE" -codec:a libmp3lame -qscale:a 5 "$MP3_FILE" 2>>"$LOG_FILE"; then
    log "  SKIP: ffmpeg conversion failed"
    rm -f "$WAV_FILE" "$MP3_FILE"
    return 1
  fi

  MP3_SIZE=$(wc -c < "$MP3_FILE")
  log "  Converted: ${FILE_SIZE} bytes WAV -> ${MP3_SIZE} bytes MP3"

  # Step 3: Upload MP3 to Supabase Storage
  UP_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
    -X POST \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: audio/mpeg" \
    -H "x-upsert: true" \
    --data-binary "@${MP3_FILE}" \
    "${SUPABASE_URL}/storage/v1/object/call-recordings/${STORAGE_PATH}")

  if [ "$UP_CODE" != "200" ]; then
    log "  SKIP: Storage upload failed (HTTP $UP_CODE)"
    rm -f "$WAV_FILE" "$MP3_FILE"
    return 1
  fi

  # Step 4: Update DB with storage_url
  DB_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
    -X PATCH \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "{\"storage_url\": \"${PUBLIC_URL}\"}" \
    "${SUPABASE_URL}/rest/v1/call_recordings?id=eq.${DB_ID}")

  if [ "$DB_CODE" != "204" ]; then
    log "  WARNING: DB update returned HTTP $DB_CODE (expected 204)"
  fi

  # Step 5: Update HubSpot recording URL
  if [ -n "$HUBSPOT_CALL" ]; then
    HS_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
      -X PATCH \
      -H "Authorization: Bearer ${HUBSPOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"properties\": {\"hs_call_recording_url\": \"${PUBLIC_URL}\"}}" \
      "https://api.hubapi.com/crm/v3/objects/calls/${HUBSPOT_CALL}")

    if [ "$HS_CODE" != "200" ]; then
      log "  WARNING: HubSpot update returned HTTP $HS_CODE (non-fatal)"
    fi
  fi

  # Cleanup temp files for this recording
  rm -f "$WAV_FILE" "$MP3_FILE"

  log "  Done: ${PUBLIC_URL}"
  return 0
}

# Process recordings in parallel batches
RUNNING=0
echo "$BODY" | jq -c '.[]' | while IFS= read -r rec; do
  process_recording "$rec" &
  RUNNING=$((RUNNING + 1))

  # Wait if we hit the parallel limit
  if [ "$RUNNING" -ge "$MAX_PARALLEL" ]; then
    wait -n 2>/dev/null || true
    RUNNING=$((RUNNING - 1))
  fi
done

# Wait for remaining background jobs
wait

log "Batch complete: processed up to $COUNT recordings"
