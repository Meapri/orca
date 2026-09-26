// Which ports a WebSocket listener tries, in order, and which listen failures may fall through.

/**
 * A strictly pinned port (orcad `--port`) could not be bound.
 *
 * Why a dedicated type: an unattended host's clients dial exactly the pinned port, so a silent
 * OS-assigned fallback leaves a green process nothing can reach. The supervisor must see a
 * configuration fault it will not restart-spin on.
 */
export class WebSocketPinnedPortUnavailableError extends Error {
  readonly code: string | null

  constructor(
    readonly host: string,
    readonly port: number,
    cause: unknown
  ) {
    const code = listenErrorCode(cause)
    super(
      `Cannot bind the pinned port ${host}:${port}` +
        `${code ? ` (${code})` : ''}: another process holds it or this account may not use it. ` +
        'Free the port or choose another --port; orcad does not fall back to a different port ' +
        'when one is pinned.'
    )
    this.name = 'WebSocketPinnedPortUnavailableError'
    this.code = code
  }
}

export type WebSocketListenPlan = {
  candidates: number[]
  persistedFallbackPort: number | undefined
  allowOsAssignedPort: boolean
}

export function planWebSocketListenPorts(options: {
  port: number
  fallbackPort?: number
  preferPinnedPort: boolean
  requirePinnedPort: boolean
}): WebSocketListenPlan {
  const { port, fallbackPort, preferPinnedPort, requirePinnedPort } = options
  if (requirePinnedPort) {
    return { candidates: [port], persistedFallbackPort: undefined, allowOsAssignedPort: false }
  }
  const persistedFallbackPort =
    fallbackPort !== undefined && fallbackPort !== 0 && fallbackPort !== port
      ? fallbackPort
      : undefined
  const candidates =
    persistedFallbackPort === undefined
      ? [port]
      : preferPinnedPort
        ? [port, persistedFallbackPort]
        : [persistedFallbackPort, port]
  return { candidates, persistedFallbackPort, allowOsAssignedPort: true }
}

/** Walks the plan; a pinned plan throws `WebSocketPinnedPortUnavailableError` instead of widening. */
export async function listenOnPlannedPorts(
  plan: WebSocketListenPlan,
  pinned: { host: string; port: number },
  tryListen: (port: number) => Promise<void>
): Promise<void> {
  if (!plan.allowOsAssignedPort) {
    try {
      await tryListen(pinned.port)
      return
    } catch (error: unknown) {
      throw isPinnedPortConfigurationError(error)
        ? new WebSocketPinnedPortUnavailableError(pinned.host, pinned.port, error)
        : error
    }
  }
  for (const port of plan.candidates) {
    try {
      await tryListen(port)
      return
    } catch (error: unknown) {
      // Why: a persisted fallback may fail for any reason, while configured ports fall through only when their listen is occupied or denied.
      if (
        port !== plan.persistedFallbackPort &&
        (!isPortListenFallbackError(error, port) || port === 0)
      ) {
        throw error
      }
      console.warn(
        `[ws-transport] Failed to bind port ${port} (${error instanceof Error ? error.message : String(error)}), trying next candidate`
      )
    }
  }
  console.warn('[ws-transport] All configured ports failed to bind, using an OS-assigned port')
  await tryListen(0)
}

function listenErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

export function isPortListenFallbackError(error: unknown, port: number): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  if (error.code === 'EADDRINUSE') {
    return true
  }
  return (
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}

/** Occupied, denied, or an address this host does not own: none is fixed by a restart. */
export function isPinnedPortConfigurationError(error: unknown): boolean {
  const code = listenErrorCode(error)
  return code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL'
}
