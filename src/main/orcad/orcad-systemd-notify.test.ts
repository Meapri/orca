import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcadSystemdNotifier, takeSystemdNotifyEnvironment } from './orcad-systemd-notify'

afterEach(() => {
  vi.useRealTimers()
})

describe('takeSystemdNotifyEnvironment', () => {
  it('reads the notify socket and halves WATCHDOG_USEC, then scrubs all three variables', () => {
    const env: NodeJS.ProcessEnv = {
      NOTIFY_SOCKET: '/run/systemd/notify',
      WATCHDOG_USEC: '30000000',
      WATCHDOG_PID: '100',
      KEEP: '1'
    }

    expect(takeSystemdNotifyEnvironment(env, 'linux', [100])).toEqual({
      notifySocket: '/run/systemd/notify',
      watchdogPingMs: 15_000
    })
    expect(env).toEqual({ KEEP: '1' })
  })

  it('accepts the bundled launcher as the watched PID but not an unrelated one', () => {
    const watched = { NOTIFY_SOCKET: '/n', WATCHDOG_USEC: '10000000', WATCHDOG_PID: '7' }
    expect(takeSystemdNotifyEnvironment({ ...watched }, 'linux', [8, 7])?.watchdogPingMs).toBe(
      5_000
    )
    expect(takeSystemdNotifyEnvironment({ ...watched }, 'linux', [8])).toEqual({
      notifySocket: '/n',
      watchdogPingMs: null
    })
  })

  it('returns null off Linux or without a socket, still scrubbing the variables', () => {
    const env: NodeJS.ProcessEnv = { NOTIFY_SOCKET: '/n', WATCHDOG_USEC: '1000000' }
    expect(takeSystemdNotifyEnvironment(env, 'darwin', [1])).toBeNull()
    expect(env).toEqual({})
    expect(takeSystemdNotifyEnvironment({ WATCHDOG_USEC: '1000000' }, 'linux', [1])).toBeNull()
  })
})

describe('OrcadSystemdNotifier', () => {
  function createNotifier(live: { value: boolean }, status = 'ready') {
    const send = vi.fn(async (_assignments: readonly string[]) => true)
    const log = vi.fn()
    const notifier = new OrcadSystemdNotifier({
      send,
      watchdogPingMs: 1_000,
      isLive: () => live.value,
      describeStatus: () => status,
      log
    })
    return { notifier, send, log }
  }

  it('sends READY=1 with a status and pings the watchdog while the runtime is live', async () => {
    vi.useFakeTimers()
    const live = { value: true }
    const { notifier, send } = createNotifier(live)

    await notifier.ready()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(send.mock.calls[0]).toEqual([['READY=1', 'STATUS=ready']])
    expect(send.mock.calls[1]).toEqual([['WATCHDOG=1']])
    notifier.stopWatchdog()
  })

  it('withholds WATCHDOG=1 while wedged so systemd restarts the unit', async () => {
    const live = { value: false }
    const { notifier, send, log } = createNotifier(live)

    await notifier.pingWatchdog()
    await notifier.pingWatchdog()

    expect(send.mock.calls.flat(2)).not.toContain('WATCHDOG=1')
    expect(log).toHaveBeenCalledOnce()
    live.value = true
    await notifier.pingWatchdog()
    expect(send.mock.calls.at(-1)?.[0]).toContain('WATCHDOG=1')
  })

  it('sends STOPPING=1 and stops pinging on shutdown', async () => {
    vi.useFakeTimers()
    const { notifier, send } = createNotifier({ value: true })
    await notifier.ready()
    await notifier.stopping()
    send.mockClear()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(send).not.toHaveBeenCalled()
  })

  it('logs a failed systemd-notify once instead of on every ping', async () => {
    const send = vi.fn(async (_assignments: readonly string[]) => false)
    const log = vi.fn()
    const notifier = new OrcadSystemdNotifier({
      send,
      watchdogPingMs: null,
      isLive: () => true,
      describeStatus: () => 'ready',
      log
    })

    await notifier.ready()
    await notifier.pingWatchdog()

    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toContain('NotifyAccess=all')
  })
})
