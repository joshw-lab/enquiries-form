'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

type Contact = {
  contact_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone_raw: string | null
  phone_e164: string | null
}

type Message = {
  id: string
  direction: 'inbound' | 'outbound'
  from_number: string
  to_number: string
  body: string
  status: string | null
  error_code: string | null
  created_at: string
}

function SmsPageInner() {
  const searchParams = useSearchParams()
  const contactId = searchParams.get('contact_id') || ''

  const [contact, setContact] = useState<Contact | null>(null)
  const [contactError, setContactError] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)

  // Fetch contact once per contactId
  useEffect(() => {
    if (!contactId) {
      setContactError('Missing ?contact_id=... query param')
      return
    }
    setContactError(null)
    setContact(null)
    fetch(`/api/sms/contact?contact_id=${encodeURIComponent(contactId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
        return r.json()
      })
      .then((data: Contact) => setContact(data))
      .catch((e) => setContactError(e instanceof Error ? e.message : 'Failed to load contact'))
  }, [contactId])

  // Poll messages
  const loadMessages = useCallback(async (phone: string) => {
    const r = await fetch(`/api/sms/messages?phone=${encodeURIComponent(phone)}`)
    if (!r.ok) return
    const data = await r.json()
    setMessages(data.messages || [])
  }, [])

  useEffect(() => {
    if (!contact?.phone_e164) return
    const phone = contact.phone_e164
    loadMessages(phone)
    const id = setInterval(() => loadMessages(phone), 3000)
    return () => clearInterval(id)
  }, [contact?.phone_e164, loadMessages])

  // Auto-scroll to newest
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || !contact?.phone_e164) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.contact_id,
          to: contact.phone_e164,
          message: input.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setInput('')
      await loadMessages(contact.phone_e164)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const fullName = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || '(no name)'

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">SMS Conversation</h1>

        {/* Contact panel */}
        <div className="bg-white border rounded-lg p-4 mb-4">
          {contactError && <div className="text-red-600 text-sm">{contactError}</div>}
          {!contact && !contactError && <div className="text-gray-500 text-sm">Loading contact…</div>}
          {contact && (
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-medium">{fullName}</div>
                <div className="text-sm text-gray-600">
                  HubSpot ID: <span className="font-mono">{contact.contact_id}</span>
                </div>
                {contact.email && <div className="text-sm text-gray-600">{contact.email}</div>}
              </div>
              <div className="text-right">
                <div className="text-sm text-gray-500">Mobile</div>
                <div className="font-mono text-base">
                  {contact.phone_e164 || <span className="text-red-600">no valid phone</span>}
                </div>
                {contact.phone_raw && contact.phone_raw !== contact.phone_e164 && (
                  <div className="text-xs text-gray-400 font-mono">(raw: {contact.phone_raw})</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Stream */}
        <div
          ref={streamRef}
          className="bg-white border rounded-lg h-[480px] overflow-y-auto p-4 space-y-2 mb-3"
        >
          {messages.length === 0 && (
            <div className="text-gray-400 text-sm text-center mt-16">
              No messages yet. Send one below to start the conversation.
            </div>
          )}
          {messages.map((m) => {
            const outbound = m.direction === 'outbound'
            return (
              <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                    outbound
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-gray-200 text-gray-900 rounded-bl-sm'
                  }`}
                >
                  <div>{m.body}</div>
                  <div
                    className={`text-[10px] mt-1 ${outbound ? 'text-blue-100' : 'text-gray-500'}`}
                  >
                    {new Date(m.created_at).toLocaleString()}
                    {m.status ? ` · ${m.status}` : ''}
                    {m.error_code ? ` · err ${m.error_code}` : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Composer */}
        <div className="bg-white border rounded-lg p-3">
          <textarea
            className="w-full border rounded-md p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={3}
            placeholder={contact?.phone_e164 ? 'Type your message…' : 'Contact has no valid phone'}
            value={input}
            disabled={!contact?.phone_e164 || sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="text-xs text-gray-500">
              {input.length} chars · ⌘/Ctrl+Enter to send
              {sendError && <span className="text-red-600 ml-2">· {sendError}</span>}
            </div>
            <button
              onClick={handleSend}
              disabled={!input.trim() || !contact?.phone_e164 || sending}
              className="bg-blue-600 disabled:bg-gray-300 text-white rounded-md px-4 py-2 text-sm font-medium"
            >
              {sending ? 'Sending…' : 'Send SMS'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SmsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading…</div>}>
      <SmsPageInner />
    </Suspense>
  )
}
