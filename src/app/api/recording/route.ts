import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy for audio recording files (Google Drive or RingCX).
 * Streams the file with proper Content-Type to avoid CORS/ORB issues
 * that block <audio> elements from loading cross-origin media.
 *
 * Usage:
 *   /api/recording?id=GDRIVE_FILE_ID        — Google Drive file
 *   /api/recording?url=RINGCX_RECORDING_URL  — RingCX direct URL
 */
export async function GET(request: NextRequest) {
  const fileId = request.nextUrl.searchParams.get('id')
  const ringcxUrl = request.nextUrl.searchParams.get('url')

  if (!fileId && !ringcxUrl) {
    return NextResponse.json({ error: 'Missing id or url parameter' }, { status: 400 })
  }

  // Determine the upstream URL to fetch
  let targetUrl: string
  if (fileId) {
    targetUrl = `https://drive.google.com/uc?export=download&id=${fileId}`
  } else {
    // Validate it's actually a RingCX URL to prevent open proxy abuse
    if (!ringcxUrl!.startsWith('https://') || !ringcxUrl!.includes('ringcentral.com')) {
      return NextResponse.json({ error: 'Invalid recording URL' }, { status: 400 })
    }
    targetUrl = ringcxUrl!
  }

  try {
    const res = await fetch(targetUrl, { redirect: 'follow' })

    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${res.status}` },
        { status: res.status },
      )
    }

    const contentType = res.headers.get('content-type') || 'audio/mpeg'
    const contentLength = res.headers.get('content-length')

    const headers: Record<string, string> = {
      'Content-Type': contentType.includes('audio') ? contentType : 'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
    }
    if (contentLength) headers['Content-Length'] = contentLength

    return new Response(res.body, { status: 200, headers })
  } catch (err) {
    console.error('Recording proxy error:', err)
    return NextResponse.json({ error: 'Failed to fetch recording' }, { status: 502 })
  }
}
