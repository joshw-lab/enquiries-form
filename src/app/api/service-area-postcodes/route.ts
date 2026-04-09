import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/server/api-clients'

/**
 * GET /api/service-area-postcodes
 * Returns all postcodes grouped by state.
 */
export async function GET() {
  try {
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase
      .from('service_area_postcodes')
      .select('state, postcode')
      .order('postcode')
      .limit(5000)

    if (error) throw error

    // Group by state
    const grouped: Record<string, string[]> = {}
    for (const row of data ?? []) {
      if (!grouped[row.state]) grouped[row.state] = []
      grouped[row.state].push(row.postcode)
    }

    return NextResponse.json(grouped)
  } catch (e) {
    console.error('Service area postcodes GET error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * POST /api/service-area-postcodes
 * Add postcodes: { state: string, postcodes: string[] }
 */
export async function POST(request: Request) {
  try {
    const { state, postcodes } = await request.json() as { state: string; postcodes: string[] }

    if (!state || !postcodes?.length) {
      return NextResponse.json({ error: 'state and postcodes[] are required' }, { status: 400 })
    }

    const supabase = getSupabaseServerClient()
    const rows = postcodes.map(p => ({ state, postcode: p.trim() }))

    const { error } = await supabase
      .from('service_area_postcodes')
      .upsert(rows, { onConflict: 'postcode' })

    if (error) throw error

    return NextResponse.json({ success: true, added: postcodes.length })
  } catch (e) {
    console.error('Service area postcodes POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * DELETE /api/service-area-postcodes
 * Remove postcodes: { postcodes: string[] }
 */
export async function DELETE(request: Request) {
  try {
    const { postcodes } = await request.json() as { postcodes: string[] }

    if (!postcodes?.length) {
      return NextResponse.json({ error: 'postcodes[] is required' }, { status: 400 })
    }

    const supabase = getSupabaseServerClient()
    const { error } = await supabase
      .from('service_area_postcodes')
      .delete()
      .in('postcode', postcodes)

    if (error) throw error

    return NextResponse.json({ success: true, removed: postcodes.length })
  } catch (e) {
    console.error('Service area postcodes DELETE error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
