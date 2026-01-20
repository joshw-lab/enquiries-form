/**
 * Convert Google Maps viewer URL to embed URL
 * From: https://www.google.com/maps/d/u/3/viewer?mid=...&ll=...&z=...
 * To: https://www.google.com/maps/d/embed?mid=...&ll=...&z=...
 */
export function convertMapViewerToEmbed(viewerUrl: string): string {
  try {
    const url = new URL(viewerUrl)
    const mid = url.searchParams.get('mid')
    const ll = url.searchParams.get('ll')
    const z = url.searchParams.get('z')

    if (!mid) return viewerUrl

    let embedUrl = `https://www.google.com/maps/d/embed?mid=${mid}`
    if (ll) embedUrl += `&ll=${ll}`
    if (z) embedUrl += `&z=${z}`

    return embedUrl
  } catch {
    return viewerUrl
  }
}

/**
 * Convert Google Calendar cid URL to embed URL
 * From: https://calendar.google.com/calendar/u/0?cid=...
 * To: https://calendar.google.com/calendar/embed?src=...&ctz=Australia/Sydney
 */
export function convertCalendarCidToEmbed(cidUrl: string): string {
  try {
    const url = new URL(cidUrl)
    const cid = url.searchParams.get('cid')

    if (!cid) return cidUrl

    // The cid is base64 encoded email address
    const decodedEmail = atob(cid)
    const encodedSrc = encodeURIComponent(decodedEmail)

    return `https://calendar.google.com/calendar/embed?src=${encodedSrc}&ctz=Australia/Sydney&mode=WEEK`
  } catch {
    return cidUrl
  }
}
