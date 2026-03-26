import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

interface TimelineEvent {
  id: string
  type: 'loaded' | 'moved' | 'call' | 'disposition' | 'form'
  timestamp: string
  title: string
  description: string
  metadata: Record<string, unknown>
}

export async function GET(request: NextRequest) {
  const contactId = request.nextUrl.searchParams.get('contactId')
  if (!contactId) {
    return NextResponse.json({ error: 'contactId is required' }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY || ''
  )

  const events: TimelineEvent[] = []

  // 1. Lead loads — when lead was pushed to a RingCX campaign
  const { data: loads } = await supabase
    .from('lead_loads')
    .select('id, contact_id, campaign_id, campaign_type, lead_id, dial_priority, priority_reason, priority_context, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })

  if (loads) {
    for (const load of loads) {
      events.push({
        id: `load-${load.id}`,
        type: 'loaded',
        timestamp: load.created_at,
        title: `Loaded to ${load.campaign_type} campaign ${load.campaign_id}`,
        description: `${load.dial_priority || 'NORMAL'} priority — ${load.priority_reason || 'unknown'}`,
        metadata: {
          campaignId: load.campaign_id,
          campaignType: load.campaign_type,
          leadId: load.lead_id,
          dialPriority: load.dial_priority,
          priorityReason: load.priority_reason,
          priorityContext: load.priority_context,
        },
      })
    }
  }

  // 2. Lead routing state (for header/context)
  const { data: routing } = await supabase
    .from('ringcx_lead_routing')
    .select('*')
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle()

  // 2b. Lead routing events — granular activity log
  const { data: routingEvents } = await supabase
    .from('lead_routing_events')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })

  if (routingEvents) {
    for (const evt of routingEvents) {
      const details = (evt.details as Record<string, unknown>) || {}

      let eventType: TimelineEvent['type'] = 'loaded'
      let title = ''
      let description = ''

      switch (evt.event_type) {
        case 'ingested':
          eventType = 'loaded'
          title = `Ingested into ${evt.to_tier} campaign ${evt.to_campaign_id}`
          description = `${details.dial_priority || 'NORMAL'} priority — ${details.age_hours != null ? `${details.age_hours}h old` : 'age unknown'}`
          break
        case 'skipped_duplicate':
          eventType = 'loaded'
          title = `Duplicate skipped — already in ${evt.to_tier} campaign ${evt.to_campaign_id}`
          description = `Requested ${details.requested_tier} campaign ${details.requested_campaign}. Existing RingCX state preserved.`
          break
        case 'moved_hot_to_new':
          eventType = 'moved'
          title = 'Moved HOT → NEW'
          description = `Campaign ${evt.from_campaign_id} → ${evt.to_campaign_id}`
          break
        case 'moved_new_to_old':
          eventType = 'moved'
          title = 'Moved NEW → OLD'
          description = `Campaign ${evt.from_campaign_id} → ${evt.to_campaign_id}`
          break
        case 'moved_manual':
          eventType = 'moved'
          title = `Manual move ${evt.from_tier || '?'} → ${evt.to_tier || '?'}`
          description = `Campaign ${evt.from_campaign_id} → ${evt.to_campaign_id}`
          break
      }

      events.push({
        id: `route-evt-${evt.id}`,
        type: eventType,
        timestamp: evt.created_at,
        title,
        description,
        metadata: {
          eventType: evt.event_type,
          fromCampaign: evt.from_campaign_id,
          toCampaign: evt.to_campaign_id,
          fromTier: evt.from_tier,
          toTier: evt.to_tier,
          ringcxLeadId: evt.ringcx_lead_id,
          ...details,
        },
      })
    }
  }

  // Fallback: if no routing events yet, derive from routing timestamps (backwards compat)
  if ((!routingEvents || routingEvents.length === 0) && routing) {
    if (routing.ingested_at) {
      events.push({
        id: `route-ingest-${routing.id}`,
        type: 'loaded',
        timestamp: routing.ingested_at,
        title: `Ingested into ${routing.current_tier === 'HOT' || routing.moved_to_new_at ? 'HOT' : 'NEW'} pipeline`,
        description: `HOT=${routing.hot_campaign_id}, NEW=${routing.new_campaign_id}, OLD=${routing.old_campaign_id || 'none'}`,
        metadata: {
          tier: 'HOT',
          hotCampaign: routing.hot_campaign_id,
          newCampaign: routing.new_campaign_id,
          oldCampaign: routing.old_campaign_id,
        },
      })
    }
    if (routing.moved_to_new_at) {
      events.push({
        id: `route-new-${routing.id}`,
        type: 'moved',
        timestamp: routing.moved_to_new_at,
        title: 'Moved HOT → NEW',
        description: `Campaign ${routing.hot_campaign_id} → ${routing.new_campaign_id}`,
        metadata: {
          fromTier: 'HOT',
          toTier: 'NEW',
          fromCampaign: routing.hot_campaign_id,
          toCampaign: routing.new_campaign_id,
        },
      })
    }
    if (routing.moved_to_old_at) {
      events.push({
        id: `route-old-${routing.id}`,
        type: 'moved',
        timestamp: routing.moved_to_old_at,
        title: 'Moved NEW → OLD',
        description: `Campaign ${routing.new_campaign_id} → ${routing.old_campaign_id}`,
        metadata: {
          fromTier: 'NEW',
          toTier: 'OLD',
          fromCampaign: routing.new_campaign_id,
          toCampaign: routing.old_campaign_id,
        },
      })
    }
  }

  // 3. Call recordings — actual calls made to this contact
  const { data: recordings } = await supabase
    .from('call_recordings')
    .select('id, call_id, call_direction, call_duration_seconds, call_start, disposition, phone_number, agent_name, storage_url, gdrive_file_id, backup_status')
    .eq('hubspot_contact_id', contactId)
    .order('call_start', { ascending: true })

  if (recordings) {
    for (const rec of recordings) {
      const duration = rec.call_duration_seconds
        ? `${Math.floor(rec.call_duration_seconds / 60)}m ${rec.call_duration_seconds % 60}s`
        : 'unknown duration'

      events.push({
        id: `call-${rec.id}`,
        type: 'call',
        timestamp: rec.call_start,
        title: `Call — ${rec.disposition || 'No disposition'}`,
        description: `${rec.agent_name || 'Unknown agent'} — ${duration}`,
        metadata: {
          callId: rec.call_id,
          direction: rec.call_direction,
          durationSeconds: rec.call_duration_seconds,
          disposition: rec.disposition,
          agentName: rec.agent_name,
          phone: rec.phone_number,
          storageUrl: rec.storage_url,
          gdriveFileId: rec.gdrive_file_id,
          backupStatus: rec.backup_status,
        },
      })
    }
  }

  // 4. Disposition webhook logs
  const { data: webhookLogs } = await supabase
    .from('ringcx_webhook_logs')
    .select('id, call_id, payload, status, created_at')
    .eq('hubspot_contact_id', contactId)
    .order('created_at', { ascending: true })

  if (webhookLogs) {
    for (const log of webhookLogs) {
      const disposition = (log.payload as Record<string, unknown>)?.disposition as string || 'unknown'
      events.push({
        id: `webhook-${log.id}`,
        type: 'disposition',
        timestamp: log.created_at,
        title: `Disposition webhook: ${disposition}`,
        description: `Status: ${log.status || 'received'}`,
        metadata: {
          callId: log.call_id,
          status: log.status,
          payload: log.payload,
        },
      })
    }
  }

  // 5. Form submissions
  const { data: submissions } = await supabase
    .from('hubspot_form_submissions')
    .select('id, source, submitted_by, form_data, disposition, created_at')
    .eq('hubspot_contact_id', contactId)
    .order('created_at', { ascending: true })

  if (submissions) {
    for (const sub of submissions) {
      const fd = sub.form_data as Record<string, unknown> || {}
      const agent = (sub.submitted_by as Record<string, unknown>)?.name as string || 'Unknown'
      events.push({
        id: `form-${sub.id}`,
        type: 'form',
        timestamp: sub.created_at,
        title: `Form: ${sub.disposition || (fd.disposition as string) || 'unknown'}`,
        description: `Submitted by ${agent}`,
        metadata: {
          source: sub.source,
          disposition: sub.disposition,
          agent,
        },
      })
    }
  }

  // Sort all events by timestamp
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  // Build contact context from lead_loads
  const firstLoad = loads && loads.length > 0 ? loads[0] : null
  const { data: contactRow } = firstLoad
    ? await supabase
        .from('lead_loads')
        .select('contact_state, contact_postcode, priority_context')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null }

  const firstCallEvent = events.find((e) => e.type === 'call')
  const firstRecordingWithAudio = recordings?.find((r) => r.storage_url)
  const firstRecordingUrl = firstRecordingWithAudio?.storage_url || null

  const context = {
    region: contactRow?.contact_state || null,
    postcode: contactRow?.contact_postcode || null,
    leadCreatedAt: firstLoad?.created_at || null,
    leadDate: (contactRow?.priority_context as Record<string, unknown>)?.lead_date || null,
    firstCallAt: firstCallEvent?.timestamp || null,
    firstRecordingUrl,
  }

  return NextResponse.json({
    contactId,
    events,
    routing: routing || null,
    context,
    totalEvents: events.length,
  })
}
