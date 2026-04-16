'use client'

import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { useState, useEffect, Suspense } from 'react'

function LoginContent() {
  const searchParams = useSearchParams()
  const error = searchParams.get('error')
  const callbackUrl = searchParams.get('callbackUrl') || '/'
  const [inIframe, setInIframe] = useState(false)

  useEffect(() => {
    try {
      setInIframe(window.self !== window.top)
    } catch {
      setInIframe(true)
    }
  }, [])

  const handleSignIn = () => {
    if (inIframe) {
      // Open auth in a popup — Google blocks iframe rendering
      const width = 500
      const height = 600
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2
      const popup = window.open(
        `/api/auth/signin/google?callbackUrl=${encodeURIComponent('/login/popup-callback')}`,
        'google-auth',
        `width=${width},height=${height},left=${left},top=${top},popup=yes`
      )

      // Listen for the popup to complete
      const handleMessage = (event: MessageEvent) => {
        if (event.data === 'auth-complete') {
          window.removeEventListener('message', handleMessage)
          window.location.href = callbackUrl
        }
      }
      window.addEventListener('message', handleMessage)

      // Fallback: poll for popup close
      const interval = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(interval)
          window.removeEventListener('message', handleMessage)
          window.location.href = callbackUrl
        }
      }, 500)
    } else {
      signIn('google', { callbackUrl })
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Sign In</h1>
          <p className="text-sm text-gray-500 mb-6">Sign in with your Google account to continue</p>

          {error === 'AccessDenied' && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              You are not authorized to access this application.
            </p>
          )}

          {error && error !== 'AccessDenied' && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              Something went wrong. Please try again.
            </p>
          )}

          <button
            type="button"
            onClick={handleSignIn}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors cursor-pointer"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center">Loading...</div>}>
      <LoginContent />
    </Suspense>
  )
}
