import type { RegionPipelineData, DashboardThresholds } from './dashboard-types'

export interface HealthScore {
  status: 'urgent' | 'warn' | 'good'
  urgency: 'high' | 'med' | 'low'
  metrics: {
    calendarFill: 'urgent' | 'warn' | 'good'
    hotLeads: 'urgent' | 'warn' | 'good'
    avgResponse: 'urgent' | 'warn' | 'good'
    ringcxDelta: 'urgent' | 'warn' | 'good'
  }
}

export function computeHealthStatus(
  region: RegionPipelineData,
  config: DashboardThresholds
): HealthScore {
  // Calendar fill (72h)
  const calPct = region.calendar.slots72h.total === 0
    ? 100
    : Math.round((region.calendar.slots72h.booked / region.calendar.slots72h.total) * 100)
  const calStatus: HealthScore['status'] =
    calPct < config.calendarFillUrgent ? 'urgent'
    : calPct < config.calendarFillWarn ? 'warn'
    : 'good'

  // Hot leads (< 24h bucket with zero dial attempts)
  const hotLeads = region.newPipeline.bucketCounts[0]
  const hotStatus: HealthScore['status'] =
    hotLeads > config.hotLeadsUrgent ? 'urgent'
    : hotLeads > config.hotLeadsWarn ? 'warn'
    : 'good'

  // Avg response time
  const respStatus: HealthScore['status'] =
    region.avgResponseHours > config.avgResponseUrgent ? 'urgent'
    : region.avgResponseHours > config.avgResponseWarn ? 'warn'
    : 'good'

  // RingCX delta (absolute value of combined pipeline deltas)
  const totalDelta = Math.abs(region.newPipeline.delta) + Math.abs(region.agedPipeline.delta)
  const deltaStatus: HealthScore['status'] =
    totalDelta > config.ringcxDeltaUrgent ? 'urgent'
    : totalDelta > config.ringcxDeltaWarn ? 'warn'
    : 'good'

  // Overall = worst of all metrics
  const all = [calStatus, hotStatus, respStatus, deltaStatus]
  const overallStatus: HealthScore['status'] =
    all.includes('urgent') ? 'urgent'
    : all.includes('warn') ? 'warn'
    : 'good'

  const urgency: HealthScore['urgency'] =
    overallStatus === 'urgent' ? 'high'
    : overallStatus === 'warn' ? 'med'
    : 'low'

  return {
    status: overallStatus,
    urgency,
    metrics: {
      calendarFill: calStatus,
      hotLeads: hotStatus,
      avgResponse: respStatus,
      ringcxDelta: deltaStatus,
    },
  }
}
