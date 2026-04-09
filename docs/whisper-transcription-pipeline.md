# Call Recording Transcription Pipeline

## Overview

Transcribe HubSpot call recordings stored in Google Drive using OpenAI Whisper on GCP spot GPU instances, storing results in BigQuery alongside existing call metadata.

## Prerequisites

- HubSpot BigQuery backup running (weekly Saturday 11pm AWST)
- Call recordings in Google Drive with URLs mapped to HubSpot call records via `recording_url` custom property
- GCP project: `ringcx-backup` (or dedicated project for GPU workloads)
- BigQuery dataset: `chf-big-query.hubspot_backup`

## Architecture

```
┌──────────────────────────────────┐
│  BigQuery: hubspot_backup.calls  │
│  (3.89M records, all properties) │
└──────────────┬───────────────────┘
               │ Filter query
               ▼
┌──────────────────────────────────┐
│  Cloud Tasks Queue               │
│  (filtered call IDs + Drive URLs)│
└──────────────┬───────────────────┘
               │ Pull tasks
               ▼
┌──────────────────────────────────┐
│  L4 Spot GPU Fleet               │
│  4× g2-standard-4 instances      │
│  Running whisper-large-v3        │
│  ~50 calls/min per VM            │
│  Auto-restart on preemption      │
└──────────────┬───────────────────┘
               │ Write results
               ▼
┌──────────────────────────────────┐
│  BigQuery: call_transcripts      │
│  Joined to calls table on _hs_id │
└──────────────────────────────────┘
```

## Step 1: Filter Calls in BigQuery

Not all 3.89M calls need transcription. Filter to meaningful conversations:

```sql
CREATE OR REPLACE TABLE hubspot_backup.calls_to_transcribe AS
SELECT
  _hs_id,
  hs_call_duration,
  hs_call_to_number,
  hs_call_from_number,
  hs_call_direction,
  hs_call_status,
  hs_timestamp,
  recording_url  -- custom property with Google Drive link
FROM hubspot_backup.calls
WHERE CAST(hs_call_duration AS INT64) > 60          -- calls longer than 1 minute
  AND hs_call_status = 'COMPLETED'                   -- actually connected
  AND recording_url IS NOT NULL                       -- has a recording
  AND recording_url != ''
-- Add more filters as needed:
--   AND hs_call_direction = 'INBOUND'
--   AND hs_timestamp >= '2024-01-01'
--   AND hubspot_owner_id IN ('12345', '67890')      -- specific reps
```

**Expected reduction**: 3.89M -> ~200k-500k calls (5-15% of total)

## Step 2: GPU Selection

### Recommended: L4 Spot (best price/performance)

| Spec | Value |
|---|---|
| Machine type | `g2-standard-4` (4 vCPU, 16GB RAM, 1x L4 GPU) |
| GPU memory | 24 GB GDDR6 |
| Whisper speed | ~40-60x realtime (large-v3) |
| Spot price | ~$0.40/hr |
| Availability | Good in `australia-southeast1` |

### Alternatives

| GPU | Speed | Spot $/hr | Best for |
|---|---|---|---|
| T4 | 15-20x realtime | $0.35 | Maximum cost savings, no time pressure |
| L4 | 40-60x realtime | $0.40 | Best price/performance (recommended) |
| A100 40GB | 50-80x realtime | $1.10 | Fastest throughput, time-critical |

### Cost Estimates (assuming 4 min avg call, ~25,000 audio hours for 380k calls)

| Fleet Size | Time to Complete | Total Cost |
|---|---|---|
| 1x L4 | ~21 days | ~$200 |
| 4x L4 | ~5 days | ~$200 |
| 8x L4 | ~2.5 days | ~$200 |

Cost stays constant regardless of fleet size (same total GPU-hours).

### Cloud API Comparison (for reference)

| Provider | Rate | Cost for 380k calls |
|---|---|---|
| Deepgram Nova-2 | $0.0043/min | ~$6,500 |
| OpenAI Whisper API | $0.006/min | ~$9,100 |
| Google Speech-to-Text | $0.016/min | ~$24,300 |
| **Local Whisper (L4 spot)** | **~$0.0005/min** | **~$200** |

Local Whisper is **10-50x cheaper** than any cloud API at this scale.

## Step 3: Infrastructure Setup

### 3a. Create GPU VM Template

```bash
gcloud compute instance-templates create whisper-worker-template \
  --project=ringcx-backup \
  --machine-type=g2-standard-4 \
  --region=australia-southeast1 \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --image-family=common-cu123-debian-12 \
  --image-project=deeplearning-platform-release \
  --metadata=startup-script='#!/bin/bash
    # Install dependencies on first boot
    pip install openai-whisper google-cloud-bigquery google-cloud-tasks google-api-python-client
    # Download Whisper model once (cached on disk)
    python3 -c "import whisper; whisper.load_model(\"large-v3\")"
  ' \
  --scopes=cloud-platform \
  --service-account=ringcx-backup-sa@ringcx-backup.iam.gserviceaccount.com
```

### 3b. Create Managed Instance Group

```bash
gcloud compute instance-groups managed create whisper-fleet \
  --project=ringcx-backup \
  --zone=australia-southeast1-b \
  --template=whisper-worker-template \
  --size=4
```

### 3c. Cloud Tasks Queue

```bash
gcloud tasks queues create whisper-transcription \
  --project=ringcx-backup \
  --location=australia-southeast1 \
  --max-dispatches-per-second=100 \
  --max-concurrent-dispatches=50
```

## Step 4: Worker Script

Each GPU VM runs a worker that pulls tasks, transcribes, and writes results:

```python
#!/usr/bin/env python3
"""
whisper-worker.py — Pull call IDs from queue, transcribe, write to BigQuery.
Runs on L4 spot GPU instances. Handles preemption gracefully.
"""

import whisper
import tempfile
import signal
import sys
from google.cloud import bigquery, tasks_v2
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io

# Graceful shutdown on SIGTERM (spot preemption gives 30s warning)
shutdown = False
def handle_sigterm(sig, frame):
    global shutdown
    shutdown = True
    print("SIGTERM received, finishing current file...")
signal.signal(signal.SIGTERM, handle_sigterm)

# Load model once (cached on 100GB SSD)
model = whisper.load_model("large-v3", device="cuda")
bq = bigquery.Client(project="chf-big-query")
drive = build("drive", "v3")

def download_from_drive(file_id, dest_path):
    """Download recording from Google Drive by file ID."""
    request = drive.files().get_media(fileId=file_id)
    with open(dest_path, "wb") as f:
        downloader = MediaIoBaseDownload(f, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()

def transcribe_call(call_id, drive_file_id):
    """Download, transcribe, return result."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=True) as tmp:
        download_from_drive(drive_file_id, tmp.name)
        result = model.transcribe(
            tmp.name,
            language="en",
            task="transcribe",
            verbose=False,
        )
    return {
        "call_id": call_id,
        "transcript": result["text"],
        "language": result.get("language", "en"),
        "segments": [
            {
                "start": s["start"],
                "end": s["end"],
                "text": s["text"],
            }
            for s in result["segments"]
        ],
    }

def write_to_bigquery(results_batch):
    """Batch insert transcription results."""
    rows = [
        {
            "call_id": r["call_id"],
            "transcript_text": r["transcript"],
            "language": r["language"],
            "segments_json": str(r["segments"]),  # JSON string
            "transcribed_at": "AUTO",
        }
        for r in results_batch
    ]
    table = bq.dataset("hubspot_backup").table("call_transcripts")
    errors = bq.insert_rows_json(table, rows)
    if errors:
        print(f"BigQuery insert errors: {errors}")

def main():
    batch = []
    while not shutdown:
        # Pull next call from queue (or BigQuery pending list)
        # ... queue pulling logic here ...

        result = transcribe_call(call_id, drive_file_id)
        batch.append(result)

        # Flush every 50 transcriptions
        if len(batch) >= 50:
            write_to_bigquery(batch)
            batch = []

    # Flush remaining on shutdown
    if batch:
        write_to_bigquery(batch)

if __name__ == "__main__":
    main()
```

## Step 5: BigQuery Transcript Table

```sql
CREATE TABLE IF NOT EXISTS hubspot_backup.call_transcripts (
  call_id STRING NOT NULL,           -- matches calls._hs_id
  transcript_text STRING,            -- full transcript
  language STRING,                   -- detected language
  segments_json STRING,              -- timestamped segments as JSON
  transcribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);
```

### Query: Join Transcripts with Call Metadata

```sql
SELECT
  c._hs_id,
  c.hs_call_to_number,
  c.hs_call_direction,
  c.hs_timestamp,
  c.hubspot_owner_id,
  t.transcript_text,
  t.language
FROM hubspot_backup.calls c
JOIN hubspot_backup.call_transcripts t
  ON c._hs_id = t.call_id
WHERE t.transcript_text LIKE '%water test%'  -- example: search transcripts
ORDER BY c.hs_timestamp DESC
```

## Step 6: Teardown

After all calls are transcribed, destroy the GPU fleet (zero ongoing cost):

```bash
gcloud compute instance-groups managed delete whisper-fleet \
  --project=ringcx-backup \
  --zone=australia-southeast1-b \
  --quiet

gcloud compute instance-templates delete whisper-worker-template \
  --project=ringcx-backup \
  --quiet
```

## Monitoring & Progress

### Track Progress in BigQuery

```sql
-- How many transcribed vs total
SELECT
  (SELECT COUNT(*) FROM hubspot_backup.call_transcripts) AS transcribed,
  (SELECT COUNT(*) FROM hubspot_backup.calls_to_transcribe) AS total,
  ROUND(
    (SELECT COUNT(*) FROM hubspot_backup.call_transcripts) * 100.0 /
    (SELECT COUNT(*) FROM hubspot_backup.calls_to_transcribe), 1
  ) AS percent_complete
```

### Spot Preemption Handling

- Each VM handles SIGTERM (30-second warning before preemption)
- Current call finishes processing before shutdown
- Queue-based architecture means another VM picks up where it left off
- Managed Instance Group auto-restarts preempted VMs when capacity returns
- No data loss — each call is an independent unit of work

## Timeline Summary

| Phase | Duration | Cost |
|---|---|---|
| 1. Filter calls in BigQuery | 5 minutes | Free |
| 2. Set up GPU fleet + queue | 1-2 hours | Free |
| 3. Run transcription (4x L4, 380k calls) | ~5 days | ~$200 |
| 4. Teardown | 5 minutes | Free |
| **Total** | **~5 days** | **~$200** |

## Future Enhancements

- **Sentiment analysis**: Run classified transcripts through an LLM for sentiment scoring
- **Topic extraction**: Categorize calls by topic (complaint, enquiry, booking, etc.)
- **Agent scoring**: Compare agent performance based on transcript quality metrics
- **Real-time pipeline**: Transcribe new recordings as they arrive (trigger on Drive upload)
- **Speaker diarization**: Use `whisperx` for speaker-separated transcripts (who said what)
- **Searchable index**: Export transcripts to a full-text search engine (Elasticsearch/Typesense)
