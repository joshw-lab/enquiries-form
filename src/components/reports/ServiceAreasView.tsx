'use client'

import { useState, useEffect, useCallback } from 'react'

const STATES = ['WA', 'VIC', 'NSW/ACT', 'QLD', 'SA'] as const

interface PostcodesByState {
  [state: string]: string[]
}

export default function ServiceAreasView() {
  const [postcodes, setPostcodes] = useState<PostcodesByState>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedStates, setExpandedStates] = useState<Set<string>>(new Set(STATES))
  const [addInput, setAddInput] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  const fetchPostcodes = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/service-area-postcodes')
      if (!res.ok) throw new Error('Failed to fetch postcodes')
      const data = await res.json()
      setPostcodes(data)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchPostcodes() }, [fetchPostcodes])

  const showFeedback = (message: string, type: 'success' | 'error') => {
    setFeedback({ message, type })
    setTimeout(() => setFeedback(null), 3000)
  }

  const toggleState = (state: string) => {
    setExpandedStates(prev => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }

  /** Parse input — supports individual postcodes, comma-separated, and ranges (e.g. 6000-6039) */
  function parsePostcodeInput(input: string): string[] {
    const results: string[] = []
    const parts = input.split(/[,;\s]+/).filter(Boolean)
    for (const part of parts) {
      const rangeMatch = part.match(/^(\d{4})-(\d{4})$/)
      if (rangeMatch) {
        const from = parseInt(rangeMatch[1])
        const to = parseInt(rangeMatch[2])
        if (from <= to && to - from < 1000) {
          for (let i = from; i <= to; i++) results.push(String(i))
        }
      } else if (/^\d{4}$/.test(part)) {
        results.push(part)
      }
    }
    return results
  }

  const handleAdd = async (state: string) => {
    const input = addInput[state]?.trim()
    if (!input) return

    const newPostcodes = parsePostcodeInput(input)
    if (newPostcodes.length === 0) {
      showFeedback('Invalid input. Use 4-digit postcodes, comma-separated, or ranges (e.g. 6000-6039)', 'error')
      return
    }

    // Filter out already existing
    const existing = new Set(postcodes[state] || [])
    const toAdd = newPostcodes.filter(p => !existing.has(p))
    if (toAdd.length === 0) {
      showFeedback('All postcodes already exist', 'error')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/service-area-postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, postcodes: toAdd }),
      })
      if (!res.ok) throw new Error('Failed to add postcodes')
      setAddInput(prev => ({ ...prev, [state]: '' }))
      showFeedback(`Added ${toAdd.length} postcode${toAdd.length > 1 ? 's' : ''}`, 'success')
      await fetchPostcodes()
    } catch (e) {
      showFeedback((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (postcode: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/service-area-postcodes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postcodes: [postcode] }),
      })
      if (!res.ok) throw new Error('Failed to remove postcode')
      showFeedback(`Removed ${postcode}`, 'success')
      await fetchPostcodes()
    } catch (e) {
      showFeedback((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const totalCount = Object.values(postcodes).reduce((sum, arr) => sum + arr.length, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-gray-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-600 text-sm mb-3">{error}</p>
        <button onClick={fetchPostcodes} className="text-sm text-blue-600 hover:underline cursor-pointer">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Service Area Postcodes</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {totalCount} postcodes across {Object.keys(postcodes).length} states.
            Leads outside these postcodes are blocked from RingCX ingestion.
          </p>
        </div>
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div className={`px-4 py-2 rounded-lg text-sm font-medium ${
          feedback.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {feedback.message}
        </div>
      )}

      {/* State sections */}
      {STATES.map(state => {
        const statePostcodes = postcodes[state] || []
        const isExpanded = expandedStates.has(state)

        return (
          <div key={state} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {/* State header */}
            <button
              onClick={() => toggleState(state)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="font-semibold text-sm text-gray-900">{state}</span>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                  {statePostcodes.length}
                </span>
              </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="px-4 pb-4 border-t border-gray-100">
                {/* Add postcodes input */}
                <div className="flex gap-2 mt-3 mb-3">
                  <input
                    type="text"
                    value={addInput[state] || ''}
                    onChange={e => setAddInput(prev => ({ ...prev, [state]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && handleAdd(state)}
                    placeholder="Add postcodes (e.g. 6000, 6050-6071)"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    disabled={saving}
                  />
                  <button
                    onClick={() => handleAdd(state)}
                    disabled={saving || !addInput[state]?.trim()}
                    className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    Add
                  </button>
                </div>

                {/* Postcode chips */}
                <div className="flex flex-wrap gap-1.5">
                  {statePostcodes.map(pc => (
                    <span
                      key={pc}
                      className="group inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-md hover:bg-red-50 hover:text-red-700 transition-colors"
                    >
                      {pc}
                      <button
                        onClick={() => handleRemove(pc)}
                        disabled={saving}
                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 cursor-pointer transition-opacity"
                        title={`Remove ${pc}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                  {statePostcodes.length === 0 && (
                    <p className="text-xs text-gray-400 italic">No postcodes configured for this state</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
