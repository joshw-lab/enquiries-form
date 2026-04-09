import { GoogleAuth } from 'google-auth-library'

/**
 * Check if an email is a member of the allowed Google Workspace group.
 * When AUTH_BYPASS_GROUP_CHECK is true, always returns true (for dev/testing).
 */
export async function checkGroupMembership(email: string): Promise<boolean> {
  if (process.env.AUTH_BYPASS_GROUP_CHECK === 'true') {
    return true
  }

  const groupKey = process.env.ALLOWED_GOOGLE_GROUP_ID
  if (!groupKey) {
    console.error('ALLOWED_GOOGLE_GROUP_ID not set')
    return false
  }

  try {
    const saJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (!saJsonRaw) {
      console.error('GOOGLE_SERVICE_ACCOUNT_JSON not set')
      return false
    }

    let sa: { client_email: string; private_key: string }
    try {
      sa = JSON.parse(saJsonRaw)
    } catch {
      const emailMatch = saJsonRaw.match(/"client_email"\s*:\s*"([^"]+)"/)
      const keyMatch = saJsonRaw.match(/"private_key"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (!emailMatch || !keyMatch) {
        console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON')
        return false
      }
      sa = {
        client_email: emailMatch[1],
        private_key: keyMatch[1].replace(/\\n/g, '\n'),
      }
    }

    const auth = new GoogleAuth({
      credentials: {
        client_email: sa.client_email,
        private_key: sa.private_key.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/admin.directory.group.member.readonly'],
      clientOptions: {
        subject: process.env.GOOGLE_ADMIN_IMPERSONATE_EMAIL,
      },
    })

    const client = await auth.getClient()
    const token = await client.getAccessToken()

    const res = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/groups/${groupKey}/hasMember/${encodeURIComponent(email)}`,
      {
        headers: { Authorization: `Bearer ${token.token}` },
      }
    )

    if (!res.ok) {
      console.error(`Group membership check failed: ${res.status} ${await res.text()}`)
      return false
    }

    const data = await res.json()
    return data.isMember === true
  } catch (err) {
    console.error('Group membership check error:', err)
    return false
  }
}
