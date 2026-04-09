#!/usr/bin/env node
/**
 * Consolidate orphaned `{type}__batch_N` tables in hubspot_backup dataset
 * into single `{type}` tables, JOINed on _hs_id.
 *
 * These orphans are left over from crashed runs of hubspot-bigquery-backup.mjs
 * that exited before the in-script JOIN step ran. This uses the exact same
 * JOIN/drop logic as streamObjectToBigQuery() at line 359-394 of the main script.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./chf-big-query-sa.json \
 *     node scripts/consolidate-batch-tables.mjs
 *
 *   # Dry run:
 *   node scripts/consolidate-batch-tables.mjs --dry-run
 *
 *   # Only specific types:
 *   node scripts/consolidate-batch-tables.mjs --only emails,tasks
 */

import { BigQuery } from '@google-cloud/bigquery'

const DRY_RUN = process.argv.includes('--dry-run')
const ONLY_ARG = process.argv.find(a => a.startsWith('--only'))
const ONLY_TYPES = ONLY_ARG
  ? new Set(ONLY_ARG.split('=')[1]?.split(',') || process.argv[process.argv.indexOf(ONLY_ARG) + 1]?.split(','))
  : null

const BQ_PROJECT = 'chf-big-query'
const BQ_DATASET = 'hubspot_backup'

const bq = new BigQuery({ projectId: BQ_PROJECT })
const dataset = bq.dataset(BQ_DATASET)

async function main() {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning ${BQ_PROJECT}.${BQ_DATASET} for orphaned batch tables...\n`)

  const [tables] = await dataset.getTables()
  const tableNames = tables.map(t => t.id).sort()

  // Group batch tables by their object type prefix
  const batchGroups = new Map() // typeName -> [batchTableName, batchTableName, ...]
  for (const name of tableNames) {
    const m = name.match(/^(.+)__batch_(\d+)$/)
    if (!m) continue
    const [, typeName, idx] = m
    if (ONLY_TYPES && !ONLY_TYPES.has(typeName)) continue
    if (!batchGroups.has(typeName)) batchGroups.set(typeName, [])
    batchGroups.get(typeName).push({ name, idx: parseInt(idx, 10) })
  }

  if (batchGroups.size === 0) {
    console.log('No orphaned batch tables found. Nothing to do.')
    return
  }

  // Sort each group by batch index
  for (const group of batchGroups.values()) {
    group.sort((a, b) => a.idx - b.idx)
  }

  console.log(`Found ${batchGroups.size} types with orphaned batches:\n`)
  for (const [typeName, group] of batchGroups) {
    console.log(`  ${typeName}: ${group.length} batches (${group.map(g => g.name).join(', ')})`)
  }
  console.log()

  for (const [typeName, group] of batchGroups) {
    console.log(`\n─── Consolidating ${typeName} ───`)

    const batchTableNames = group.map(g => g.name)
    const baseTable = batchTableNames[0]

    if (batchTableNames.length === 1) {
      // Only one batch — just rename by CREATE AS SELECT
      console.log(`  Single batch — copying ${baseTable} → ${typeName}`)
      if (!DRY_RUN) {
        await bq.query({
          query: `CREATE OR REPLACE TABLE \`${BQ_PROJECT}.${BQ_DATASET}.${typeName}\` AS
                  SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.${baseTable}\``,
        })
        try { await dataset.table(baseTable).delete() } catch (e) { console.warn(`  Couldn't delete ${baseTable}: ${e.message}`) }
        console.log(`  ✓ ${typeName} created, ${baseTable} dropped`)
      }
      continue
    }

    // Build JOIN query — same pattern as streamObjectToBigQuery line 366-380
    // Track columns already included to avoid duplicates (HubSpot returns
    // hs_object_id and other built-ins in every batch response regardless of
    // which properties were requested).
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

    console.log(`  JOIN query built (${batchTableNames.length} tables)`)

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would CREATE OR REPLACE TABLE ${typeName} AS <join>`)
      continue
    }

    // Get row count before for sanity
    const [baseCountRes] = await bq.query({
      query: `SELECT COUNT(*) AS n FROM \`${BQ_PROJECT}.${BQ_DATASET}.${baseTable}\``,
    })
    const baseCount = parseInt(baseCountRes[0].n, 10)

    console.log(`  Base table ${baseTable}: ${baseCount.toLocaleString()} rows`)
    console.log(`  Running JOIN → ${typeName} ...`)

    await bq.query({
      query: `CREATE OR REPLACE TABLE \`${BQ_PROJECT}.${BQ_DATASET}.${typeName}\` AS ${joinQuery}`,
    })

    const [finalCountRes] = await bq.query({
      query: `SELECT COUNT(*) AS n FROM \`${BQ_PROJECT}.${BQ_DATASET}.${typeName}\``,
    })
    const finalCount = parseInt(finalCountRes[0].n, 10)

    console.log(`  ✓ ${typeName}: ${finalCount.toLocaleString()} rows`)
    if (finalCount !== baseCount) {
      console.warn(`  ⚠ Row count mismatch! base=${baseCount} final=${finalCount}`)
    }

    // Drop the batch tables
    for (const name of batchTableNames) {
      if (name !== typeName) {
        try {
          await dataset.table(name).delete()
          console.log(`  - dropped ${name}`)
        } catch (e) {
          console.warn(`  Couldn't delete ${name}: ${e.message}`)
        }
      }
    }
  }

  console.log('\nDone.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
