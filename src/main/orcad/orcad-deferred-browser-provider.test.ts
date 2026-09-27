import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import { BrowserProviderRestartBudget } from './browser-provider-restart-budget'
import type { OrcadBrowserProvider } from './orcad-browser-provider'
import { OrcadDeferredBrowserProvider } from './orcad-deferred-browser-provider'
import { installOrcadBrowserProvider } from './orcad-lifecycle'
import { parseOrcadBrowserMode, resolveOrcadBrowserMode } from './orcad-browser-mode'

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: resolveMock }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deferred provider only forwards the host, never reads it.
const host = {} as RuntimeBrowserCommandHost

function fakeProvider(overrides: Partial<OrcadBrowserProvider> = {}): OrcadBrowserProvider {
  return {
    kind: 'electron',
    factory: () => {
      throw new Error('the deferred provider dispatches through invoke')
    },
    invoke: vi.fn(async (_host, method) => ({ ok: method })),
    isAvailable: () => true,
    stop: vi.fn(async () => undefined),
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

afterEach(() => {
  resolveMock.mockReset()
  setRuntimeBrowserCommandsFactory(null)
  setRuntimeBrowserUnavailableCause(null)
})

describe('OrcadDeferredBrowserProvider', () => {
  it('reports starting until the provider resolves, then advertises headless browsing', async () => {
    const pending = deferred<OrcadBrowserProvider | null>()
    resolveMock.mockReturnValue(pending.promise)

    const provider = installOrcadBrowserProvider('/tmp/orcad-data', 'auto')
    expect(resolveMock).not.toHaveBeenCalled()
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'starting' })

    provider!.startInBackground()
    expect(resolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ userDataPath: '/tmp/orcad-data', mode: 'auto' })
    )
    expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(false)

    pending.resolve(fakeProvider())
    await provider!.ensureStarted()
    expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(true)
  })

  it('makes a command that arrives mid-start wait for that same start', async () => {
    const pending = deferred<OrcadBrowserProvider | null>()
    const resolve = vi.fn(() => pending.promise)
    const provider = new OrcadDeferredBrowserProvider({ resolve })
    provider.startInBackground()

    const commands = provider.factory(host)
    const result = commands.browserTabList({})
    const inner = fakeProvider()
    pending.resolve(inner)

    await expect(result).resolves.toEqual({ ok: 'browserTabList' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(inner.invoke).toHaveBeenCalledWith(host, 'browserTabList', [{}])
  })

  it('starts on first use when nothing started it in the background', async () => {
    const resolve = vi.fn(async () => fakeProvider())
    const provider = new OrcadDeferredBrowserProvider({ resolve })

    await expect(provider.factory(host).browserTabList({})).resolves.toEqual({
      ok: 'browserTabList'
    })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('rejects commands with the recorded cause after a failed start, and spaces retries', async () => {
    let now = 0
    const resolve = vi.fn(async () => {
      setRuntimeBrowserUnavailableCause({ reason: 'electron_start_failed', detail: 'hung' })
      return null
    })
    const provider = new OrcadDeferredBrowserProvider({
      resolve,
      restartBudget: new BrowserProviderRestartBudget(() => now)
    })
    setRuntimeBrowserCommandsFactory(provider.factory, {
      headless: true,
      isAvailable: () => provider.isAvailable(),
      unavailableCause: () => provider.unavailableCause()
    })

    await expect(provider.factory(host).browserTabList({})).rejects.toMatchObject({
      code: 'browser_unavailable',
      message: expect.stringContaining('hung')
    })
    expect(runtimeBrowserUnavailableCause()).toEqual({
      reason: 'electron_start_failed',
      detail: 'hung'
    })
    await expect(provider.factory(host).browserTabList({})).rejects.toThrow()
    expect(resolve).toHaveBeenCalledTimes(1)

    now += 6_000
    await expect(provider.factory(host).browserTabList({})).rejects.toThrow()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight start on stop and stops a provider that resolves late', async () => {
    const pending = deferred<OrcadBrowserProvider | null>()
    let startSignal: AbortSignal | null = null
    const provider = new OrcadDeferredBrowserProvider({
      resolve: (signal) => {
        startSignal = signal
        return pending.promise
      }
    })
    provider.startInBackground()

    const stopped = provider.stop()
    expect(startSignal!.aborted).toBe(true)
    const late = fakeProvider()
    pending.resolve(late)
    await stopped

    expect(late.stop).toHaveBeenCalledTimes(1)
    expect(provider.currentState()).toBe('stopped')
    expect(provider.isAvailable()).toBe(false)
  })

  it('installs nothing and reports disabled for --browser none', () => {
    expect(installOrcadBrowserProvider('/tmp/orcad-data', 'none')).toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'disabled' })
    expect(resolveMock).not.toHaveBeenCalled()
  })
})

describe('orcad browser mode', () => {
  it('prefers the flag, then ORCA_BROWSER_PROVIDER, then auto', () => {
    expect(resolveOrcadBrowserMode('none', { ORCA_BROWSER_PROVIDER: 'electron' })).toBe('none')
    expect(resolveOrcadBrowserMode(undefined, { ORCA_BROWSER_PROVIDER: ' Chromium ' })).toBe(
      'chromium'
    )
    expect(resolveOrcadBrowserMode(undefined, { ORCA_BROWSER_PROVIDER: '' })).toBe('auto')
    expect(resolveOrcadBrowserMode(undefined, {})).toBe('auto')
  })

  it('refuses an unknown mode instead of guessing', () => {
    expect(() => parseOrcadBrowserMode('webkit', '--browser')).toThrow(
      "--browser expects one of none|auto|electron|chromium, got 'webkit'"
    )
    expect(() => resolveOrcadBrowserMode(undefined, { ORCA_BROWSER_PROVIDER: 'off' })).toThrow(
      'ORCA_BROWSER_PROVIDER expects'
    )
  })
})
