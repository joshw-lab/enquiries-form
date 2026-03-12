import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

/** GET /api/agent-mappings — list all agent mappings */
export async function GET() {
  const supabase = getSupabaseServer()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('agent_mappings')
    .select('id, agent_extern_id, ringcx_agent_id, agent_name, leads_rep, hubspot_owner_id')
    .order('agent_name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

/** PATCH /api/agent-mappings — update leads_rep for one or more agents */
export async function PATCH(request: NextRequest) {
  const supabase = getSupabaseServer()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const body = await request.json()

  // Expect: { updates: [{ id: string, leads_rep: string }] }
  const updates: { id: string; leads_rep: string }[] = body.updates
  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
  }

  const errors: string[] = []
  let updated = 0

  for (const { id, leads_rep } of updates) {
    const { error } = await supabase
      .from('agent_mappings')
      .update({ leads_rep, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      errors.push(`${id}: ${error.message}`)
    } else {
      updated++
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ updated, errors }, { status: 207 })
  }

  return NextResponse.json({ updated })
}
