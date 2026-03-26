'use client'

import { useState } from 'react'
import type { RegionPipelineData, CampaignSync, SyncFailure, TodayLead, ServiceAreaCalendar, Region } from '@/lib/dashboard-types'
import { ALL_BUCKET_COLORS, ALL_BUCKET_LABELS, REGIONS } from '@/lib/dashboard-types'
import { pct, slotColor, respClass, formatSpeed, speedColor, timeAgo, Tip } from './utils'

interface RegionDetailViewProps {
  data: RegionPipelineData & { serviceAreaCalendars?: ServiceAreaCalendar[] }
  syncCampaigns: CampaignSync[]
  todayLeads: TodayLead[]
  onBack: () => void
  onSelectRegion: (region: Region) => void
}

const BUCKET_TOOLTIPS = [
  'Under 24 hours since lead_date — HOT tier, highest priority',
  '1–3 days old — still in HOT tier (first 72 hours)',
  '3–7 days old — transitioned from HOT to NEW tier',
  '7–30 days old — NEW tier, active dialling',
  '30–45 days old — NEW tier, approaching aged threshold',
  '45–60 days old — NEW tier, nearing 90-day aging boundary',
  '60–90 days old — NEW tier, will move to OLD campaign at 90 days',
  '90+ days old — moved to OLD/Aged campaign by aging cron',
]

function humanizeFailure(reason: string): string {
  if (reason.startsWith('No valid phone')) return 'No valid phone number'
  const match = reason.match(/leadPhone="([^"]+)".*?(\d+) digits/)
  if (match) {
    const phone = match[1]
    if (phone.startsWith('+64')) return `NZ number (${phone})`
    if (phone.startsWith('+63')) return `Philippines number (${phone})`
    if (phone.startsWith('+49')) return `German number (${phone})`
    if (phone.startsWith('+44')) return `UK number (${phone})`
    if (phone.startsWith('+1')) return `US/CA number (${phone})`
    if (!phone.startsWith('+61')) return `International number (${phone})`
    return `Invalid AU number (${phone})`
  }
  if (reason.includes('HubSpot fetch failed')) return 'Contact not found in HubSpot'
  return reason.length > 60 ? reason.slice(0, 57) + '...' : reason
}

function FailurePanel({ campaignId }: { campaignId: string }) {
  const [failures, setFailures] = useState<SyncFailure[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    if (failures !== null) { setFailures(null); return }
    setLoading(true)
    fetch(`/api/sync-failures?campaignId=${campaignId}`)
      .then((r) => r.json())
      .then((d) => setFailures(d.failures ?? []))
      .catch(() => setFailures([]))
      .finally(() => setLoading(false))
  }

  return (
    <div>
      <button onClick={load} className="text-[11px] text-amber-600 hover:text-amber-800 underline cursor-pointer mt-1">
        {loading ? 'Loading...' : failures ? 'Hide details' : 'View unloadable contacts'}
      </button>
      {failures && failures.length > 0 && (
        <div className="mt-2 max-h-[240px] overflow-y-auto border border-gray-100 rounded bg-gray-50">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="px-2 py-1.5 font-medium">Contact</th>
                <th className="px-2 py-1.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.contactId} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-2 py-1.5 text-gray-700 font-mono">
                    <a
                      href={`https://app.hubspot.com/contacts/48879086/contact/${f.contactId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {f.contactId}
                    </a>
                  </td>
                  <td className="px-2 py-1.5 text-gray-600">{humanizeFailure(f.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failures && failures.length === 0 && (
        <div className="mt-1 text-[11px] text-gray-400">No failure records found</div>
      )}
    </div>
  )
}

export default function RegionDetailView({ data, syncCampaigns, todayLeads, onBack, onSelectRegion }: RegionDetailViewProps) {
  const p72 = pct(data.calendar.slots72h.booked, data.calendar.slots72h.total)
  const open72 = data.calendar.slots72h.total - data.calendar.slots72h.booked
  const hotTier = data.tierMetrics.find((t) => t.tier === 'HOT')
  const totalCallsToday = data.tierMetrics.reduce((sum, t) => sum + t.newCallsToday, 0)
  const totalPasses = data.tierMetrics.reduce((sum, t) => sum + t.passes, 0)

  const leads = todayLeads
  const calledLeads = leads.filter((l) => l.speedToLeadSeconds !== null)
  const uncalledLeads = leads.filter((l) => l.speedToLeadSeconds === null)

  const regionIdx = REGIONS.indexOf(data.region)
  const prevRegion = regionIdx > 0 ? REGIONS[regionIdx - 1] : null
  const nextRegion = regionIdx < REGIONS.length - 1 ? REGIONS[regionIdx + 1] : null

  const maxBucket = Math.max(...data.newPipeline.bucketCounts, 1)

  // Calendar data — use per-service-area if available
  const serviceAreas = data.serviceAreaCalendars && data.serviceAreaCalendars.length > 0
    ? data.serviceAreaCalendars
    : null

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-800 cursor-pointer transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Overview
        </button>

        <div className="flex items-center gap-3">
          {prevRegion && (
            <button
              onClick={() => onSelectRegion(prevRegion)}
              className="flex items-center gap-1 text-[13px] text-gray-400 hover:text-gray-700 cursor-pointer transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
              {prevRegion}
            </button>
          )}
          <span className="text-xl font-extrabold text-[#111827] tracking-tight">{data.region}</span>
          {nextRegion && (
            <button
              onClick={() => onSelectRegion(nextRegion)}
              className="flex items-center gap-1 text-[13px] text-gray-400 hover:text-gray-700 cursor-pointer transition-colors"
            >
              {nextRegion}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        <div className="w-[120px]" /> {/* Spacer for centering */}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-6 gap-3 mb-5">
        {[
          { label: 'Total contacts', value: data.totalContacts.toLocaleString(), color: 'text-[#111827]' },
          { label: 'Hot leads', value: String(hotTier?.totalActive ?? 0), color: 'text-red-500' },
          { label: 'Calls today', value: String(totalCallsToday), color: 'text-blue-600' },
          { label: 'Total passes', value: String(totalPasses), color: 'text-gray-700' },
          { label: 'Open 72h slots', value: String(open72), color: '' },
          { label: 'Speed to lead', value: data.avgResponseTime, color: respClass(data.avgResponseHours) },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex flex-col">
            <span className={`text-2xl font-extrabold leading-none ${
              kpi.label === 'Open 72h slots' ? '' : kpi.color
            }`} style={kpi.label === 'Open 72h slots' ? { color: slotColor(p72) } : undefined}>
              {kpi.value}
            </span>
            <span className="text-[12px] text-gray-500 mt-1.5">{kpi.label}</span>
          </div>
        ))}
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-12 gap-5">
        {/* Left column (7/12) */}
        <div className="col-span-7 flex flex-col gap-5">
          {/* Tier metrics table */}
          <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3 pb-2 border-b border-gray-100">
              Tier Metrics
            </div>
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-gray-500 text-right">
                  <th className="text-left font-medium pb-2"></th>
                  <th className="font-medium pb-2 px-2">Active<Tip text="Leads loaded in the RingCX dialler for this tier" /></th>
                  <th className="font-medium pb-2 px-2">New today<Tip text="Leads that entered this tier today (new ingest or aging move)" /></th>
                  <th className="font-medium pb-2 px-2">Calls today<Tip text="Call attempts made today to leads in this tier" /></th>
                  <th className="font-medium pb-2 px-2">Total passes<Tip text="Total cumulative call attempts across all leads in this tier" /></th>
                </tr>
              </thead>
              <tbody>
                {data.tierMetrics.map((tm) => (
                  <tr key={tm.tier} className="border-t border-gray-100">
                    <td className="py-2.5 pr-2">
                      <span className="text-[14px] font-semibold text-gray-800">{tm.tierLabel}</span>
                    </td>
                    <td className="py-2.5 px-2 text-right font-bold text-gray-900">{tm.totalActive}</td>
                    <td className="py-2.5 px-2 text-right font-bold text-emerald-600">
                      {tm.newToday > 0 ? `+${tm.newToday}` : '0'}
                    </td>
                    <td className="py-2.5 px-2 text-right font-bold text-gray-900">{tm.newCallsToday}</td>
                    <td className="py-2.5 px-2 text-right font-bold text-gray-900">{tm.passes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pipeline age breakdown */}
          <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-blue-600 mb-3 pb-2 border-b border-blue-100">
              Pipeline Age Breakdown
            </div>
            <div className="flex flex-col gap-1">
              {data.newPipeline.bucketCounts.map((v, i) => (
                <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-b-0" title={BUCKET_TOOLTIPS[i]}>
                  <div className="w-[56px] text-[13px] text-[#111827] font-medium">{ALL_BUCKET_LABELS[i]}</div>
                  <div className="flex-1 bg-gray-100 rounded h-2.5 overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${Math.round((v / maxBucket) * 100)}%`, background: ALL_BUCKET_COLORS[i] }} />
                  </div>
                  <div className="w-10 text-right text-[14px] font-bold" style={{ color: ALL_BUCKET_COLORS[i] }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* List sync health */}
          {syncCampaigns.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3 pb-2 border-b border-gray-100">
                List Sync Health
                <Tip text="Counts refreshed every 15 min from HubSpot Lists API and RingCX Campaign API" />
                {syncCampaigns[0]?.lastSynced && (
                  <span className="ml-auto font-normal normal-case text-gray-400">{syncCampaigns[0].lastSynced}</span>
                )}
              </div>
              <div className="flex flex-col gap-3">
                {syncCampaigns.map((sc) => {
                  const rcxUnavailable = sc.ringcxCount < 0
                  const diff = rcxUnavailable ? 0 : sc.hubspotCount - sc.ringcxCount
                  const allExplained = sc.loadFailed > 0 && diff > 0 && diff <= sc.loadFailed
                  const isOk = !rcxUnavailable && (diff === 0 || allExplained)
                  const gapReason = allExplained
                    ? `${sc.loadFailed} contacts could not be loaded (invalid phone numbers)`
                    : diff > 0
                      ? `${diff} leads pending load to RingCX — next ingest cycle will sync`
                      : diff < 0
                        ? `${Math.abs(diff)} excess leads in RingCX — reconciler will clean within 15 min`
                        : undefined
                  return (
                    <div key={sc.campaignId} title={gapReason}>
                      <div className="flex items-center gap-3">
                        <span className={`text-[13px] font-bold w-10 ${
                          sc.listType === 'Hot' ? 'text-red-600'
                          : sc.listType === 'New' ? 'text-blue-600'
                          : 'text-purple-600'
                        }`}>
                          {sc.listType.toUpperCase()}
                        </span>
                        <div className="flex-1 flex items-center gap-2">
                          <div className="flex-1 text-center py-2 rounded" style={{ background: '#f0f9ff', border: '1px solid #e0f2fe' }}>
                            <div className="text-[15px] font-bold text-sky-700">HS {sc.hubspotCount.toLocaleString()}</div>
                          </div>
                          <div className="flex-1 text-center py-2 rounded" style={{
                            background: isOk ? '#f0fdf4' : '#fef2f2',
                            border: `1px solid ${isOk ? '#bbf7d0' : '#fecaca'}`,
                          }}>
                            <div className={`text-[15px] font-bold ${isOk ? 'text-green-700' : 'text-red-600'}`}>
                              RC {sc.ringcxCount >= 0 ? sc.ringcxCount.toLocaleString() : '—'}
                            </div>
                          </div>
                        </div>
                        {diff === 0 ? (
                          <span className="text-green-600 font-bold text-sm w-16 text-right">{'\u2713'}</span>
                        ) : allExplained ? (
                          <span className="text-amber-500 font-bold text-[12px] w-16 text-right" title={`${sc.loadFailed} unloadable`}>
                            {'\u2713'} {sc.loadFailed}
                          </span>
                        ) : diff !== 0 ? (
                          <span className={`text-sm font-bold w-16 text-right ${diff > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                            {diff > 0 ? `-${diff}` : `+${Math.abs(diff)}`}
                          </span>
                        ) : null}
                      </div>
                      {sc.loadFailed > 0 && (
                        <div className="ml-[52px]">
                          <FailurePanel campaignId={sc.campaignId} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Calendar — next 7 days */}
          <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-3 pb-2 border-b border-gray-100">
              Calendar &middot; Next 7 days
            </div>
            {serviceAreas ? (
              <div className="flex flex-col gap-4">
                {serviceAreas.map((sa) => (
                  <div key={sa.serviceArea}>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">{sa.serviceArea}</div>
                    {sa.data.daily.map((slot, i) => {
                      const p = pct(slot.booked, slot.total)
                      const col = slotColor(p)
                      const openSlots = slot.total - slot.booked
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-b-0">
                          <div className="w-[56px] text-[13px] text-[#111827]">{slot.day}</div>
                          <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                            <div className="h-full rounded" style={{ width: `${p}%`, background: col }} />
                          </div>
                          <div className="text-[13px] font-bold min-w-[44px] text-right" style={{ color: col }}>
                            {slot.booked}/{slot.total}
                          </div>
                          <div className="text-[12px] text-gray-500 min-w-[44px] text-right">{openSlots} open</div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            ) : (
              data.calendar.daily.map((slot, i) => {
                const p = pct(slot.booked, slot.total)
                const col = slotColor(p)
                const openSlots = slot.total - slot.booked
                return (
                  <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-b-0">
                    <div className="w-[56px] text-[13px] text-[#111827]">{slot.day}</div>
                    <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${p}%`, background: col }} />
                    </div>
                    <div className="text-[13px] font-bold min-w-[44px] text-right" style={{ color: col }}>
                      {slot.booked}/{slot.total}
                    </div>
                    <div className="text-[12px] text-gray-500 min-w-[44px] text-right">{openSlots} open</div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right column (5/12) — Today's leads */}
        <div className="col-span-5">
          <div className="bg-white border border-gray-200 rounded-lg px-5 py-4 sticky top-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 mb-3 pb-2 border-b border-emerald-100">
              Today&apos;s Leads &middot; {leads.length} added
            </div>

            {leads.length === 0 ? (
              <div className="text-[13px] text-gray-400 py-8 text-center">No leads added today</div>
            ) : (
              <div className="flex flex-col">
                {/* Awaiting call first */}
                {uncalledLeads.map((lead) => (
                  <div key={lead.contactId} className="flex items-center gap-3 py-2.5 border-b border-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-[#111827] font-medium truncate">{lead.name}</div>
                      <div className="text-[12px] text-gray-400">{lead.postcode} &middot; {timeAgo(lead.loadedAt)}</div>
                    </div>
                    <div className="text-[12px] text-gray-300 whitespace-nowrap">
                      awaiting call
                    </div>
                  </div>
                ))}
                {/* Called leads, most recent call first */}
                {calledLeads
                  .sort((a, b) => new Date(b.firstCallAt!).getTime() - new Date(a.firstCallAt!).getTime())
                  .map((lead) => (
                    <div key={lead.contactId} className="flex items-center gap-3 py-2.5 border-b border-gray-50">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-[#111827] font-medium truncate">{lead.name}</div>
                        <div className="text-[12px] text-gray-400">{lead.postcode} &middot; {timeAgo(lead.loadedAt)}</div>
                      </div>
                      <div className={`text-[13px] font-bold whitespace-nowrap ${speedColor(lead.speedToLeadSeconds!)}`}>
                        &#9889; {formatSpeed(lead.speedToLeadSeconds!)}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
