import { NextRequest, NextResponse } from 'next/server'
import { DEFAULT_THRESHOLDS, type DashboardThresholds } from '@/lib/dashboard-types'
import { getSupabaseServerClient } from '@/lib/server/api-clients'

export async function GET() {
  try {
    const supabase = getSupabaseServerClient()
    const { data } = await supabase
      .from('dashboard_config')
      .select('value')
      .eq('key', 'thresholds')
      .single()

    if (data?.value) {
      return NextResponse.json({ ...DEFAULT_THRESHOLDS, ...(data.value as object) })
    }
  } catch {
    // Supabase not configured or table doesn't exist — fall through to defaults
  }

  return NextResponse.json(DEFAULT_THRESHOLDS)
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<DashboardThresholds>
    const merged = { ...DEFAULT_THRESHOLDS, ...body }

    const supabase = getSupabaseServerClient()
    await supabase
      .from('dashboard_config')
      .upsert({
        key: 'thresholds',
        value: merged,
        updated_at: new Date().toISOString(),
      })

    return NextResponse.json(merged)
  } catch (e) {
    // If Supabase fails, still return merged defaults
    const body = (await request.json().catch(() => ({}))) as Partial<DashboardThresholds>
    return NextResponse.json({ ...DEFAULT_THRESHOLDS, ...body })
  }
}
