'use client'

import { useState, useEffect } from 'react'

interface AgentMapping {
  id: string
  agent_extern_id: string
  agent_name: string | null
  leads_rep: string | null
  hubspot_owner_id: string | null
}

interface AgentLeadsRepModalProps {
  open: boolean
  onClose: () => void
}

export default function AgentLeadsRepModal({ open, onClose }: AgentLeadsRepModalProps) {
  const [agents, setAgents] = useState<AgentMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    setSuccess('')
    setEdits({})

    fetch('/api/agent-mappings')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to fetch agent mappings')
        return r.json()
      })
      .then((data: AgentMapping[]) => {
        setAgents(data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [open])

  function handleEdit(id: string, value: string) {
    setEdits((prev) => ({ ...prev, [id]: value }))
    setSuccess('')
  }

  function getDisplayValue(agent: AgentMapping): string {
    if (edits[agent.id] !== undefined) return edits[agent.id]
    return agent.leads_rep || agent.agent_name || ''
  }

  function hasChanges(): boolean {
    return Object.entries(edits).some(([id, val]) => {
      const agent = agents.find((a) => a.id === id)
      if (!agent) return false
      const current = agent.leads_rep || agent.agent_name || ''
      return val !== current
    })
  }

  async function handleSave() {
    const updates = Object.entries(edits)
      .filter(([id, val]) => {
        const agent = agents.find((a) => a.id === id)
        if (!agent) return false
        const current = agent.leads_rep || agent.agent_name || ''
        return val !== current
      })
      .map(([id, leads_rep]) => ({ id, leads_rep }))

    if (updates.length === 0) return

    setSaving(true)
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/agent-mappings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to save')
      }

      const result = await response.json()
      setSuccess(`Updated ${result.updated} agent${result.updated !== 1 ? 's' : ''}`)

      // Refresh list
      setAgents((prev) =>
        prev.map((a) => {
          if (edits[a.id] !== undefined) {
            return { ...a, leads_rep: edits[a.id] }
          }
          return a
        })
      )
      setEdits({})
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Agent Leads Rep Mapping</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Edit the HubSpot &ldquo;leads_rep&rdquo; value for each agent
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              {success}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              Loading agents...
            </div>
          ) : agents.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              No agent mappings found
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="py-2 pr-3 font-medium">Agent Name</th>
                  <th className="py-2 px-3 font-medium">Leads Rep Value</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const currentVal = getDisplayValue(agent)
                  const isEdited = edits[agent.id] !== undefined &&
                    edits[agent.id] !== (agent.leads_rep || agent.agent_name || '')

                  return (
                    <tr key={agent.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2.5 pr-3 text-gray-900 font-medium">
                        {agent.agent_name || agent.agent_extern_id}
                      </td>
                      <td className="py-2.5 px-3">
                        <input
                          type="text"
                          value={currentVal}
                          onChange={(e) => handleEdit(agent.id, e.target.value)}
                          className={`w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                            isEdited
                              ? 'border-blue-300 bg-blue-50'
                              : 'border-gray-200 bg-white'
                          }`}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <span className="text-xs text-gray-400">
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges() || saving}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-default cursor-pointer transition-colors"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
