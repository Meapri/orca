import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadRuntimeWatchdog } from './orcad-runtime-watchdog'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function createWatchdog(overrides: {
  probeRuntime?: () => Promise<void>
  probeThreadpool?: () => Promise<void>
  now?: () => number
}) {
  return new OrcadRuntimeWatchdog({
    probeRuntime: overrides.probeRuntime ?? (async () => {}),
    probeThreadpool: overrides.probeThreadpool ?? (async () => {}),
    sampleIntervalMs: 100,
    probeIntervalMs: 1_000,
    probeTimeoutMs: 500,
    lagWarnMs: 1_000,
    lagWindowMs: 10_000,
    wedgeAfterFailures: 3,
    ...(overrides.now ? { now: overrides.now } : {})
  })
}

describe('OrcadRuntimeWatchdog', () => {
  it('stays responsive while both probes answer', async () => {
    const watchdog = createWatchdog({})
    watchdog.start()
    await vi.advanceTimersByTimeAsync(5_000)

    const snapshot = watchdog.snapshot()
    expect(snapshot.verdict).toBe('responsive')
    expect(snapshot.runtimeProbe.state).toBe('ok')
    expect(snapshot.threadpoolProbe.consecutiveFailures).toBe(0)
    expect(watchdog.isLive()).toBe(true)
    watchdog.stop()
  })

  it('reports wedged after repeated runtime probe failures and recovers on the next success', async () => {
    let failing = false
    const watchdog = createWatchdog({
      probeRuntime: async () => {
        if (failing) {
          throw new Error('runtime self-probe timeout')
        }
      }
    })
    watchdog.start()
    await vi.advanceTimersByTimeAsync(0)
    failing = true
    await vi.advanceTimersByTimeAsync(2_000)
    expect(watchdog.snapshot().verdict).toBe('responsive')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchdog.snapshot().verdict).toBe('wedged')
    expect(watchdog.snapshot().runtimeProbe.lastError).toBe('runtime self-probe timeout')
    expect(watchdog.isLive()).toBe(false)

    failing = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchdog.snapshot().verdict).toBe('responsive')
    watchdog.stop()
  })

  it('never reports wedged for a probe that has not succeeded once', async () => {
    const watchdog = createWatchdog({
      probeRuntime: async () => {
        throw new Error('connect_failed')
      }
    })
    watchdog.start()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(watchdog.snapshot().runtimeProbe.consecutiveFailures).toBeGreaterThanOrEqual(3)
    expect(watchdog.snapshot().verdict).toBe('responsive')
    expect(watchdog.isLive()).toBe(true)
    watchdog.stop()
  })

  it('counts a probe that never settles as a failure on every tick', async () => {
    let hang = false
    const watchdog = createWatchdog({
      probeThreadpool: () => (hang ? new Promise<void>(() => {}) : Promise.resolve())
    })
    watchdog.start()
    await vi.advanceTimersByTimeAsync(0)
    hang = true
    await vi.advanceTimersByTimeAsync(3_100)

    const snapshot = watchdog.snapshot()
    expect(snapshot.threadpoolProbe.consecutiveFailures).toBeGreaterThanOrEqual(3)
    expect(snapshot.verdict).toBe('wedged')
    watchdog.stop()
  })

  it('reports lagging when timer drift exceeds the warning threshold', async () => {
    let clock = 0
    const watchdog = createWatchdog({ now: () => clock })
    watchdog.start()
    clock += 100
    await vi.advanceTimersByTimeAsync(100)
    // A 2.5s synchronous stall: the next tick lands late by the stall length.
    clock += 2_600
    await vi.advanceTimersByTimeAsync(100)

    const snapshot = watchdog.snapshot()
    expect(snapshot.eventLoop.maxLagMs).toBe(2_500)
    expect(snapshot.verdict).toBe('lagging')
    expect(watchdog.isLive()).toBe(true)
    watchdog.stop()
  })

  it('forgets lag that falls outside the window', async () => {
    let clock = 0
    const watchdog = createWatchdog({ now: () => clock })
    watchdog.start()
    clock += 2_600
    await vi.advanceTimersByTimeAsync(100)
    expect(watchdog.snapshot().verdict).toBe('lagging')

    clock += 20_000
    expect(watchdog.snapshot().eventLoop.maxLagMs).toBe(0)
    expect(watchdog.snapshot().verdict).toBe('responsive')
    watchdog.stop()
  })
})
