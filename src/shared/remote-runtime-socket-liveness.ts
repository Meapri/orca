// Why: a half-open tunnel (devtunnel/NAT drop) never delivers a ws `close`,
// so edge-triggered reconnect logic on the client side never fires while the
// server has long since reaped its end (#7718/#7489). This monitor gives
// client sockets a level-based liveness check: ping on a cadence and declare
// the socket dead when no inbound traffic (frames, pings, or pongs) arrives
// within the window, so the existing close/reconnect path can run.

// Why: pings ride the RFC 6455 control-frame layer, which every supported
// server (and the `ws` package it embeds) answers automatically — this stays
// backward compatible with old servers that predate client-side liveness.
export const REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS = 10_000
// Why: just under two server heartbeat periods (15s), so a dead link is
// detected on a similar horizon to the server's own ping/terminate reaper.
export const REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS = 25_000

// Why: an empty ping makes the peer auto-pong an empty payload, and an empty write fails with
// EFAULT on Electron/Linux ARM64 hosts (39-bit VA, e.g. Raspberry Pi), dropping the socket every
// heartbeat (#20673). A non-empty payload is echoed verbatim, so even an unpatched peer never
// writes an empty frame in answer to our probes. RFC 6455 permits up to 125 bytes on any peer.
export const REMOTE_RUNTIME_SOCKET_PING_PAYLOAD: Uint8Array = new Uint8Array([
  0x6f, 0x72, 0x63, 0x61
])

export type RemoteRuntimeSocketLivenessOptions = {
  pingIntervalMs?: number
  livenessTimeoutMs?: number
}

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  stop: () => void
}

export function startRemoteRuntimeSocketLiveness(args: {
  ping: () => void
  onDead: () => void
  options?: RemoteRuntimeSocketLivenessOptions
  now?: () => number
}): RemoteRuntimeSocketLivenessMonitor {
  const now = args.now ?? Date.now
  const pingIntervalMs = args.options?.pingIntervalMs ?? REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS
  const livenessTimeoutMs =
    args.options?.livenessTimeoutMs ?? REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS
  let lastTickAt = now()
  let probeSentAt: number | null = null
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) {
      return
    }
    const tickAt = now()
    const tickElapsedMs = tickAt - lastTickAt
    lastTickAt = tickAt
    // Why: sleep and background throttling age sockets without giving them a chance to answer.
    if (tickElapsedMs < 0 || tickElapsedMs > pingIntervalMs * 1.5) {
      probeSentAt = tickAt
      tryPing()
      return
    }
    if (probeSentAt !== null && tickAt - probeSentAt > livenessTimeoutMs) {
      stop()
      args.onDead()
      return
    }
    if (probeSentAt === null) {
      probeSentAt = tickAt
      tryPing()
    }
  }, pingIntervalMs)
  // Why: mobile typechecks shared code with DOM timer types where unref is absent.
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') {
    unrefable.unref()
  }

  function stop(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
  }

  function tryPing(): void {
    try {
      args.ping()
    } catch {
      // Why: ping() can throw while a socket is mid-teardown; the probe deadline still settles it.
    }
  }

  return {
    noteActivity: () => {
      probeSentAt = null
    },
    stop
  }
}
