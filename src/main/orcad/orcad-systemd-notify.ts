/**
 * systemd `sd_notify` for orcad: READY=1 after the readiness line, WATCHDOG=1 while the runtime
 * answers, STOPPING=1 on shutdown.
 *
 * Why the `systemd-notify` binary: the notify socket is an AF_UNIX datagram socket, which
 * Node's `dgram` cannot open, and a native addon for one syscall is not worth a new ABI to
 * ship. The binary sends from its own PID, so the unit needs `NotifyAccess=all` — see
 * docs/reference/orcad-operations.md. The stdout readiness line stays the primary contract.
 */
import process from 'node:process'
import { runProcess } from '../../shared/child-process/run-process'

const NOTIFY_TIMEOUT_MS = 5_000

export type SystemdNotifyEnvironment = {
  notifySocket: string
  /** Ping cadence (half of WATCHDOG_USEC), or null when this process is not the watched one. */
  watchdogPingMs: number | null
}

/**
 * Reads and removes the notify variables, like `sd_notify(unset_environment=1)`.
 *
 * Why remove: the terminal daemon and every PTY inherit orcad's env. A shell that inherits
 * NOTIFY_SOCKET — or a nested orcad started in one — could ping or ready this service.
 */
export function takeSystemdNotifyEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  acceptedWatchdogPids: readonly number[]
): SystemdNotifyEnvironment | null {
  const notifySocket = env.NOTIFY_SOCKET
  const watchdogUsec = Number(env.WATCHDOG_USEC)
  const watchdogPid = env.WATCHDOG_PID === undefined ? null : Number(env.WATCHDOG_PID)
  delete env.NOTIFY_SOCKET
  delete env.WATCHDOG_USEC
  delete env.WATCHDOG_PID
  if (platform !== 'linux' || !notifySocket) {
    return null
  }
  const watchedHere = watchdogPid === null || acceptedWatchdogPids.includes(watchdogPid)
  return {
    notifySocket,
    watchdogPingMs:
      Number.isFinite(watchdogUsec) && watchdogUsec > 0 && watchedHere
        ? Math.max(500, Math.floor(watchdogUsec / 2_000))
        : null
  }
}

export type SystemdNotifySend = (assignments: readonly string[]) => Promise<boolean>

export function createSystemdNotifySend(notifySocket: string): SystemdNotifySend {
  return async (assignments) => {
    try {
      const result = await runProcess({
        program: 'systemd-notify',
        args: [...assignments],
        env: { ...process.env, NOTIFY_SOCKET: notifySocket },
        timeoutMs: NOTIFY_TIMEOUT_MS,
        maxOutputBytes: 16 * 1024
      })
      return result.code === 0 && !result.timedOut
    } catch {
      return false
    }
  }
}

/** One-line STATUS= text; newlines would end the assignment. */
function sanitizeStatus(status: string): string {
  return status.replace(/[\r\n]+/g, ' ').slice(0, 200)
}

export class OrcadSystemdNotifier {
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private withholding = false
  private lastStatus: string | null = null
  private warnedSendFailure = false

  constructor(
    private readonly options: {
      send: SystemdNotifySend
      watchdogPingMs: number | null
      isLive: () => boolean
      describeStatus: () => string
      log?: (message: string) => void
    }
  ) {}

  async ready(): Promise<void> {
    await this.send(['READY=1', this.statusAssignment(true)], false)
    this.startWatchdog()
  }

  async stopping(): Promise<void> {
    this.stopWatchdog()
    await this.send(['STOPPING=1'], false)
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /** Exposed for tests; production ticks from the interval. */
  async pingWatchdog(): Promise<void> {
    if (!this.options.isLive()) {
      if (!this.withholding) {
        this.withholding = true
        this.log('withholding the systemd watchdog ping: the runtime self-probe reports a wedge')
      }
      await this.send([this.statusAssignment(false)].filter(Boolean), true)
      return
    }
    this.withholding = false
    await this.send(['WATCHDOG=1', this.statusAssignment(false)].filter(Boolean), true)
  }

  private startWatchdog(): void {
    const pingMs = this.options.watchdogPingMs
    if (pingMs === null || this.watchdogTimer) {
      return
    }
    this.watchdogTimer = setInterval(() => void this.pingWatchdog(), pingMs)
    this.watchdogTimer.unref?.()
  }

  /** Returns '' when unchanged so STATUS= is sent only on transitions. */
  private statusAssignment(force: boolean): string {
    const status = sanitizeStatus(this.options.describeStatus())
    if (!force && status === this.lastStatus) {
      return ''
    }
    this.lastStatus = status
    return `STATUS=${status}`
  }

  private async send(assignments: string[], droppable: boolean): Promise<void> {
    if (assignments.length === 0) {
      return
    }
    if (this.inFlight) {
      // Why drop pings rather than queue: overlapping pings mean systemd-notify itself is stalling.
      if (droppable) {
        return
      }
      await this.inFlight
    }
    const attempt = this.options.send(assignments).then((sent) => {
      if (!sent && !this.warnedSendFailure) {
        this.warnedSendFailure = true
        this.log(
          'systemd-notify failed; check that it is installed and the unit sets NotifyAccess=all'
        )
      }
    })
    this.inFlight = attempt
    try {
      await attempt
    } finally {
      if (this.inFlight === attempt) {
        this.inFlight = null
      }
    }
  }

  private log(message: string): void {
    ;(this.options.log ?? ((line: string) => console.error(line)))(`[orcad] ${message}`)
  }
}
