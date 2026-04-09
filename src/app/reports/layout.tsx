'use client'

import { SessionProvider } from 'next-auth/react'

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <div className="min-h-screen bg-gray-50">
        {children}
      </div>
    </SessionProvider>
  )
}
