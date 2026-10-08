/** Human lines for a runtime offer's browser links, shared by the readiness block and `serve pairing`. */
export type WebClientUrlSet = {
  webClientUrl: string | null
  /** One link per alternate endpoint; absent from older hosts. */
  webClientAlternateUrls?: readonly string[]
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

function describeLoopbackReach(webClientUrl: string): string | null {
  let url: URL
  try {
    url = new URL(webClientUrl)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname) && !url.hostname.startsWith('127.')) {
    return null
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  // Why say so: a loopback link only works on the server itself or through a same-port forward.
  return `  Loopback only: open it on this host, or forward the port first (ssh -L ${port}:${url.hostname}:${port} <server>).`
}

export function formatWebClientUrlLines(urls: WebClientUrlSet): string[] {
  if (!urls.webClientUrl) {
    return []
  }
  const lines = [`Web client URL: ${urls.webClientUrl}`]
  const loopbackReach = describeLoopbackReach(urls.webClientUrl)
  if (loopbackReach) {
    lines.push(loopbackReach)
  }
  for (const alternate of urls.webClientAlternateUrls ?? []) {
    lines.push(`Web client URL (alternate): ${alternate}`)
  }
  return lines
}
