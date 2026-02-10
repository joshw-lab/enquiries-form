'use client'

import { useState, useEffect, useRef } from 'react'
import { getSupabase } from '@/lib/supabase'
import {
  fetchCallRecordings,
  getDispositionLabel,
  getDispositionColor,
  formatDuration,
  type CallRecording,
  type Filters,
} from '@/lib/reports-queries'

interface CallRecordingsModalProps {
  open: boolean
  onClose: () => void
  title: string
  filters: Filters & { disposition?: string }
}

export default function CallRecordingsModal({
  open,
  onClose,
  title,
  filters,
}: CallRecordingsModalProps) {
  const [recordings, setRecordings] = useState<CallRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')

    const supabase = getSupabase()
    if (!supabase) {
      setError('Supabase not configured')
      setLoading(false)
      return
    }

    fetchCallRecordings(supabase, filters).then((result) => {
      if (result.error) {
        setError(result.error)
      } else {
        setRecordings(result.data)
      }
      setLoading(false)
    })
  }, [open, filters])

  // Cleanup audio on close
  useEffect(() => {
    if (!open && audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setPlayingId(null)
    }
  }, [open])

  function handlePlay(recording: CallRecording) {
    // Use Google Drive URL if backed up, otherwise try RingCX URL
    const url = recording.gdrive_file_url
      ? `https://drive.google.com/uc?export=download&id=${recording.gdrive_file_id}`
      : recording.ringcx_recording_url

    if (!url) return

    if (playingId === recording.id) {
      // Toggle pause/play
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play()
        } else {
          audioRef.current.pause()
        }
      }
      return
    }

    // Stop current audio
    if (audioRef.current) {
      audioRef.current.pause()
    }

    const audio = new Audio(url)
    audio.onended = () => setPlayingId(null)
    audio.onerror = () => {
      setPlayingId(null)
      setError('Failed to play recording. The file may not be accessible.')
    }
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

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => { handleStop(); onClose() }}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            {!loading && (
              <p className="text-xs text-gray-500 mt-0.5">
                {recordings.length} recording{recordings.length !== 1 ? 's' : ''} found
              </p>
            )}
          </div>
          <button
            onClick={() => { handleStop(); onClose() }}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
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

          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">
              Loading recordings...
            </div>
          ) : recordings.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">
              No recordings found for this filter.
            </div>
          ) : (
            <div className="space-y-2">
              {recordings.map((r) => {
                const disposition = r.disposition || 'unknown'
                const isPlaying = playingId === r.id
                const hasRecording = r.backup_status === 'uploaded' && r.gdrive_file_url
                const isPending = r.backup_status === 'pending' || r.backup_status === 'downloading'
                const timestamp = new Date(r.call_start).toLocaleString('en-AU', {
                  timeZone: 'Australia/Perth',
                  day: '2-digit',
                  month: '2-digit',
                  year: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                })

                return (
                  <div
                    key={r.id}
                    className={`flex items-center gap-4 p-3 rounded-lg border transition-colors ${
                      isPlaying
                        ? 'border-blue-300 bg-blue-50'
                        : 'border-gray-100 hover:border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {/* Play button */}
                    <button
                      onClick={() => hasRecording && handlePlay(r)}
                      disabled={!hasRecording}
                      className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                        hasRecording
                          ? isPlaying
                            ? 'bg-blue-600 text-white hover:bg-blue-700'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                      }`}
                      title={
                        hasRecording
                          ? isPlaying ? 'Pause' : 'Play'
                          : isPending ? 'Backup pending' : 'No recording'
                      }
                    >
                      {isPlaying ? (
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="4" width="4" height="16" />
                          <rect x="14" y="4" width="4" height="16" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>

                    {/* Call info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-900">
                          {r.agent_name || 'Unknown'}
                        </span>
                        <span
                          className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                          style={{ backgroundColor: getDispositionColor(disposition) }}
                        >
                          {getDispositionLabel(disposition)}
                        </span>
                        {r.call_direction && (
                          <span className="text-[10px] text-gray-400 uppercase">
                            {r.call_direction}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                        <span>{timestamp}</span>
                        <span>{r.phone_number || '-'}</span>
                        <span>{formatDuration(r.call_duration_seconds)}</span>
                        {isPending && (
                          <span className="text-amber-500 font-medium">Backup pending</span>
                        )}
                        {r.backup_status === 'failed' && (
                          <span className="text-red-500 font-medium">Backup failed</span>
                        )}
                      </div>
                    </div>

                    {/* Drive link */}
                    {hasRecording && (
                      <a
                        href={r.gdrive_file_url!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-shrink-0 text-gray-400 hover:text-blue-600 transition-colors p-2"
                        title="Open in Google Drive"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
