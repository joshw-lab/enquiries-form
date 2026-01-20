import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

let supabase: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (typeof window === 'undefined') return null
  if (!supabaseUrl || !supabaseAnonKey) return null

  if (!supabase) {
    supabase = createClient(supabaseUrl, supabaseAnonKey)
  }
  return supabase
}

export interface PostcodeZone {
  postcode_prefix: string
  map_url: string
  calendar_url: string
}
