import { cookies } from 'next/headers'

const COOKIE_NAME = 'reports_session'

function getExpectedToken(): string {
  const password = process.env.REPORTS_PASSWORD || ''
  const secret = process.env.REPORTS_SESSION_SECRET || 'default-secret'
  // Simple hash: base64 of password+secret. Not cryptographic, but sufficient
  // for a shared password on an internal tool.
  const encoder = new TextEncoder()
  const data = encoder.encode(password + secret)
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0
  }
  return Math.abs(hash).toString(36) + '-' + data.length.toString(36)
}

export function createSessionToken(): string {
  return getExpectedToken()
}

export function verifySessionToken(token: string): boolean {
  if (!token) return false
  return token === getExpectedToken()
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies()
  const session = cookieStore.get(COOKIE_NAME)
  if (!session?.value) return false
  return verifySessionToken(session.value)
}

export { COOKIE_NAME }
