'use client'

import { useState, useEffect, useRef } from 'react'
import { getSupabase } from '@/lib/supabase'
import {
  FormSubmission,
  getDispositionLabel,
  getDispositionColor,
  formatDuration,
  type CallRecording,
} from '@/lib/reports-queries'

interface CallRecordsTableProps {
  submissions: FormSubmission[]
  onListenClick?: (disposition?: string, title?: string) => void
}

const PAGE_SIZE = 25

export default function CallRecordsTable({ submissions, onListenClick }: CallRecordsTableProps) {
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [recordingsMap, setRecordingsMap] = useState<Record<string, CallRecording>>({})
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const totalPages = Math.ceil(submissions.length / PAGE_SIZE)
  const pageData = submissions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Fetch call recordings matching current page contacts by phone + time window
  useEffect(() => {
    async function loadRecordings() {
      const supabase = getSupabase()
      if (!supabase || pageData.length === 0) return

      // Get the time range for current page
      const timestamps = pageData.map((s) => new Date(s.created_at).getTime())
      const minTime = new Date(Math.min(...timestamps) - 120000).toISOString() // 2 min before
      const maxTime = new Date(Math.max(...timestamps) + 120000).toISOString() // 2 min after

      const { data, error } = await supabase
        .from('call_recordings')
        .select('*')
        .gte('call_start', minTime)
        .lte('call_start', maxTime)
        .in('backup_status', ['uploaded', 'pending', 'downloading'])

      if (error || !data) return

      // Build lookup by hubspot_contact_id + approximate timestamp
      const map: Record<string, CallRecording> = {}
      for (const rec of data as CallRecording[]) {
        if (rec.hubspot_contact_id) {
          // Key: contactId (match within 5 min window in the component)
          const key = rec.hubspot_contact_id
          // Store the most recent one per contact (in case of duplicates)
          if (!map[key] || new Date(rec.call_start) > new Date(map[key].call_start)) {
            map[key] = rec
          }
        }
      }
      setRecordingsMap(map)
    }

    loadRecordings()
  }, [page, submissions])

  function findRecording(submission: FormSubmission): CallRecording | null {
    const contactId = submission.submitted_by?.contact_id || submission.contact?.phone
    if (!contactId) return null

    const rec = recordingsMap[contactId]
    if (!rec) return null

    // Verify timestamp is close (within 5 minutes)
    const subTime = new Date(submission.created_at).getTime()
    const recTime = new Date(rec.call_start).getTime()
    if (Math.abs(subTime - recTime) > 5 * 60 * 1000) return null

    return rec
  }

  function handlePlay(recording: CallRecording) {
    const url = recording.gdrive_file_url
      ? `https://drive.google.com/uc?export=download&id=${recording.gdrive_file_id}`
      : recording.ringcx_recording_url

    if (!url) return

    if (playingId === recording.id) {
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play()
        } else {
          audioRef.current.pause()
        }
      }
      return
    }

    if (audioRef.current) {
      audioRef.current.pause()
    }

    const audio = new Audio(url)
    audio.onended = () => setPlayingId(null)
    audio.play()
    audioRef.current = audio
    setPlayingId(recording.id)
  }

  function handleStop() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setPlayingId(null)
  }

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
      }
    }
  }, [])

  if (submissions.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        No call records found for the selected filters.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Call Records ({submissions.length})
        </h3>
        <div className="flex items-center gap-3">
          {playingId && (
            <button
              onClick={handleStop}
              className="text-xs text-red-600 hover:text-red-700 font-medium"
            >
              Stop Playing
            </button>
          )}
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => { handleStop(); setPage(Math.max(0, page - 1)) }}
                disabled={page === 0}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Prev
              </button>
              <span className="text-gray-500">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => { handleStop(); setPage(Math.min(totalPages - 1, page + 1)) }}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Date/Time</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agent</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Contact</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Phone</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Disposition</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Notes</th>
              <th className="text-center px-4 py-2 text-xs font-medium text-gray-500 w-20">Recording</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((s) => {
              const fd = s.form_data || {}
              const agent = s.agent_name || '-'
              const contactName = s.contact?.name || `${(fd.firstName as string) || ''} ${(fd.lastName as string) || ''}`.trim() || '-'
              const phone = s.contact?.phone || (fd.phoneNumber as string) || '-'
              const disposition = s.disposition || (fd.disposition as string) || 'unknown'
              const notes = (fd.notes as string) || ''
              const timestamp = new Date(s.created_at).toLocaleString('en-AU', {
                timeZone: 'Australia/Perth',
                day: '2-digit',
                month: '2-digit',
                year: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              })
              const isExpanded = expandedId === s.id
              const recording = findRecording(s)
              const isPlaying = recording && playingId === recording.id
              const hasUploadedRecording = recording?.backup_status === 'uploaded' && recording?.gdrive_file_url

              return (
                <tr
                  key={s.id}
                  className={`border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${
                    isPlaying ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => setExpandedId(isExpanded ? null : s.id)}
                >
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{timestamp}</td>
                  <td className="px-4 py-2">{agent}</td>
                  <td className="px-4 py-2">{contactName}</td>
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{phone}</td>
                  <td className="px-4 py-2">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: getDispositionColor(disposition) }}
                    >
                      {getDispositionLabel(disposition)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 max-w-xs truncate">
                    {notes || '-'}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {hasUploadedRecording ? (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handlePlay(recording!)
                          }}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            isPlaying
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                          }`}
                          title={isPlaying ? 'Pause' : 'Listen'}
                        >
                          {isPlaying ? (
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                              <rect x="6" y="4" width="4" height="16" />
                              <rect x="14" y="4" width="4" height="16" />
                            </svg>
                          ) : (
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          )}
                          {isPlaying ? 'Playing' : 'Listen'}
                        </button>
                        <a
                          href={recording!.gdrive_file_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                          title="Open in Google Drive"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    ) : recording ? (
                      <span className="text-[10px] text-amber-500">Pending</span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
