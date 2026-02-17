'use client'

import { useState } from 'react'
import { LeadData, LeadSection, LeadField } from '@/lib/lead-api'

interface LeadInfoAccordionProps {
  leadData: LeadData | null
  isLoading: boolean
  error: string | null
  defaultExpandedSections?: string[]
  compact?: boolean
}

// Chevron icon component
function ChevronIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      className={`w-5 h-5 text-gray-500 transition-transform duration-200 ${
        isExpanded ? 'rotate-180' : ''
      }`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  )
}

// Section header component
function SectionHeader({
  label,
  isExpanded,
  onClick,
  fieldCount,
  compact = false,
}: {
  label: string
  isExpanded: boolean
  onClick: () => void
  fieldCount: number
  compact?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors border-b border-gray-200 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}
    >
      <div className="flex items-center gap-2">
        <span className={`font-medium text-gray-900 ${compact ? 'text-sm' : ''}`}>{label}</span>
        <span className={`text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded-full ${compact ? 'text-[10px]' : 'text-xs'}`}>
          {fieldCount}
        </span>
      </div>
      <ChevronIcon isExpanded={isExpanded} />
    </button>
  )
}

// Field display component
function FieldDisplay({ field, compact = false, highlight = false }: { field: LeadField; compact?: boolean; highlight?: boolean }) {
  const displayValue = field.value || '—'
  const isEmpty = !field.value

  return (
    <div className={`${compact ? "py-1" : "py-2"} ${highlight ? 'bg-green-50 px-2 rounded border border-green-200' : ''}`}>
      <dt className={`font-medium uppercase tracking-wide ${compact ? 'text-[10px]' : 'text-xs'} ${highlight ? 'text-green-700' : 'text-gray-500'}`}>
        {field.label}
      </dt>
      <dd className={`mt-0.5 ${compact ? 'text-xs' : 'text-sm'} ${isEmpty ? 'text-gray-400 italic' : highlight ? 'text-green-800 font-medium' : 'text-gray-900'}`}>
        {displayValue}
      </dd>
    </div>
  )
}

// Check if a timestamp (in milliseconds) is less than 24 hours old
function isTimestampLessThan24HoursOld(rawTimestamp: string | undefined): boolean {
  if (!rawTimestamp || isNaN(Number(rawTimestamp))) return false
  return (Date.now() - Number(rawTimestamp)) < 24 * 60 * 60 * 1000
}

// Section content component
function SectionContent({ section, compact = false, rawCreateDate }: { section: LeadSection; compact?: boolean; rawCreateDate?: string }) {
  const fields = Object.entries(section.fields)
  const populatedFields = fields.filter(([, field]) => field.value)
  const emptyFields = fields.filter(([, field]) => !field.value)

  return (
    <div className={`bg-white border-b border-gray-200 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
      {populatedFields.length > 0 && (
        <dl className={`grid gap-x-3 gap-y-0.5 ${compact ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1'}`}>
          {populatedFields.map(([key, field]) => (
            <FieldDisplay
              key={key}
              field={field}
              compact={compact}
              highlight={key === 'createdate' && isTimestampLessThan24HoursOld(rawCreateDate)}
            />
          ))}
        </dl>
      )}
      {emptyFields.length > 0 && (
        <details className="mt-2">
          <summary className={`text-gray-500 cursor-pointer hover:text-gray-700 ${compact ? 'text-[10px]' : 'text-xs'}`}>
            Show {emptyFields.length} empty fields
          </summary>
          <dl className={`mt-1 opacity-60 grid gap-x-3 gap-y-0.5 ${compact ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1'}`}>
            {emptyFields.map(([key, field]) => (
              <FieldDisplay key={key} field={field} compact={compact} />
            ))}
          </dl>
        </details>
      )}
      {populatedFields.length === 0 && emptyFields.length === 0 && (
        <p className={`text-gray-500 italic ${compact ? 'text-xs' : 'text-sm'}`}>No data available</p>
      )}
    </div>
  )
}

// Loading skeleton
function LoadingSkeleton() {
  return (
    <div className="animate-pulse">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="border-b border-gray-200">
          <div className="px-4 py-3 bg-gray-50">
            <div className="h-5 bg-gray-200 rounded w-1/4"></div>
          </div>
        </div>
      ))}
    </div>
  )
}

// Error display
function ErrorDisplay({ error }: { error: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-3">
        <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <p className="text-sm text-gray-600">{error}</p>
    </div>
  )
}

// Main accordion section
function AccordionSection({
  sectionKey,
  section,
  isExpanded,
  onToggle,
  compact = false,
  rawCreateDate,
}: {
  sectionKey: string
  section: LeadSection
  isExpanded: boolean
  onToggle: () => void
  compact?: boolean
  rawCreateDate?: string
}) {
  const fieldCount = Object.values(section.fields).filter(f => f.value).length

  return (
    <div>
      <SectionHeader
        label={section.label}
        isExpanded={isExpanded}
        onClick={onToggle}
        fieldCount={fieldCount}
        compact={compact}
      />
      {isExpanded && <SectionContent section={section} compact={compact} rawCreateDate={rawCreateDate} />}
    </div>
  )
}

// Default priority sections to expand
const DEFAULT_EXPANDED = ['contact', 'property', 'waterAssessment']

export default function LeadInfoAccordion({
  leadData,
  isLoading,
  error,
  defaultExpandedSections = DEFAULT_EXPANDED,
  compact = false,
}: LeadInfoAccordionProps) {
  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(defaultExpandedSections)
  )

  // Toggle section expansion
  const toggleSection = (sectionKey: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }

  // Expand/collapse all
  const expandAll = () => {
    if (leadData) {
      setExpandedSections(new Set(Object.keys(leadData.sections)))
    }
  }

  const collapseAll = () => {
    setExpandedSections(new Set())
  }

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Lead Information</h2>
          <div className="h-4 w-20 bg-gray-200 rounded animate-pulse"></div>
        </div>
        <LoadingSkeleton />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Lead Information</h2>
        </div>
        <ErrorDisplay error={error} />
      </div>
    )
  }

  if (!leadData) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Lead Information</h2>
        </div>
        <div className="px-4 py-6 text-center text-sm text-gray-500">
          No contact ID provided. Lead data will be loaded when a contact_id is present in the URL.
        </div>
      </div>
    )
  }

  // Define section order
  const sectionOrder: (keyof typeof leadData.sections)[] = [
    'contact',
    'leadManagement',
    'property',
    'waterAssessment',
    'appointment',
    'referrals',
    'salesNotes',
    'statusFlags',
  ]

  const allExpanded = expandedSections.size === sectionOrder.length
  const allCollapsed = expandedSections.size === 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden h-full flex flex-col">
      {/* Header with expand/collapse controls */}
      <div className={`bg-gray-50 border-b border-gray-200 flex items-center justify-between ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <div className="flex items-center gap-2">
          <h2 className={`font-semibold text-gray-900 ${compact ? 'text-sm' : ''}`}>Lead Information</h2>
          <span className={`text-gray-500 bg-white px-1.5 py-0.5 rounded border border-gray-200 ${compact ? 'text-[10px]' : 'text-xs'}`}>
            {leadData.id}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={expandAll}
            disabled={allExpanded}
            className={`px-1.5 py-0.5 rounded transition-colors ${compact ? 'text-[10px]' : 'text-xs'} ${
              allExpanded
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-blue-600 hover:bg-blue-50'
            }`}
          >
            All
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={collapseAll}
            disabled={allCollapsed}
            className={`px-1.5 py-0.5 rounded transition-colors ${compact ? 'text-[10px]' : 'text-xs'} ${
              allCollapsed
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-blue-600 hover:bg-blue-50'
            }`}
          >
            None
          </button>
        </div>
      </div>

      {/* Accordion sections - scrollable */}
      <div className="flex-1 overflow-y-auto">
        {sectionOrder.map((sectionKey) => {
          const section = leadData.sections[sectionKey]
          return (
            <AccordionSection
              key={sectionKey}
              sectionKey={sectionKey}
              section={section}
              isExpanded={expandedSections.has(sectionKey)}
              onToggle={() => toggleSection(sectionKey)}
              compact={compact}
              rawCreateDate={sectionKey === 'contact' ? leadData.rawProperties?.createdate : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}
