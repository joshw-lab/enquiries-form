import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, COOKIE_NAME } from '@/lib/reports-auth'

export async function POST(request: NextRequest) {
  const { password, action } = await request.json()

  // Handle logout
  if (action === 'logout') {
    const response = NextResponse.json({ success: true })
    response.cookies.set(COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return response
  }

  // Handle login
  const expectedPassword = process.env.REPORTS_PASSWORD
  if (!expectedPassword) {
    return NextResponse.json({ success: false, error: 'Reports password not configured' }, { status: 500 })
  }

  if (password !== expectedPassword) {
    return NextResponse.json({ success: false, error: 'Invalid password' }, { status: 401 })
  }

  const token = createSessionToken()
  const response = NextResponse.json({ success: true })
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })

  return response
}
