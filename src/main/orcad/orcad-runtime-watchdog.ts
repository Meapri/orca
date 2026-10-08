/**
 * Self-watchdog for "the listener is bound but the runtime stopped answering" (#23072).
 *
 * Three signals, because each wedge looks different from inside the process:
 * - event-loop lag: timer drift. A synchronous stall is only visible after it ends, which is
 *   why the systemd watchdog (an outside observer) exists at all — see orcad-systemd-notify.ts.
 * - runtime probe: a real request over the runtime's own local socket, so a dead accept loop or
 *   a dispatcher that never replies fails even while timers still fire.
 * - threadpool probe: a filesystem stat; a hung mount or saturated libuv pool stalls every async
 *   fs call while the event loop itself looks idle.
 */

import type {
  OrcadWatchdogProbeSnapshot,
  OrcadWatchdogSnapshot
} from '../../shared/orcad-server-health-contract'

export type {
  OrcadWatchdogProbeSnapshot,
  OrcadWatchdogProbeState,
  OrcadWatchdogSnapshot,
  OrcadWatchdogVerdict
} from '../../shared/orcad-server-health-contract'

export type OrcadWatchdogOptions = {
  probeRuntime: () => Promise<void>
  probeThreadpool: () => Promise<void>
  sampleIntervalMs?: number
  probeIntervalMs?: number
  probeTimeoutMs?: number
  lagWarnMs?: number
  lagWindowMs?: number
  wedgeAfterFailures?: number
  now?: () => number
}

type ProbeName = 'runtimeProbe' | 'threadpoolProbe'

function initialProbe(): OrcadWatchdogProbeSnapshot {
  return {
    state: 'pending',
    consecutiveFailures: 0,
    lastOkAt: null,
    lastDurationMs: null,
    lastError: null
  }
}

export class OrcadRuntimeWatchdog {
  private readonly sampleIntervalMs: number
  private readonly probeIntervalMs: number
  private readonly probeTimeoutMs: number
  private readonly lagWarnMs: number
  private readonly lagWindowMs: number
  private readonly wedgeAfterFailures: number
  private readonly now: () => number
  private readonly probes: Record<ProbeName, () => Promise<void>>
  private readonly state: Record<ProbeName, OrcadWatchdogProbeSnapshot> = {
    runtimeProbe: initialProbe(),
    threadpoolProbe: initialProbe()
  }
  private readonly inFlight = new Set<ProbeName>()
  private lagSamples: { at: number; lagMs: number }[] = []
  private lastTickAt: number | null = null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private probeTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: OrcadWatchdogOptions) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 500
    this.probeIntervalMs = options.probeIntervalMs ?? 10_000
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000
    this.lagWarnMs = options.lagWarnMs ?? 1_000
    this.lagWindowMs = options.lagWindowMs ?? 60_000
    this.wedgeAfterFailures = options.wedgeAfterFailures ?? 3
    this.now = options.now ?? Date.now
    this.probes = { runtimeProbe: options.probeRuntime, threadpoolProbe: options.probeThreadpool }
  }

  start(): void {
    if (this.sampleTimer) {
      return
    }
    this.lastTickAt = this.now()
    this.sampleTimer = setInterval(() => this.sampleLag(), this.sampleIntervalMs)
    this.probeTimer = setInterval(() => this.runProbes(), this.probeIntervalMs)
    // Why unref: the watchdog must never be the reason a stopping orcad stays alive.
    this.sampleTimer.unref?.()
    this.probeTimer.unref?.()
    this.runProbes()
  }

  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer)
    }
    if (this.probeTimer) {
      clearInterval(this.probeTimer)
    }
    this.sampleTimer = null
    this.probeTimer = null
  }

  isLive(): boolean {
    return this.snapshot().verdict !== 'wedged'
  }

  snapshot(): OrcadWatchdogSnapshot {
    const cutoff = this.now() - this.lagWindowMs
    this.lagSamples = this.lagSamples.filter((sample) => sample.at >= cutoff)
    const maxLagMs = this.lagSamples.reduce((max, sample) => Math.max(max, sample.lagMs), 0)
    const lagMs = this.lagSamples.at(-1)?.lagMs ?? 0
    // Why a prior success is required: a probe that never answered is a probe fault, and
    // withholding systemd pings on it would restart-loop a host that was never wedged.
    const wedged = (['runtimeProbe', 'threadpoolProbe'] as const).some(
      (name) =>
        this.state[name].consecutiveFailures >= this.wedgeAfterFailures &&
        this.state[name].lastOkAt !== null
    )
    return {
      verdict: wedged ? 'wedged' : maxLagMs >= this.lagWarnMs ? 'lagging' : 'responsive',
      eventLoop: { lagMs, maxLagMs, windowMs: this.lagWindowMs, warnMs: this.lagWarnMs },
      runtimeProbe: { ...this.state.runtimeProbe },
      threadpoolProbe: { ...this.state.threadpoolProbe },
      wedgeAfterFailures: this.wedgeAfterFailures
    }
  }

  private sampleLag(): void {
    const at = this.now()
    const expected = (this.lastTickAt ?? at) + this.sampleIntervalMs
    this.lastTickAt = at
    this.lagSamples.push({ at, lagMs: Math.max(0, at - expected) })
  }

  private runProbes(): void {
    for (const name of ['runtimeProbe', 'threadpoolProbe'] as const) {
      if (this.inFlight.has(name)) {
        // Why a failure: a probe still pending past its whole interval is the wedge itself.
        this.recordFailure(name, 'previous probe has not settled')
        continue
      }
      void this.runProbe(name)
    }
  }

  private runProbe(name: ProbeName): void {
    this.inFlight.add(name)
    const startedAt = this.now()
    let timedOut = false
    // Why not Promise.race: a probe that never settles must stay in flight so later ticks count it.
    const timer = setTimeout(() => {
      timedOut = true
      this.recordFailure(name, `probe exceeded ${this.probeTimeoutMs}ms`, startedAt)
    }, this.probeTimeoutMs)
    timer.unref?.()
    let probe: Promise<void>
    try {
      probe = this.probes[name]()
    } catch (error) {
      probe = Promise.reject(error)
    }
    probe
      .then(
        () => {
          if (!timedOut) {
            this.state[name] = {
              state: 'ok',
              consecutiveFailures: 0,
              lastOkAt: this.now(),
              lastDurationMs: this.now() - startedAt,
              lastError: null
            }
          }
        },
        (error: unknown) => {
          if (!timedOut) {
            this.recordFailure(
              name,
              error instanceof Error ? error.message : String(error),
              startedAt
            )
          }
        }
      )
      .finally(() => {
        clearTimeout(timer)
        this.inFlight.delete(name)
      })
  }

  private recordFailure(name: ProbeName, message: string, startedAt?: number): void {
    const previous = this.state[name]
    this.state[name] = {
      ...previous,
      state: 'failing',
      consecutiveFailures: previous.consecutiveFailures + 1,
      lastDurationMs: startedAt === undefined ? previous.lastDurationMs : this.now() - startedAt,
      lastError: message
    }
  }
}
