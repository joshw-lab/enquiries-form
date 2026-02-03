#!/usr/bin/env node
/**
 * Script to upload postcodes from CSV to Supabase
 * Run with: node scripts/upload-postcodes.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Load env vars from .env.local
const envContent = readFileSync('.env.local', 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/)
  if (match) {
    envVars[match[1].trim()] = match[2].trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

console.log('Supabase URL:', supabaseUrl)

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function uploadPostcodes() {
  console.log('Reading CSV file...')

  const csvPath = './Enquiries Team Postcode Logic - Copy of Sheet1.csv'
  const csvContent = readFileSync(csvPath, 'utf-8')

  // Simple CSV parsing (handling commas in URLs)
  const lines = csvContent.split('\n')
  const header = lines[0]
  console.log('Header:', header)

  const postcodes = []
  const seen = new Set()

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Split by comma, but URLs don't have commas in them for this data
    const parts = line.split(',')
    if (parts.length < 3) continue

    const postcode = parts[0].trim()
    const mapUrl = parts[1].trim()
    const calendarUrl = parts[2].trim()

    if (!postcode || !mapUrl || !calendarUrl) continue
    if (seen.has(postcode)) continue

    seen.add(postcode)
    postcodes.push({
      postcode_prefix: postcode,
      map_url: mapUrl,
      calendar_url: calendarUrl,
    })
  }

  console.log(`Found ${postcodes.length} unique postcodes`)

  // First, delete all existing records
  console.log('Clearing existing postcode_zones table...')
  const { error: deleteError } = await supabase
    .from('postcode_zones')
    .delete()
    .neq('postcode_prefix', '') // Delete all rows

  if (deleteError) {
    console.error('Error clearing table:', deleteError)
    process.exit(1)
  }

  console.log('Table cleared. Inserting new data...')

  // Insert in batches of 500
  const batchSize = 500
  let inserted = 0

  for (let i = 0; i < postcodes.length; i += batchSize) {
    const batch = postcodes.slice(i, i + batchSize)

    const { error } = await supabase
      .from('postcode_zones')
      .insert(batch)

    if (error) {
      console.error(`Error inserting batch starting at ${i}:`, error)
      process.exit(1)
    }

    inserted += batch.length
    console.log(`Inserted ${inserted}/${postcodes.length} postcodes...`)
  }

  console.log(`\nSuccessfully uploaded ${postcodes.length} postcodes to Supabase!`)

  // Verify by counting
  const { count, error: countError } = await supabase
    .from('postcode_zones')
    .select('*', { count: 'exact', head: true })

  if (countError) {
    console.error('Error verifying count:', countError)
  } else {
    console.log(`Verification: ${count} records in postcode_zones table`)
  }
}

uploadPostcodes().catch(console.error)
