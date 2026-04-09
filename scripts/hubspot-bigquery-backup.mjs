#!/usr/bin/env node
/**
 * HubSpot → BigQuery full backup
 *
 * Extracts every HubSpot object type into BigQuery tables with all properties,
 * tracks property change history for sensitive fields, and supports Parquet export.
 *
 * Usage:
 *   node scripts/hubspot-bigquery-backup.mjs                        # full backup
 *   node scripts/hubspot-bigquery-backup.mjs --dry-run              # discover only
 *   node scripts/hubspot-bigquery-backup.mjs --only contacts,calls  # specific types
 *   node scripts/hubspot-bigquery-backup.mjs --skip contacts        # skip types
 *   node scripts/hubspot-bigquery-backup.mjs --history-only         # property history only
 *   node scripts/hubspot-bigquery-backup.mjs --export-parquet       # export all tables to GCS
 */

import { BigQuery } from '@google-cloud/bigquery'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { createWriteStream } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI Flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const HISTORY_ONLY = args.includes('--history-only')
const EXPORT_PARQUET = args.includes('--export-parquet')
const LOG_FILE = args.find((_, i) => args[i - 1] === '--log-file') || null

const onlyArg = args.find((_, i) => args[i - 1] === '--only')
const skipArg = args.find((_, i) => args[i - 1] === '--skip')
const ONLY_TYPES = onlyArg ? onlyArg.split(',').map(s => s.trim()) : null
const SKIP_TYPES = skipArg ? new Set(skipArg.split(',').map(s => s.trim())) : new Set()

// ─── Config ──────────────────────────────────────────────────────────────────

const HUBSPOT_API_BASE = 'https://api.hubapi.com'
const RATE_LIMIT_DELAY_MS = 120 // ~8 req/s
const MAX_RETRIES = 5
const PAGE_SIZE = 100
const PROPERTY_BATCH_SIZE = 50 // avoid URL length limits
const ASSOCIATION_BATCH_SIZE = 1000

const BQ_PROJECT = 'chf-big-query'
const BQ_DATASET = 'hubspot_backup'
const GCS_PARQUET_BUCKET = 'chf-hubspot-parquet'

// CRM object types extracted via /crm/v3/objects/{type}
const CRM_OBJECT_TYPES = [
  'contacts', 'companies', 'deals',
  'calls', 'emails', 'notes', 'tasks', 'meetings',
  'tickets', 'products', 'line_items', 'quotes', 'feedback_submissions',
]

// Properties to track change history for
const HISTORY_PROPERTIES = {
  contacts: ['leads_rep', 'water_test_date', 'water_test_time', 'hubspot_owner_id'],
  deals: ['hubspot_owner_id'],
}

// Association pairs to extract
const ASSOCIATION_PAIRS = [
  { from: 'contacts', to: 'companies', table: 'assoc_contact_company' },
  { from: 'deals', to: 'contacts', table: 'assoc_deal_contact' },
  { from: 'deals', to: 'companies', table: 'assoc_deal_company' },
  { from: 'deals', to: 'line_items', table: 'assoc_deal_line_item' },
  { from: 'tickets', to: 'contacts', table: 'assoc_ticket_contact' },
  { from: 'quotes', to: 'deals', table: 'assoc_quote_deal' },
]

// ─── Logging ─────────────────────────────────────────────────────────────────

let logStream = null
if (LOG_FILE) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  const { createWriteStream } = await import('fs')
  logStream = createWriteStream(LOG_FILE, { flags: 'a' })
}

function log(...args) {
  const ts = new Date().toISOString()
  const msg = `[${ts}] ${args.join(' ')}`
  console.log(msg)
  logStream?.write(msg + '\n')
}

function logError(...args) {
  const ts = new Date().toISOString()
  const msg = `[${ts}] ERROR: ${args.join(' ')}`
  console.error(msg)
  logStream?.write(msg + '\n')
}

// ─── Env Loading ─────────────────────────────────────────────────────────────

function loadEnv() {
  // On the VM, credentials come from environment variables directly
  const hubspotToken = process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_ACCESS_TOKEN

  if (hubspotToken) return hubspotToken

  // Fallback: load from .env.local (local dev)
  const envPath = join(__dirname, '..', '.env.local')
  if (!existsSync(envPath)) {
    console.error('No HUBSPOT_API_KEY env var and no .env.local found')
    process.exit(1)
  }

  const envContent = readFileSync(envPath, 'utf-8')
  const envVars = {}
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/)
    if (match) envVars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
  })

  const token = envVars.HUBSPOT_API_KEY || envVars.HUBSPOT_ACCESS_TOKEN
  if (!token) {
    console.error('No HubSpot token found in env or .env.local')
    process.exit(1)
  }
  return token
}

const HUBSPOT_TOKEN = loadEnv()

// ─── Rate-Limited Fetch ──────────────────────────────────────────────────────

let lastRequestTime = 0

async function rateLimitedFetch(url, options = {}) {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - elapsed)
  }
  lastRequestTime = Date.now()

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (res.status === 429) {
      const backoff = 1100 * Math.pow(2, attempt)
      log(`  Rate limited (429), backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
      await sleep(backoff)
      continue
    }

    // Retry transient HubSpot 5xx errors (502/503/504 are common on large batches)
    if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
      const backoff = 2000 * Math.pow(2, attempt) // 2s, 4s, 8s, 16s, 32s
      log(`  HubSpot ${res.status}, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
      await sleep(backoff)
      continue
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HubSpot API ${res.status}: ${text.substring(0, 500)}`)
    }

    return res.json()
  }

  throw new Error(`HubSpot API: exhausted ${MAX_RETRIES} retries on 429`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── BigQuery Client ─────────────────────────────────────────────────────────

function getBigQuery() {
  // GOOGLE_APPLICATION_CREDENTIALS env var is used automatically by the SDK
  return new BigQuery({ projectId: BQ_PROJECT })
}

async function ensureDataset(bq) {
  const dataset = bq.dataset(BQ_DATASET)
  const [exists] = await dataset.exists()
  if (!exists) {
    log(`Creating dataset ${BQ_DATASET}...`)
    await bq.createDataset(BQ_DATASET, { location: 'australia-southeast1' })
  }
  return dataset
}

// ─── JSONL Temp File Helpers ─────────────────────────────────────────────────

const TEMP_DIR = join(__dirname, '..', '.tmp-bq-backup')

function initTempDir({ preserveExisting = false } = {}) {
  if (!preserveExisting && existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true })
  }
  mkdirSync(TEMP_DIR, { recursive: true })
}

function cleanupTempDir() {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true })
}

function writeJsonl(tableName, rows) {
  const path = join(TEMP_DIR, `${tableName}.jsonl`)
  const content = rows.map(r => JSON.stringify(r)).join('\n')
  writeFileSync(path, content + '\n')
  return path
}

// ─── Load JSONL into BigQuery ────────────────────────────────────────────────

async function loadToBigQuery(dataset, tableName, jsonlPath, writeDisposition = 'WRITE_TRUNCATE') {
  const table = dataset.table(tableName)

  // Build all-STRING schema from first JSONL row to avoid BigQuery autodetect
  // type inference issues. HubSpot returns mixed types (e.g. "123;456" for
  // hs_hd_ticket_ids, "undefined" for booleans) that break autodetect.
  // Reading only first 64KB avoids loading the entire file (can be 10+ GB).
  const fd = openSync(jsonlPath, 'r')
  const buf = Buffer.alloc(65536)
  const bytesRead = readSync(fd, buf)
  closeSync(fd)
  const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0]
  const fields = Object.keys(JSON.parse(firstLine))

  const metadata = {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    schema: { fields: fields.map(name => ({ name, type: 'STRING' })) },
    writeDisposition,
  }

  log(`  Loading ${tableName} into BigQuery (${writeDisposition})...`)
  const [job] = await table.load(jsonlPath, metadata)

  const errors = job.status?.errors
  if (errors && errors.length > 0) {
    throw new Error(`BigQuery load errors for ${tableName}: ${JSON.stringify(errors)}`)
  }
}

// ─── Property Discovery ──────────────────────────────────────────────────────

async function discoverProperties(objectType) {
  const data = await rateLimitedFetch(
    `${HUBSPOT_API_BASE}/crm/v3/properties/${objectType}`
  )
  return data.results.map(p => p.name)
}

// ─── Streaming Paginated CRM Object Fetch ───────────────────────────────────
//
// Streams pages directly to JSONL on disk — zero memory accumulation.
// Each property batch is loaded into a separate BigQuery temp table,
// then merged server-side with a BigQuery JOIN.

async function streamObjectToBigQuery(dataset, objectType, properties, historyProps = [], progress = null) {
  const syncTs = new Date().toISOString()

  // Split properties into batches to avoid URL length limits
  const propBatches = []
  for (let i = 0; i < properties.length; i += PROPERTY_BATCH_SIZE) {
    propBatches.push(properties.slice(i, i + PROPERTY_BATCH_SIZE))
  }

  const batchTableNames = []
  let totalRecords = 0
  let historyJsonlPath = null

  // Resume support: check if we were mid-extraction for this type
  const resume = progress?.inProgress?.objectType === objectType ? progress.inProgress : null
  if (resume) {
    log(`  Resuming ${objectType} from batch ${resume.batchIdx}, page ${resume.pageCount}, cursor ${resume.after}`)
  }

  for (let batchIdx = resume?.batchIdx || 0; batchIdx < propBatches.length; batchIdx++) {
    const batch = propBatches[batchIdx]
    const useHistory = batchIdx === 0 && historyProps.length > 0
    const pageSize = useHistory ? 50 : PAGE_SIZE
    const batchTableName = propBatches.length === 1
      ? objectType
      : `${objectType}__batch_${batchIdx}`

    const jsonlPath = join(TEMP_DIR, `${batchTableName}.jsonl`)
    let recordCount = resume?.batchIdx === batchIdx ? (resume.recordCount || 0) : 0
    let pageCount = resume?.batchIdx === batchIdx ? (resume.pageCount || 0) : 0
    let after = resume?.batchIdx === batchIdx ? resume.after : undefined

    // Stream history rows to separate file
    if (useHistory && !historyJsonlPath) {
      historyJsonlPath = join(TEMP_DIR, `${objectType}__history.jsonl`)
    }

    while (true) {
      let url = `${HUBSPOT_API_BASE}/crm/v3/objects/${objectType}?limit=${pageSize}&properties=${batch.join(',')}`
      if (useHistory) url += `&propertiesWithHistory=${historyProps.join(',')}`
      if (after) url += `&after=${after}`

      const data = await rateLimitedFetch(url)
      pageCount++

      // Stream this page directly to JSONL file
      const lines = []
      for (const record of data.results) {
        const row = {
          _hs_id: record.id,
          ...(batchIdx === 0 ? {
            _hs_created_at: record.createdAt,
            _hs_updated_at: record.updatedAt,
            _hs_archived: String(record.archived || false),
            _sync_timestamp: syncTs,
          } : {}),
          ...record.properties,
        }
        lines.push(JSON.stringify(row))

        // Stream property history to separate file
        if (useHistory && record.propertiesWithHistory) {
          for (const prop of historyProps) {
            for (const change of record.propertiesWithHistory[prop] || []) {
              appendFileSync(historyJsonlPath, JSON.stringify({
                object_type: objectType,
                object_id: record.id,
                property_name: prop,
                value: change.value || '',
                timestamp: change.timestamp,
                source_type: change.sourceType || '',
                source_id: change.sourceId || '',
                updated_by_user_id: change.updatedByUserId || '',
              }) + '\n')
            }
          }
        }
      }

      // Append page to JSONL file (no memory accumulation)
      if (lines.length > 0) {
        appendFileSync(jsonlPath, lines.join('\n') + '\n')
      }
      recordCount += data.results.length

      // Save cursor checkpoint every 100 pages for resume on crash
      const nextAfter = data.paging?.next?.after
      if (pageCount % 100 === 0) {
        log(`  ${objectType}: batch ${batchIdx + 1}/${propBatches.length}, ${pageCount} pages, ${recordCount} records...`)
        if (progress && nextAfter) {
          progress.inProgress = { objectType, batchIdx, pageCount, recordCount, after: nextAfter }
          saveProgress(progress)
        }
      }

      if (nextAfter) {
        after = nextAfter
      } else {
        break
      }
    }

    if (batchIdx === 0) totalRecords = recordCount
    log(`  ${objectType}: batch ${batchIdx + 1}/${propBatches.length} done — ${recordCount} records, ${pageCount} pages`)

    // Load this batch into BigQuery immediately, then delete the file
    if (recordCount > 0) {
      await loadToBigQuery(dataset, batchTableName, jsonlPath)
      batchTableNames.push(batchTableName)
    }

    // Delete JSONL to free disk space
    if (existsSync(jsonlPath)) rmSync(jsonlPath)
  }

  // If multiple property batches, JOIN them in BigQuery into the final table
  if (propBatches.length > 1 && batchTableNames.length > 1) {
    log(`  ${objectType}: merging ${batchTableNames.length} property batches in BigQuery...`)
    const bq = getBigQuery()
    const baseTable = batchTableNames[0]

    // Build JOIN query — all batches join on _hs_id.
    // Dedupe column names across batches: HubSpot returns built-in props
    // (hs_object_id, etc.) in every response regardless of what you request,
    // so those columns appear in multiple batch tables.
    const [baseMeta] = await dataset.table(baseTable).getMetadata()
    const seenCols = new Set(baseMeta.schema.fields.map(f => f.name))
    let joinQuery = `SELECT base.*`
    for (let i = 1; i < batchTableNames.length; i++) {
      const [batchMeta] = await dataset.table(batchTableNames[i]).getMetadata()
      const batchCols = batchMeta.schema.fields
        .map(f => f.name)
        .filter(n => !seenCols.has(n))
      for (const col of batchCols) {
        joinQuery += `, b${i}.\`${col}\``
        seenCols.add(col)
      }
    }
    joinQuery += `\nFROM \`${BQ_PROJECT}.${BQ_DATASET}.${baseTable}\` AS base`
    for (let i = 1; i < batchTableNames.length; i++) {
      joinQuery += `\nLEFT JOIN \`${BQ_PROJECT}.${BQ_DATASET}.${batchTableNames[i]}\` AS b${i} ON base._hs_id = b${i}._hs_id`
    }

    // Create final merged table
    await bq.query({
      query: `CREATE OR REPLACE TABLE \`${BQ_PROJECT}.${BQ_DATASET}.${objectType}\` AS ${joinQuery}`,
    })

    // Clean up batch tables
    for (const name of batchTableNames) {
      if (name !== objectType) {
        try { await dataset.table(name).delete() } catch { /* ignore */ }
      }
    }
    log(`  ${objectType}: merge complete`)
  }

  return { totalRecords, historyJsonlPath }
}

// ─── Special Endpoint Fetchers ───────────────────────────────────────────────

async function fetchOwners() {
  const records = []
  let after = undefined

  while (true) {
    let url = `${HUBSPOT_API_BASE}/crm/v3/owners?limit=${PAGE_SIZE}`
    if (after) url += `&after=${after}`

    const data = await rateLimitedFetch(url)

    for (const owner of data.results) {
      records.push({
        _hs_id: owner.id,
        user_id: owner.userId || '',
        email: owner.email || '',
        first_name: owner.firstName || '',
        last_name: owner.lastName || '',
        type: owner.type || '',
        archived: String(owner.archived || false),
        created_at: owner.createdAt || '',
        updated_at: owner.updatedAt || '',
      })
    }

    if (data.paging?.next?.after) {
      after = data.paging.next.after
    } else {
      break
    }
  }

  return records
}

async function fetchPipelines(objectType) {
  const data = await rateLimitedFetch(
    `${HUBSPOT_API_BASE}/crm/v3/pipelines/${objectType}`
  )

  const pipelineRows = []
  const stageRows = []

  for (const pipeline of data.results) {
    pipelineRows.push({
      _hs_id: pipeline.id,
      object_type: objectType,
      label: pipeline.label || '',
      display_order: String(pipeline.displayOrder ?? ''),
      archived: String(pipeline.archived || false),
      created_at: pipeline.createdAt || '',
      updated_at: pipeline.updatedAt || '',
    })

    for (const stage of pipeline.stages || []) {
      stageRows.push({
        _hs_id: stage.id,
        pipeline_id: pipeline.id,
        object_type: objectType,
        label: stage.label || '',
        display_order: String(stage.displayOrder ?? ''),
        archived: String(stage.archived || false),
        created_at: stage.createdAt || '',
        updated_at: stage.updatedAt || '',
        metadata: JSON.stringify(stage.metadata || {}),
      })
    }
  }

  return { pipelineRows, stageRows }
}

async function fetchLists() {
  const records = []
  let offset = 0

  while (true) {
    const data = await rateLimitedFetch(
      `${HUBSPOT_API_BASE}/contacts/v1/lists?count=250&offset=${offset}`
    )

    for (const list of data.lists || []) {
      records.push({
        _hs_id: String(list.listId),
        name: list.name || '',
        list_type: list.listType || '',
        dynamic: String(list.dynamic || false),
        portal_id: String(list.portalId || ''),
        created_at: list.createdAt ? new Date(list.createdAt).toISOString() : '',
        updated_at: list.updatedAt ? new Date(list.updatedAt).toISOString() : '',
        metadata_size: String(list.metaData?.size ?? ''),
        archived: String(list.archived || false),
      })
    }

    if (data['has-more']) {
      offset = data.offset
    } else {
      break
    }
  }

  return records
}

async function fetchForms() {
  const records = []
  let after = undefined

  while (true) {
    let url = `${HUBSPOT_API_BASE}/marketing/v3/forms?limit=${PAGE_SIZE}`
    if (after) url += `&after=${after}`

    const data = await rateLimitedFetch(url)

    for (const form of data.results || []) {
      records.push({
        _hs_id: form.id,
        name: form.name || '',
        form_type: form.formType || '',
        archived: String(form.archived || false),
        created_at: form.createdAt || '',
        updated_at: form.updatedAt || '',
        field_count: String((form.fieldGroups || []).reduce((sum, g) => sum + (g.fields?.length || 0), 0)),
      })
    }

    if (data.paging?.next?.after) {
      after = data.paging.next.after
    } else {
      break
    }
  }

  return records
}

async function fetchWorkflows() {
  const records = []
  let after = undefined

  while (true) {
    let url = `${HUBSPOT_API_BASE}/automation/v4/flows?limit=${PAGE_SIZE}`
    if (after) url += `&after=${after}`

    let data
    try {
      data = await rateLimitedFetch(url)
    } catch (err) {
      // Workflows API may not be available on all portals
      if (err.message.includes('403') || err.message.includes('401')) {
        log('  Workflows API not accessible (permissions), skipping')
        return records
      }
      throw err
    }

    for (const flow of data.results || []) {
      records.push({
        _hs_id: String(flow.id),
        name: flow.name || '',
        type: flow.type || '',
        enabled: String(flow.enabled ?? ''),
        created_at: flow.createdAt || '',
        updated_at: flow.updatedAt || '',
      })
    }

    if (data.paging?.next?.after) {
      after = data.paging.next.after
    } else {
      break
    }
  }

  return records
}

// ─── Association Extraction ──────────────────────────────────────────────────

async function fetchAssociations(fromType, toType, objectIds) {
  const rows = []

  // Process in batches of ASSOCIATION_BATCH_SIZE
  for (let i = 0; i < objectIds.length; i += ASSOCIATION_BATCH_SIZE) {
    const batch = objectIds.slice(i, i + ASSOCIATION_BATCH_SIZE)
    const inputs = batch.map(id => ({ id }))

    const data = await rateLimitedFetch(
      `${HUBSPOT_API_BASE}/crm/v4/associations/${fromType}/${toType}/batch/read`,
      {
        method: 'POST',
        body: JSON.stringify({ inputs }),
      }
    )

    for (const result of data.results || []) {
      const fromId = result.from?.id
      for (const assoc of result.to || []) {
        rows.push({
          from_object_type: fromType,
          from_object_id: fromId,
          to_object_type: toType,
          to_object_id: assoc.toObjectId,
          association_types: JSON.stringify(assoc.associationTypes || []),
        })
      }
    }

    if (i + ASSOCIATION_BATCH_SIZE < objectIds.length) {
      log(`  ${fromType}→${toType}: ${Math.min(i + ASSOCIATION_BATCH_SIZE, objectIds.length)}/${objectIds.length} IDs processed...`)
    }
  }

  return rows
}

// (Property history merge is now inlined in main())

// ─── Parquet Export ──────────────────────────────────────────────────────────

async function exportParquet(dataset) {
  const [tables] = await dataset.getTables()
  const bq = getBigQuery()

  for (const table of tables) {
    const tableName = table.id
    if (tableName.endsWith('_staging')) continue

    log(`  Exporting ${tableName} to Parquet...`)
    try {
      await bq.query({
        query: `
          EXPORT DATA OPTIONS(
            uri='gs://${GCS_PARQUET_BUCKET}/${tableName}/*.parquet',
            format='PARQUET',
            compression='SNAPPY',
            overwrite=true
          ) AS SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.${tableName}\`
        `,
      })
      log(`  ${tableName} exported`)
    } catch (err) {
      logError(`  Failed to export ${tableName}: ${err.message}`)
    }
  }
}

// ─── Progress Tracking ───────────────────────────────────────────────────────

const PROGRESS_FILE = join(__dirname, '..', '.hubspot-backup-progress.json')

function loadProgress() {
  if (existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'))
    } catch { /* ignore */ }
  }
  return { completedTypes: [], startedAt: null, inProgress: null }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2))
}

function clearProgress() {
  if (existsSync(PROGRESS_FILE)) rmSync(PROGRESS_FILE)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now()
  log('═'.repeat(80))
  log('HubSpot → BigQuery Backup')
  log(`Mode: ${DRY_RUN ? 'DRY RUN' : HISTORY_ONLY ? 'HISTORY ONLY' : EXPORT_PARQUET ? 'PARQUET EXPORT' : 'FULL BACKUP'}`)
  if (ONLY_TYPES) log(`Only: ${ONLY_TYPES.join(', ')}`)
  if (SKIP_TYPES.size) log(`Skip: ${[...SKIP_TYPES].join(', ')}`)
  log('═'.repeat(80))

  const summary = [] // { type, source, rows, columns, status }
  const pendingHistoryFiles = [] // JSONL files with property history rows

  // Set up BigQuery
  let bq, dataset
  if (!DRY_RUN) {
    bq = getBigQuery()
    dataset = await ensureDataset(bq)
    // Preserve existing JSONL files if we're resuming a crashed run
    // (progress.inProgress will be set from a previous failed execution)
    const existingProgress = loadProgress()
    const isResuming = !!existingProgress?.inProgress?.objectType
    if (isResuming) {
      log(`Resume detected: ${existingProgress.inProgress.objectType} @ page ${existingProgress.inProgress.pageCount} — preserving temp files`)
    }
    initTempDir({ preserveExisting: isResuming })
  }

  // Handle Parquet export mode
  if (EXPORT_PARQUET) {
    if (!dataset) {
      bq = getBigQuery()
      dataset = await ensureDataset(bq)
    }
    await exportParquet(dataset)
    log('\nParquet export complete')
    return
  }

  const progress = loadProgress()
  if (!progress.startedAt) {
    progress.startedAt = new Date().toISOString()
  }

  // ── CRM Object Types ──────────────────────────────────────────────────

  if (!HISTORY_ONLY) {
    for (const objectType of CRM_OBJECT_TYPES) {
      if (ONLY_TYPES && !ONLY_TYPES.includes(objectType)) continue
      if (SKIP_TYPES.has(objectType)) continue
      if (progress.completedTypes.includes(objectType)) {
        log(`\nSkipping ${objectType} (already completed in this run)`)
        continue
      }

      log(`\n${'─'.repeat(60)}`)
      log(`Extracting: ${objectType}`)
      log('─'.repeat(60))

      try {
        // Step 1: Discover properties
        const properties = await discoverProperties(objectType)
        log(`  Properties: ${properties.length}`)

        if (DRY_RUN) {
          // Quick count — fetch one page
          const url = `${HUBSPOT_API_BASE}/crm/v3/objects/${objectType}?limit=1`
          try {
            const countData = await rateLimitedFetch(url)
            const total = countData.total ?? countData.results?.length ?? '?'
            log(`  Records (estimate): ${total}`)
            summary.push({ type: objectType, source: 'API', rows: total, columns: properties.length, status: 'discovered' })
          } catch (err) {
            log(`  Could not count: ${err.message}`)
            summary.push({ type: objectType, source: 'API', rows: '?', columns: properties.length, status: 'discovered' })
          }
          continue
        }

        // Step 2: Stream all records to BigQuery (disk-backed, no memory accumulation)
        const historyProps = HISTORY_PROPERTIES[objectType] || []
        const { totalRecords, historyJsonlPath } = await streamObjectToBigQuery(dataset, objectType, properties, historyProps, progress)
        log(`  Loaded ${totalRecords} rows into ${BQ_DATASET}.${objectType}`)

        // Clear in-progress cursor on successful completion
        progress.inProgress = null

        if (historyJsonlPath && existsSync(historyJsonlPath)) {
          pendingHistoryFiles.push(historyJsonlPath)
          log(`  Property history saved to disk`)
        }

        summary.push({ type: objectType, source: 'API', rows: totalRecords, columns: properties.length, status: 'OK' })
        progress.completedTypes.push(objectType)
        saveProgress(progress)
      } catch (err) {
        logError(`Failed on ${objectType}: ${err.message}`)
        summary.push({ type: objectType, source: 'API', rows: 0, columns: 0, status: `FAILED: ${err.message.substring(0, 80)}` })
      }
    }

    // ── Special Endpoints ──────────────────────────────────────────────────

    const specialTypes = [
      { name: 'owners', fetcher: fetchOwners },
      { name: 'lists', fetcher: fetchLists },
      { name: 'forms', fetcher: fetchForms },
      { name: 'workflows', fetcher: fetchWorkflows },
    ]

    for (const { name, fetcher } of specialTypes) {
      if (ONLY_TYPES && !ONLY_TYPES.includes(name)) continue
      if (SKIP_TYPES.has(name)) continue
      if (progress.completedTypes.includes(name)) continue

      log(`\n${'─'.repeat(60)}`)
      log(`Extracting: ${name}`)
      log('─'.repeat(60))

      try {
        if (DRY_RUN) {
          log(`  Would extract ${name}`)
          summary.push({ type: name, source: 'API (special)', rows: '?', columns: '?', status: 'discovered' })
          continue
        }

        const records = await fetcher()
        const syncTs = new Date().toISOString()
        for (const record of records) {
          record._sync_timestamp = syncTs
        }

        if (records.length > 0) {
          const jsonlPath = writeJsonl(name, records)
          await loadToBigQuery(dataset, name, jsonlPath)
        }

        log(`  Loaded ${records.length} rows into ${BQ_DATASET}.${name}`)
        summary.push({ type: name, source: 'API (special)', rows: records.length, columns: Object.keys(records[0] || {}).length, status: 'OK' })
        progress.completedTypes.push(name)
        saveProgress(progress)
      } catch (err) {
        logError(`Failed on ${name}: ${err.message}`)
        summary.push({ type: name, source: 'API (special)', rows: 0, columns: 0, status: `FAILED: ${err.message.substring(0, 80)}` })
      }
    }

    // ── Pipelines (deals + tickets) ──────────────────────────────────────

    if (!ONLY_TYPES || ONLY_TYPES.includes('pipelines')) {
      if (!SKIP_TYPES.has('pipelines') && !progress.completedTypes.includes('pipelines')) {
        log(`\n${'─'.repeat(60)}`)
        log('Extracting: pipelines + stages')
        log('─'.repeat(60))

        try {
          if (DRY_RUN) {
            summary.push({ type: 'pipelines', source: 'API (special)', rows: '?', columns: '?', status: 'discovered' })
            summary.push({ type: 'pipeline_stages', source: 'API (special)', rows: '?', columns: '?', status: 'discovered' })
          } else {
            const allPipelines = []
            const allStages = []

            for (const pipelineType of ['deals', 'tickets']) {
              const { pipelineRows, stageRows } = await fetchPipelines(pipelineType)
              allPipelines.push(...pipelineRows)
              allStages.push(...stageRows)
            }

            const syncTs = new Date().toISOString()
            for (const r of [...allPipelines, ...allStages]) {
              r._sync_timestamp = syncTs
            }

            if (allPipelines.length > 0) {
              const jsonlPath = writeJsonl('pipelines', allPipelines)
              await loadToBigQuery(dataset, 'pipelines', jsonlPath)
            }
            if (allStages.length > 0) {
              const jsonlPath = writeJsonl('pipeline_stages', allStages)
              await loadToBigQuery(dataset, 'pipeline_stages', jsonlPath)
            }

            log(`  Loaded ${allPipelines.length} pipelines, ${allStages.length} stages`)
            summary.push({ type: 'pipelines', source: 'API (special)', rows: allPipelines.length, columns: 7, status: 'OK' })
            summary.push({ type: 'pipeline_stages', source: 'API (special)', rows: allStages.length, columns: 9, status: 'OK' })
            progress.completedTypes.push('pipelines')
            saveProgress(progress)
          }
        } catch (err) {
          logError(`Failed on pipelines: ${err.message}`)
          summary.push({ type: 'pipelines', source: 'API (special)', rows: 0, columns: 0, status: `FAILED: ${err.message.substring(0, 80)}` })
        }
      }
    }

    // ── Associations ───────────────────────────────────────────────────────

    if (!ONLY_TYPES || ONLY_TYPES.includes('associations')) {
      if (!SKIP_TYPES.has('associations') && !progress.completedTypes.includes('associations')) {
        log(`\n${'─'.repeat(60)}`)
        log('Extracting: associations')
        log('─'.repeat(60))

        if (DRY_RUN) {
          for (const pair of ASSOCIATION_PAIRS) {
            summary.push({ type: pair.table, source: 'API (assoc)', rows: '?', columns: 5, status: 'discovered' })
          }
        } else {
          // We need object IDs — read them from already-loaded BigQuery tables
          for (const pair of ASSOCIATION_PAIRS) {
            try {
              log(`  ${pair.from} → ${pair.to}...`)

              // Get IDs from the from-type table
              const [rows] = await bq.query({
                query: `SELECT _hs_id FROM \`${BQ_PROJECT}.${BQ_DATASET}.${pair.from}\``,
              })
              const objectIds = rows.map(r => r._hs_id)

              if (objectIds.length === 0) {
                log(`  No ${pair.from} records, skipping`)
                summary.push({ type: pair.table, source: 'API (assoc)', rows: 0, columns: 5, status: 'OK (empty source)' })
                continue
              }

              const assocRows = await fetchAssociations(pair.from, pair.to, objectIds)
              const syncTs = new Date().toISOString()
              for (const r of assocRows) r._sync_timestamp = syncTs

              if (assocRows.length > 0) {
                const jsonlPath = writeJsonl(pair.table, assocRows)
                await loadToBigQuery(dataset, pair.table, jsonlPath)
              }

              log(`  ${pair.table}: ${assocRows.length} associations`)
              summary.push({ type: pair.table, source: 'API (assoc)', rows: assocRows.length, columns: 5, status: 'OK' })
            } catch (err) {
              logError(`  Failed ${pair.table}: ${err.message}`)
              summary.push({ type: pair.table, source: 'API (assoc)', rows: 0, columns: 0, status: `FAILED: ${err.message.substring(0, 80)}` })
            }
          }

          progress.completedTypes.push('associations')
          saveProgress(progress)
        }
      }
    }
  }

  // ── Property History (always runs unless skipped) ──────────────────────

  if (HISTORY_ONLY) {
    // Need to fetch history separately — stream to disk
    for (const [objectType, histProps] of Object.entries(HISTORY_PROPERTIES)) {
      if (ONLY_TYPES && !ONLY_TYPES.includes(objectType)) continue
      if (SKIP_TYPES.has(objectType)) continue

      log(`\n${'─'.repeat(60)}`)
      log(`Extracting property history: ${objectType} (${histProps.join(', ')})`)
      log('─'.repeat(60))

      try {
        if (DRY_RUN) {
          summary.push({ type: `${objectType}_history`, source: 'API (history)', rows: '?', columns: 9, status: 'discovered' })
          continue
        }

        // Stream with minimal properties + history
        const minProps = ['hs_object_id']
        const { historyJsonlPath } = await streamObjectToBigQuery(dataset, `_histonly_${objectType}`, minProps, histProps)
        if (historyJsonlPath && existsSync(historyJsonlPath)) {
          pendingHistoryFiles.push(historyJsonlPath)
        }

        // Clean up the temp object table (we only wanted the history)
        try { await dataset.table(`_histonly_${objectType}`).delete() } catch { /* ignore */ }

        summary.push({ type: `${objectType}_history`, source: 'API (history)', rows: '?', columns: 9, status: 'OK' })
      } catch (err) {
        logError(`Failed on ${objectType} history: ${err.message}`)
        summary.push({ type: `${objectType}_history`, source: 'API (history)', rows: 0, columns: 0, status: `FAILED: ${err.message.substring(0, 80)}` })
      }
    }
  }

  // ── Merge Property History from disk files ─────────────────────────────

  if (!DRY_RUN && pendingHistoryFiles.length > 0) {
    log(`\n${'─'.repeat(60)}`)
    log(`Merging property history from ${pendingHistoryFiles.length} file(s)...`)
    log('─'.repeat(60))

    try {
      // Concatenate all history JSONL files into one
      const combinedPath = join(TEMP_DIR, 'property_history_combined.jsonl')
      for (const f of pendingHistoryFiles) {
        if (existsSync(f)) {
          appendFileSync(combinedPath, readFileSync(f))
          rmSync(f)
        }
      }

      if (existsSync(combinedPath)) {
        // Load combined file and merge
        const stagingTable = 'property_history_staging'
        await loadToBigQuery(dataset, stagingTable, combinedPath, 'WRITE_TRUNCATE')

        const mainTable = 'property_history'
        const table = dataset.table(mainTable)
        const [exists] = await table.exists()
        const bq = getBigQuery()

        if (!exists) {
          await bq.query({
            query: `CREATE TABLE \`${BQ_PROJECT}.${BQ_DATASET}.${mainTable}\` AS
                    SELECT *, CURRENT_DATE() as sync_date FROM \`${BQ_PROJECT}.${BQ_DATASET}.${stagingTable}\``,
          })
        } else {
          await bq.query({
            query: `MERGE \`${BQ_PROJECT}.${BQ_DATASET}.${mainTable}\` AS target
                    USING (SELECT *, CURRENT_DATE() as sync_date FROM \`${BQ_PROJECT}.${BQ_DATASET}.${stagingTable}\`) AS source
                    ON target.object_type = source.object_type
                      AND target.object_id = source.object_id
                      AND target.property_name = source.property_name
                      AND target.timestamp = source.timestamp
                    WHEN NOT MATCHED THEN INSERT ROW`,
          })
        }
        try { await dataset.table(stagingTable).delete() } catch { /* ignore */ }
        rmSync(combinedPath, { force: true })
        log(`  Property history merge complete`)
        summary.push({ type: 'property_history', source: 'API (history)', rows: 'merged', columns: 9, status: 'OK (merged)' })
      }
    } catch (err) {
      logError(`Property history merge failed: ${err.message}`)
      summary.push({ type: 'property_history', source: 'API (history)', rows: 0, columns: 9, status: `FAILED: ${err.message.substring(0, 80)}` })
    }
  }

  // ── Cleanup & Summary ──────────────────────────────────────────────────

  if (!DRY_RUN) {
    cleanupTempDir()
    clearProgress()
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  log(`\n${'═'.repeat(80)}`)
  log('SUMMARY')
  log('═'.repeat(80))
  log('')
  log(
    'Table'.padEnd(30) +
    'Source'.padEnd(18) +
    'Rows'.padEnd(10) +
    'Cols'.padEnd(8) +
    'Status'
  )
  log('─'.repeat(80))

  for (const s of summary) {
    log(
      String(s.type).padEnd(30) +
      String(s.source).padEnd(18) +
      String(s.rows).padEnd(10) +
      String(s.columns).padEnd(8) +
      s.status
    )
  }

  log('─'.repeat(80))
  log(`Completed in ${elapsed}s`)
  log('')

  const failed = summary.filter(s => s.status.startsWith('FAILED'))
  if (failed.length > 0) {
    logError(`${failed.length} type(s) failed — see above for details`)
    process.exit(1)
  }
}

main().catch(err => {
  logError(`Fatal: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
