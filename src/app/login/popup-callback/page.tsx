'use client'

import { useEffect } from 'react'

export default function PopupCallback() {
  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage('auth-complete', window.location.origin)
    }
    window.close()
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-sm text-gray-500">Signing in... this window will close automatically.</p>
    </div>
  )
}
