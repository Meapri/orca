import type { RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'

/** Routes one browser command by name; every orcad provider forwards commands this way. */
export type BrowserCommandInvoker = (method: string, args: unknown[]) => Promise<unknown>

/** A `RuntimeBrowserCommands` whose every method forwards to `invoke`. */
export function createBrowserCommandDispatchProxy(
  invoke: BrowserCommandInvoker
): RuntimeBrowserCommands {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every string property resolves to an async dispatcher, which is all the runtime ever reads from RuntimeBrowserCommands.
  return new Proxy({} as RuntimeBrowserCommands, {
    get: (_target, property) => {
      // Why: an awaited proxy must not look like a thenable.
      if (property === 'then' || typeof property !== 'string') {
        return undefined
      }
      return (...args: unknown[]) => invoke(property, args)
    },
    // Why: the startup proxy refuses names a provider does not answer to with an `in` check.
    has: (_target, property) => typeof property === 'string' && property !== 'then'
  })
}
