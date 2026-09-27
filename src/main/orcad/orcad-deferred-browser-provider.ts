/**
 * orcad's browser provider, started after readiness instead of before it.
 *
 * Why deferred: resolving the Electron sidecar can wait up to 120 s, and readiness is what a
 * supervisor and a deploy transaction gate on. Terminals and RPC do not need a browser, so the
 * host publishes readiness first; the provider starts in the background and a browser command
 * that arrives earlier joins that same start rather than failing.
 */
import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import {
  recordedRuntimeBrowserUnavailableCause,
  setRuntimeBrowserUnavailableCause,
  type RuntimeBrowserCommandsFactory,
  type RuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage
} from '../../shared/runtime-types'
import { BrowserProviderRestartBudget } from './browser-provider-restart-budget'
import { createBrowserCommandDispatchProxy } from './browser-command-dispatch-proxy'
import type { OrcadBrowserProvider } from './orcad-browser-provider'

export type OrcadDeferredBrowserProviderState = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

export type OrcadDeferredBrowserProviderOptions = {
  resolve: (signal: AbortSignal) => Promise<OrcadBrowserProvider | null>
  /** Spaces retries after a failed start; a command after the gap tries again. */
  restartBudget?: BrowserProviderRestartBudget
}

export class OrcadDeferredBrowserProvider {
  private state: OrcadDeferredBrowserProviderState = 'idle'
  private provider: OrcadBrowserProvider | null = null
  private pendingStart: Promise<OrcadBrowserProvider | null> | null = null
  private readonly abort = new AbortController()
  private readonly restartBudget: BrowserProviderRestartBudget

  constructor(private readonly options: OrcadDeferredBrowserProviderOptions) {
    this.restartBudget = options.restartBudget ?? new BrowserProviderRestartBudget()
  }

  readonly factory: RuntimeBrowserCommandsFactory = (host) =>
    createBrowserCommandDispatchProxy((method, args) => this.invoke(host, method, args))

  currentState(): OrcadDeferredBrowserProviderState {
    return this.state
  }

  startInBackground(): void {
    void this.ensureStarted()
  }

  /** Single-flight: every caller during a start shares it. Never rejects. */
  ensureStarted(): Promise<OrcadBrowserProvider | null> {
    if (this.provider) {
      return Promise.resolve(this.provider)
    }
    if (this.pendingStart) {
      return this.pendingStart
    }
    if (this.state === 'stopped' || !this.restartBudget.tryBeginRestart()) {
      return Promise.resolve(null)
    }
    this.state = 'starting'
    const start = this.options
      .resolve(this.abort.signal)
      .catch((error: unknown) => {
        console.warn('[orcad] Browser provider failed to start:', error)
        setRuntimeBrowserUnavailableCause({
          reason: 'unknown',
          detail: error instanceof Error ? error.message : String(error)
        })
        return null
      })
      .then(async (provider) => {
        this.pendingStart = null
        if (this.state === 'stopped') {
          await provider?.stop()
          return null
        }
        this.provider = provider
        this.state = provider ? 'ready' : 'failed'
        return provider
      })
    this.pendingStart = start
    return start
  }

  isAvailable(): boolean {
    return this.provider?.isAvailable() ?? false
  }

  /** Null once started: a started provider that stops answering is provider_unhealthy. */
  unavailableCause(): RuntimeBrowserUnavailableCause | null {
    if (this.state === 'idle' || this.state === 'starting') {
      return { reason: 'starting' }
    }
    if (this.state === 'failed') {
      return recordedRuntimeBrowserUnavailableCause() ?? { reason: 'unknown' }
    }
    return null
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.abort.abort()
    const pendingStart = this.pendingStart
    const provider = this.provider
    this.provider = null
    await provider?.stop()
    // Why awaited: the start's own continuation stops a provider that resolves after this.
    await pendingStart
  }

  private async invoke(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const provider = await this.ensureStarted()
    if (!provider) {
      const cause = this.unavailableCause() ?? { reason: 'unknown' }
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        browserUnavailableMessage(cause.reason, cause.detail)
      )
    }
    return provider.invoke(host, method, args)
  }
}
