/**
 * Wire contract for orcad's health surface: the readiness payload's `health`, `server.health`
 * and `server.pairingOffer`. In shared so the CLI reads it without the runtime's module graph.
 *
 * Every field added here must be optional for older readers (remote-wire-compatibility.md);
 * absence means "not reported", never "healthy".
 */

export const ORCAD_SERVER_HEALTH_METHOD = 'server.health'
export const ORCAD_SERVER_PAIRING_OFFER_METHOD = 'server.pairingOffer'

/** `checkDaemonHealth`'s verdict words plus `no-daemon` when no endpoint is installed. */
export type OrcadDaemonSelfTestVerdict =
  | 'healthy'
  | 'unreachable'
  | 'rejected'
  | 'pty-spawn-unhealthy'
  | 'no-daemon'

export type OrcadProfileStateAuthorityReport = {
  backend: 'json' | 'sqlite'
  classification: string
  authority_mode: string
  runtime: 'orcad'
  migrated: boolean
}

/**
 * How much a green self-test actually proves.
 *
 * `pty-spawn` — the daemon spawned a real PTY inside its own process and it worked.
 * `handshake` — the daemon answered its protocol handshake, but its spawn probe is a no-op
 *   on this platform (win32: `checkPtySpawnHealth` returns without spawning). Reported
 *   separately rather than folded into `ok`, because claiming a PTY round trip we did not
 *   perform is the failure mode this surface exists to prevent.
 */
export type OrcadPtySelfTestCoverage = 'pty-spawn' | 'handshake'

export type OrcadPtySelfTest = {
  ok: boolean
  coverage: OrcadPtySelfTestCoverage
  /** The daemon's own verdict word, so a failure is diagnosable without re-probing. */
  verdict: OrcadDaemonSelfTestVerdict
  durationMs: number
}

export type OrcadTerminalDaemonHealth = {
  /** `live` requires the daemon to have answered; absence is never inferred from silence. */
  state: 'live' | 'degraded' | 'absent'
  /** True only when FRESH terminals are daemon-owned, i.e. survive an orcad restart. */
  ownsFreshSessions: boolean
  pid: number | null
  /** The build the LIVE daemon was forked from, which may predate this orcad after an update. */
  buildVersion: string | null
  entryPath: string | null
  protocolVersion: number | null
  /** The systemd scope unit the daemon self-detected landing in (see daemon-cgroup-scope.ts),
   *  or null when it ran unscoped — the case a combined-unit `systemctl restart` still reaps. */
  cgroupUnit: string | null
  selfTest: OrcadPtySelfTest
}

export type OrcadHealthReport = {
  /** Content hash of the running orcad bundle — the deployed build's identity. */
  buildHash: string
  buildVersion: string
  nodeVersion: string
  /** `process.versions.modules`: the ABI every native addon on this host must match. */
  nodeAbi: string
  platform: NodeJS.Platform
  arch: string
  pid: number
  terminalDaemon: OrcadTerminalDaemonHealth
  /** The low-cardinality profile-state authority selected during startup, when available. */
  profileStateAuthority?: OrcadProfileStateAuthorityReport
  /** Optional for older readers: absence means "not reported", never "none". See orcad-degradations.ts. */
  degradations?: OrcadDegradation[]
  /** Self-watchdog snapshot; absent in the readiness payload, which precedes the first probe. */
  watchdog?: OrcadWatchdogSnapshot
}

export type OrcadDegradationSeverity = 'critical' | 'warning'

export type OrcadDegradationComponent = 'terminal-daemon' | 'runtime' | 'terminal' | 'browser'

export type OrcadDegradation = {
  /** Open vocabulary: new codes ship without a schema bump, so render `message`. */
  code: string
  severity: OrcadDegradationSeverity
  component: OrcadDegradationComponent
  message: string
  /** The underlying reason word when one exists (daemon verdict, runtime reason). */
  reason?: string
}

export type OrcadWatchdogProbeState = 'pending' | 'ok' | 'failing'

export type OrcadWatchdogProbeSnapshot = {
  state: OrcadWatchdogProbeState
  consecutiveFailures: number
  lastOkAt: number | null
  lastDurationMs: number | null
  lastError: string | null
}

/** `wedged` means a probe failed repeatedly: liveness fails and systemd pings stop. */
export type OrcadWatchdogVerdict = 'responsive' | 'lagging' | 'wedged'

export type OrcadWatchdogSnapshot = {
  verdict: OrcadWatchdogVerdict
  eventLoop: { lagMs: number; maxLagMs: number; windowMs: number; warnMs: number }
  runtimeProbe: OrcadWatchdogProbeSnapshot
  threadpoolProbe: OrcadWatchdogProbeSnapshot
  /** Consecutive failures, after at least one success, that make the host `wedged`. */
  wedgeAfterFailures: number
}

export type OrcadServerStats = {
  startedAt: string
  uptimeSeconds: number
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number }
  cpu: { userMs: number; systemMs: number }
  /** Open authenticated WebSocket connections (direct and relay). */
  connectedClients: number | null
  /** Paired devices that have connected at least once. */
  pairedDevices: number | null
  /** Live local terminals; null when the listing could not be verified, never guessed as 0. */
  localTerminals: number | null
}

export type OrcadReadinessState = 'starting' | 'ready' | 'not_ready'

export type OrcadServerHealth = {
  state: OrcadReadinessState
  live: boolean
  /** The WebSocket listener orcad actually bound, e.g. `ws://127.0.0.1:6768`. */
  boundEndpoint: string | null
  /** When the daemon self-test in `health` last ran. */
  checkedAt: string
  health: OrcadHealthReport
  stats: OrcadServerStats
}

export type OrcadPairingOfferReport =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      /** One browser link per alternate endpoint; absent from older orcad. */
      webClientAlternateUrls?: string[]
      scope: 'runtime' | 'mobile'
      qr: string | null
      /** Epoch ms after which the unclaimed offer stops authenticating; absent from older orcad. */
      expiresAt?: number | null
    }
  | { available: false; reason: string; guidance: string }
