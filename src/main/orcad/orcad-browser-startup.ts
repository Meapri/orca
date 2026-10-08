import { BrowserError } from '../browser/browser-error'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage
} from '../../shared/runtime-types'
import type { RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import {
  recordedRuntimeBrowserUnavailableCause,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause,
  type RuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import {
  resolveOrcadBrowserProvider,
  type OrcadBrowserProvider,
  type OrcadBrowserProviderOptions
} from './orcad-browser-provider'
import type { OrcadBrowserMode } from './orcad-browser-mode'
import { BrowserProviderRestartBudget } from './browser-provider-restart-budget'

export type OrcadBrowserStartupOptions = Omit<OrcadBrowserProviderOptions, 'mode' | 'signal'> & {
  /** `--browser`; `none` installs no factory and reports `disabled`. */
  mode?: OrcadBrowserMode
  /** Spaces retries after a failed start; a command after the gap tries again. */
  restartBudget?: BrowserProviderRestartBudget
}

/**
 * Browser discovery must not hold core RPC readiness hostage to a desktop authorization UI.
 * A command that arrives while discovery runs joins it instead of failing; one that arrives
 * after a failed start retries within the restart budget.
 */
export function startOrcadBrowserProvider(options: OrcadBrowserStartupOptions): {
  ready: Promise<void>
  stop(): Promise<void>
} {
  const { mode = 'auto', restartBudget = new BrowserProviderRestartBudget(), ...rest } = options
  if (mode === 'none') {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'disabled' })
    return { ready: Promise.resolve(), stop: async () => {} }
  }
  const controller = new AbortController()
  let provider: OrcadBrowserProvider | null = null
  let pending: Promise<void> | null = null
  let startupError: unknown
  let stopping: Promise<void> | undefined

  const begin = (): Promise<void> | null => {
    if (pending) {
      return pending
    }
    if (controller.signal.aborted || !restartBudget.tryBeginRestart()) {
      return null
    }
    const attempt = Promise.resolve()
      .then(() => resolveOrcadBrowserProvider({ ...rest, mode, signal: controller.signal }))
      .then(
        (resolved) => {
          provider = resolved
        },
        (error: unknown) => {
          startupError = error
          if (!controller.signal.aborted) {
            setRuntimeBrowserUnavailableCause({
              reason: 'unknown',
              detail: error instanceof Error ? error.message : String(error)
            })
            console.warn('[orcad] Browser startup failed:', error)
          }
        }
      )
      .finally(() => {
        pending = null
      })
    pending = attempt
    return attempt
  }

  const unavailable = (): BrowserError => {
    const cause = unavailableCause() ?? { reason: 'unknown' }
    return new BrowserError(
      BROWSER_UNAVAILABLE_ERROR_CODE,
      browserUnavailableMessage(cause.reason, cause.detail)
    )
  }
  const unavailableCause = (): RuntimeBrowserUnavailableCause | null => {
    if (controller.signal.aborted) {
      return { reason: 'unknown' }
    }
    if (pending) {
      return { reason: 'starting' }
    }
    // Null once started: a started provider that stops answering is provider_unhealthy.
    return provider ? null : (recordedRuntimeBrowserUnavailableCause() ?? { reason: 'unknown' })
  }

  setRuntimeBrowserCommandsFactory(
    (host) => {
      let commands: RuntimeBrowserCommands | undefined
      const dispatch = (property: string, args: unknown[]): unknown => {
        if (controller.signal.aborted || !provider?.isAvailable()) {
          throw unavailable()
        }
        commands ??= provider.factory(host)
        return callBrowserCommand(commands, property, args)
      }
      // Every member resolves through the getter, so the target needs no members of its own.
      const target: RuntimeBrowserCommands = Object.create(null)
      return new Proxy(target, {
        get: (_target, property) => {
          if (property === 'then' || typeof property !== 'string') {
            return undefined
          }
          return (...args: unknown[]) => {
            if (!controller.signal.aborted && !provider) {
              const joined = begin()
              if (joined) {
                return joined.then(() => dispatch(property, args))
              }
            }
            return dispatch(property, args)
          }
        }
      })
    },
    {
      headless: true,
      isAvailable: () => !controller.signal.aborted && !!provider?.isAvailable(),
      unavailableCause
    }
  )
  const ready = begin() ?? Promise.resolve()
  return {
    ready,
    stop: () => {
      controller.abort()
      stopping ??= (async () => {
        // A retry may have replaced the first attempt; wait for whichever is in flight.
        await ready
        await pending
        await provider?.stop()
        // Unexpected resolver errors may include failed cleanup of a partially started provider.
        if (startupError) {
          throw startupError
        }
      })()
      return stopping
    }
  }
}

type BrowserCommandMember = (this: RuntimeBrowserCommands, ...args: unknown[]) => unknown

function isBrowserCommandMember(value: unknown): value is BrowserCommandMember {
  return typeof value === 'function'
}

/** The proxy forwards by name; anything that is not a command method is refused, not invoked. */
function callBrowserCommand(
  commands: RuntimeBrowserCommands,
  name: string,
  args: unknown[]
): unknown {
  const member: unknown = name in commands ? commands[name] : undefined
  if (!isBrowserCommandMember(member)) {
    throw new BrowserError(BROWSER_UNAVAILABLE_ERROR_CODE, `Unknown browser command: ${name}`)
  }
  return member.call(commands, ...args)
}
