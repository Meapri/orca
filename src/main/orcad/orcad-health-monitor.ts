/**
 * Continuous health: the readiness payload's `collectOrcadHealth()` re-run on an interval and
 * combined with the live watchdog, so probes and `server.health` read the same verdict.
 *
 * Why cache the daemon half: its self-test spawns a real PTY inside the daemon. Paying that on
 * every supervisor probe would make the probe the load; once a minute keeps it honest.
 */
import process from 'node:process'
import type { RuntimeDegradation } from '../../shared/runtime-types'
import type { OrcadHealth } from './orcad-health'
import {
  deriveOrcadDegradations,
  hasCriticalDegradation,
  type OrcadDegradation
} from './orcad-degradations'
import type { OrcadRuntimeWatchdog } from './orcad-runtime-watchdog'
import type {
  OrcadReadinessState,
  OrcadServerHealth,
  OrcadServerStats,
  OrcadWatchdogSnapshot
} from '../../shared/orcad-server-health-contract'

export type {
  OrcadReadinessState,
  OrcadServerHealth,
  OrcadServerStats
} from '../../shared/orcad-server-health-contract'

const DAEMON_HEALTH_REFRESH_MS = 60_000

export type OrcadHealthMonitorDeps = {
  collectBase: () => Promise<OrcadHealth>
  runtimeDegradations: () => readonly RuntimeDegradation[]
  collectStats: () => Promise<
    Omit<OrcadServerStats, 'startedAt' | 'uptimeSeconds' | 'memory' | 'cpu'>
  >
  watchdog: Pick<OrcadRuntimeWatchdog, 'snapshot'> | null
  boundEndpoint?: () => string | null
  platform?: NodeJS.Platform
  underSystemdService?: boolean
  refreshIntervalMs?: number
  now?: () => number
}

export class OrcadHealthMonitor {
  private base: OrcadHealth | null = null
  private checkedAt = 0
  private refreshing: Promise<OrcadHealth> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly startedAt: number
  private readonly now: () => number

  constructor(private readonly deps: OrcadHealthMonitorDeps) {
    this.now = deps.now ?? Date.now
    this.startedAt = this.now() - Math.round(process.uptime() * 1000)
  }

  /** The readiness payload's health: same collection, with degradations attached. */
  async collectInitial(): Promise<OrcadHealth> {
    return this.withDegradations(await this.refresh(), null)
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, this.deps.refreshIntervalMs ?? DAEMON_HEALTH_REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isStarted(): boolean {
    return this.timer !== null
  }

  refresh(): Promise<OrcadHealth> {
    // Why single-flight: concurrent `--fresh` calls must not spawn parallel daemon self-tests.
    this.refreshing ??= this.deps
      .collectBase()
      .then((base) => {
        this.base = base
        this.checkedAt = this.now()
        return base
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  degradations(): OrcadDegradation[] {
    return this.base ? this.derive(this.base, this.deps.watchdog?.snapshot() ?? null) : []
  }

  liveness(): { live: boolean } {
    return { live: this.deps.watchdog?.snapshot().verdict !== 'wedged' }
  }

  readiness(): { state: OrcadReadinessState; degradations: OrcadDegradation[] } {
    if (!this.base || !this.isStarted()) {
      return { state: 'starting', degradations: [] }
    }
    const degradations = this.degradations()
    return { state: hasCriticalDegradation(degradations) ? 'not_ready' : 'ready', degradations }
  }

  async serverHealth(options: { fresh: boolean }): Promise<OrcadServerHealth> {
    const base = options.fresh || !this.base ? await this.refresh() : this.base
    const watchdog = this.deps.watchdog?.snapshot() ?? null
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    return {
      state: this.readiness().state,
      live: this.liveness().live,
      boundEndpoint: this.deps.boundEndpoint?.() ?? null,
      checkedAt: new Date(this.checkedAt).toISOString(),
      health: this.withDegradations(base, watchdog),
      stats: {
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal
        },
        cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000) },
        ...(await this.deps.collectStats())
      }
    }
  }

  private withDegradations(base: OrcadHealth, watchdog: OrcadWatchdogSnapshot | null): OrcadHealth {
    return {
      ...base,
      degradations: this.derive(base, watchdog),
      ...(watchdog ? { watchdog } : {})
    }
  }

  private derive(base: OrcadHealth, watchdog: OrcadWatchdogSnapshot | null): OrcadDegradation[] {
    return deriveOrcadDegradations({
      terminalDaemon: base.terminalDaemon,
      watchdog,
      runtimeDegradations: this.deps.runtimeDegradations(),
      platform: this.deps.platform ?? process.platform,
      underSystemdService: this.deps.underSystemdService ?? false
    })
  }
}
