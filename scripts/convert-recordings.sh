#!/usr/bin/env bash
# Convert WAV call recordings to MP3 and upload to Supabase Storage.
# Handles two flows:
#   1. GDrive-backed: recordings already on GDrive (backup_status=uploaded, no storage_url)
#   2. Direct RingCX: stalled recordings with ringcx_recording_url (backup_status=awaiting_gdrive)
#
# Runs on the ringcx-sftp-backup GCE VM via cron.
# Dependencies: ffmpeg, jq, curl, rclone (for GDrive upload)
# Env file: /etc/default/recording-converter (SUPABASE_KEY, HUBSPOT_TOKEN)
set -euo pipefail

LOG_FILE="/var/log/recording-converter.log"
LOCK_FILE="/tmp/recording-converter.lock"
BATCH_SIZE="${BATCH_SIZE:-50}"
SUPABASE_URL="https://rzvuzdwhvahwqqhzmuli.supabase.co"
ENV_FILE="/etc/default/recording-converter"
WORK_DIR=""

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

# Create temp working directory (writable by rclone-user for GDrive uploads)
WORK_DIR=$(mktemp -d /tmp/recording-converter-XXXXXX)
chmod 777 "$WORK_DIR"

CONVERTED=0
FAILED=0

# ── Get RingCX session cookies for recording downloads ──
# RingCX recording API requires session cookies (not Bearer tokens).
# We login via RC access token exchange and save cookies to a file.
COOKIE_JAR="${WORK_DIR}/ringcx-cookies.txt"
COOKIE_AGE=0

get_ringcx_session() {
  # Get RC access token from Supabase (refresh if needed)
  local rc_token rc_expiry now_epoch expiry_epoch

  local auth_row
  auth_row=$(curl -s \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    "${SUPABASE_URL}/rest/v1/ringcentral_auth?select=rc_access_token,rc_access_token_expires_at&limit=1" \
    | jq -r '.[0] // empty')

  rc_token=$(echo "$auth_row" | jq -r '.rc_access_token // empty')
  rc_expiry=$(echo "$auth_row" | jq -r '.rc_access_token_expires_at // empty')

  # Check if RC token needs refresh
  if [ -z "$rc_token" ] || [ -z "$rc_expiry" ]; then
    log "No RC token, triggering refresh..."
    curl -s -X POST "${SUPABASE_URL}/functions/v1/ringcentral-token-refresh" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1
    sleep 5
    rc_token=$(curl -s \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      "${SUPABASE_URL}/rest/v1/ringcentral_auth?select=rc_access_token&limit=1" \
      | jq -r '.[0].rc_access_token // empty')
  fi

  if [ -z "$rc_token" ]; then
    log "ERROR: No RC access token available"
    return 1
  fi

  # Login to RingCX via RC token exchange to get session cookies
  local login_code
  login_code=$(curl -s -w "%{http_code}" -o /dev/null \
    -c "$COOKIE_JAR" \
    -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "rcAccessToken=${rc_token}&rcTokenType=Bearer" \
    "https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken")

  if [ "$login_code" != "200" ]; then
    log "ERROR: RingCX session login failed (HTTP $login_code)"
    return 1
  fi

  COOKIE_AGE=0
  log "RingCX session established"
  return 0
}

# ── Check if file is valid audio (not HTML/error page) ──
is_valid_audio() {
  local file="$1"
  local file_type
  file_type=$(file -b "$file" 2>/dev/null || echo "unknown")

  # Valid: RIFF (WAV), data (raw audio), Audio
  if echo "$file_type" | grep -qiE "RIFF|audio|data"; then
    return 0
  fi

  # Invalid: HTML, ASCII text, empty
  if echo "$file_type" | grep -qiE "HTML|text|empty|ASCII"; then
    log "  Invalid file type: $file_type"
    return 1
  fi

  # Unknown — check first bytes for RIFF header
  local magic
  magic=$(xxd -l 4 -p "$file" 2>/dev/null)
  if [ "$magic" = "52494646" ]; then
    return 0  # RIFF header
  fi

  log "  Unknown file type: $file_type (magic: $magic)"
  return 1
}

# ── Convert and upload a single recording ──
# Args: WAV_FILE DB_ID STORAGE_PATH HUBSPOT_CALL
convert_and_upload() {
  local WAV_FILE="$1" DB_ID="$2" STORAGE_PATH="$3" HUBSPOT_CALL="$4"
  local MP3_FILE="${WAV_FILE%.wav}.mp3"
  local PUBLIC_URL="${SUPABASE_URL}/storage/v1/object/public/call-recordings/${STORAGE_PATH}"

  local FILE_SIZE
  FILE_SIZE=$(wc -c < "$WAV_FILE")
  if [ "$FILE_SIZE" -lt 1024 ]; then
    log "  SKIP: File too small (${FILE_SIZE} bytes)"
    # Mark as no_recording since the WAV is empty
    curl -s -o /dev/null -X PATCH \
      -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      -d '{"backup_status": "no_recording"}' \
      "${SUPABASE_URL}/rest/v1/call_recordings?id=eq.${DB_ID}"
    rm -f "$WAV_FILE"
    return 1
  fi

  # Convert WAV to MP3 with ffmpeg (stdin from /dev/null to avoid consuming pipe input)
  if ! ffmpeg -y -nostdin -i "$WAV_FILE" -codec:a libmp3lame -qscale:a 5 "$MP3_FILE" 2>>"$LOG_FILE"; then
    log "  SKIP: ffmpeg conversion failed"
    rm -f "$WAV_FILE" "$MP3_FILE"
    return 1
  fi

  local MP3_SIZE
  MP3_SIZE=$(wc -c < "$MP3_FILE")
  log "  Converted: ${FILE_SIZE} WAV → ${MP3_SIZE} MP3"

  # Upload MP3 to Supabase Storage
  local UP_CODE
  UP_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
    -X POST \
    -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: audio/mpeg" -H "x-upsert: true" \
    --data-binary "@${MP3_FILE}" \
    "${SUPABASE_URL}/storage/v1/object/call-recordings/${STORAGE_PATH}")

  if [ "$UP_CODE" != "200" ]; then
    log "  SKIP: Storage upload failed (HTTP $UP_CODE)"
    rm -f "$WAV_FILE" "$MP3_FILE"
    return 1
  fi

  # Update DB with storage_url + backup_status=uploaded
  curl -s -o /dev/null -X PATCH \
    -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    -d "{\"storage_url\": \"${PUBLIC_URL}\", \"backup_status\": \"uploaded\"}" \
    "${SUPABASE_URL}/rest/v1/call_recordings?id=eq.${DB_ID}"

  # Update HubSpot recording URL
  if [ -n "$HUBSPOT_CALL" ]; then
    local HS_CODE
    HS_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
      -X PATCH \
      -H "Authorization: Bearer ${HUBSPOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"properties\": {\"hs_call_recording_url\": \"${PUBLIC_URL}\"}}" \
      "https://api.hubapi.com/crm/v3/objects/calls/${HUBSPOT_CALL}")
    if [ "$HS_CODE" != "200" ]; then
      log "  WARNING: HubSpot update returned HTTP $HS_CODE"
    fi
  fi

  rm -f "$WAV_FILE" "$MP3_FILE"
  log "  Done: ${PUBLIC_URL}"
  CONVERTED=$((CONVERTED + 1))
  return 0
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 1: Convert GDrive-backed recordings (already on GDrive)
# ═══════════════════════════════════════════════════════════════════
log "=== Phase 1: GDrive-backed recordings ==="
GDRIVE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
  "${SUPABASE_URL}/rest/v1/call_recordings?backup_status=eq.uploaded&storage_url=is.null&gdrive_file_id=not.is.null&gdrive_file_name=not.is.null&order=call_start.desc&limit=${BATCH_SIZE}&select=id,gdrive_file_id,gdrive_file_name,hubspot_call_id")

GDRIVE_CODE=$(echo "$GDRIVE_RESPONSE" | tail -1)
GDRIVE_BODY=$(echo "$GDRIVE_RESPONSE" | sed '$d')

if [ "$GDRIVE_CODE" = "200" ]; then
  GDRIVE_COUNT=$(echo "$GDRIVE_BODY" | jq 'length')
  log "Found $GDRIVE_COUNT GDrive recordings to convert"

  while IFS= read -r rec <&3; do
    DB_ID=$(echo "$rec" | jq -r '.id')
    GDRIVE_ID=$(echo "$rec" | jq -r '.gdrive_file_id')
    GDRIVE_NAME=$(echo "$rec" | jq -r '.gdrive_file_name')
    HUBSPOT_CALL=$(echo "$rec" | jq -r '.hubspot_call_id // empty')
    WAV_FILE="${WORK_DIR}/${GDRIVE_ID}.wav"
    STORAGE_PATH="${GDRIVE_ID}.mp3"

    log "GDrive: ${GDRIVE_NAME}"

    if ! sudo -u rclone-user rclone copyto "gdrive:${GDRIVE_NAME}" "$WAV_FILE" 2>>"$LOG_FILE"; then
      log "  SKIP: rclone download failed"
      rm -f "$WAV_FILE"
      FAILED=$((FAILED + 1))
      continue
    fi

    convert_and_upload "$WAV_FILE" "$DB_ID" "$STORAGE_PATH" "$HUBSPOT_CALL" || FAILED=$((FAILED + 1))
    sleep 1
  done 3< <(echo "$GDRIVE_BODY" | jq -c '.[]')
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 2: Direct RingCX download for stalled recordings
# ═══════════════════════════════════════════════════════════════════
log "=== Phase 2: Direct RingCX download ==="
RINGCX_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
  "${SUPABASE_URL}/rest/v1/call_recordings?backup_status=eq.awaiting_gdrive&ringcx_recording_url=not.is.null&storage_url=is.null&order=call_start.desc&limit=${BATCH_SIZE}&select=id,call_id,ringcx_recording_url,hubspot_call_id,agent_name,disposition")

RINGCX_CODE=$(echo "$RINGCX_RESPONSE" | tail -1)
RINGCX_BODY=$(echo "$RINGCX_RESPONSE" | sed '$d')

if [ "$RINGCX_CODE" != "200" ]; then
  log "ERROR: RingCX query failed (HTTP $RINGCX_CODE)"
else
  RINGCX_COUNT=$(echo "$RINGCX_BODY" | jq 'length')
  log "Found $RINGCX_COUNT stalled recordings to pull from RingCX"

  if [ "$RINGCX_COUNT" -gt 0 ]; then
    if ! get_ringcx_session; then
      log "ERROR: Could not establish RingCX session"
    else
      while IFS= read -r rec <&3; do
        DB_ID=$(echo "$rec" | jq -r '.id')
        CALL_ID=$(echo "$rec" | jq -r '.call_id')
        RECORDING_URL=$(echo "$rec" | jq -r '.ringcx_recording_url')
        HUBSPOT_CALL=$(echo "$rec" | jq -r '.hubspot_call_id // empty')
        AGENT=$(echo "$rec" | jq -r '.agent_name // "unknown"')
        DISPOSITION=$(echo "$rec" | jq -r '.disposition // "unknown"')

        WAV_FILE="${WORK_DIR}/${CALL_ID}.wav"
        STORAGE_PATH="${CALL_ID}.mp3"

        log "RingCX: ${AGENT} - ${DISPOSITION} (${CALL_ID})"

        # Re-establish session every 20 recordings (cookies expire in ~1 hour but be safe)
        COOKIE_AGE=$((COOKIE_AGE + 1))
        if [ "$COOKIE_AGE" -ge 20 ]; then
          log "  Refreshing RingCX session (batch safeguard)..."
          if ! get_ringcx_session; then
            log "ERROR: Session refresh failed mid-batch, stopping"
            break
          fi
        fi

        # Download WAV from RingCX using session cookies
        DL_CODE=$(curl -sL -w "%{http_code}" -o "$WAV_FILE" \
          -b "$COOKIE_JAR" \
          "${RECORDING_URL}")

        if [ "$DL_CODE" != "200" ]; then
          log "  SKIP: RingCX download failed (HTTP $DL_CODE)"
          rm -f "$WAV_FILE"
          FAILED=$((FAILED + 1))
          sleep 1
          continue
        fi

        # Validate the downloaded file is actual audio, not HTML error page
        if ! is_valid_audio "$WAV_FILE"; then
          log "  SKIP: Downloaded file is not audio (likely session expired)"
          rm -f "$WAV_FILE"
          # Re-establish session
          get_ringcx_session || true
          FAILED=$((FAILED + 1))
          sleep 1
          continue
        fi

        # Upload WAV to GDrive for backup
        GDRIVE_FILENAME="${AGENT// /_}_${CALL_ID}_${DISPOSITION// /-}.wav"
        if sudo -u rclone-user rclone copyto "$WAV_FILE" "gdrive:${GDRIVE_FILENAME}" 2>>"$LOG_FILE"; then
          log "  Backed up to GDrive: ${GDRIVE_FILENAME}"
          # Update DB with gdrive info
          curl -s -o /dev/null -X PATCH \
            -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" \
            -H "Content-Type: application/json" -H "Prefer: return=minimal" \
            -d "{\"gdrive_file_name\": \"${GDRIVE_FILENAME}\"}" \
            "${SUPABASE_URL}/rest/v1/call_recordings?id=eq.${DB_ID}"
        else
          log "  WARNING: GDrive backup failed (non-fatal, continuing with conversion)"
        fi

        # Convert and upload to Supabase Storage
        convert_and_upload "$WAV_FILE" "$DB_ID" "$STORAGE_PATH" "$HUBSPOT_CALL" || FAILED=$((FAILED + 1))
        sleep 1
      done 3< <(echo "$RINGCX_BODY" | jq -c '.[]')
    fi
  fi
fi

log "Complete: converted=$CONVERTED failed=$FAILED"
