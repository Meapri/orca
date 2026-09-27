import {
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import { OrcadDeferredBrowserProvider } from './orcad-deferred-browser-provider'
import type { OrcadBrowserMode } from './orcad-browser-mode'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { ORCAD_BUNDLED_LAUNCHER_ENV } from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[ORCAD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[ORCAD_BUNDLED_LAUNCHER_ENV]

/** True when a bundled launcher forked this runtime, making the launcher systemd's main PID. */
export function isOrcadBundledLauncherChild(): boolean {
  return bundledLauncherChannel
}

function createIdempotentOrcadCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

/** A launcher and its child can both receive the same process-group or service stop signal. */
export function installOrcadShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = ORCAD_SHUTDOWN_DEADLINE_MS
): void {
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) {
      return
    }
    stopping = true
    setTimeout(() => {
      console.error(`orcad: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(resolveOrcadExitCode(error))
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Headless runtimes survive terminal hangups; INT/TERM are the graceful stop contract.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
}

export async function startOrcadWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  let cleanupRuntime = async (): Promise<void> => {}
  const cleanup = createIdempotentOrcadCleanup(async () => {
    let runtimeCleanupSucceeded = false
    try {
      await cleanupRuntime()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => {
      cleanupRuntime = nextCleanup
    })
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Keep the launch failure as the supervisor-facing verdict; cleanup still needs a breadcrumb.
      console.error('[orcad] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Installs the deferred provider's factory now; nothing is launched until `startInBackground`. */
export function installOrcadBrowserProvider(
  userDataPath: string,
  mode: OrcadBrowserMode
): OrcadDeferredBrowserProvider | null {
  if (mode === 'none') {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'disabled' })
    return null
  }
  const provider = new OrcadDeferredBrowserProvider({
    resolve: (signal) => resolveOrcadBrowserProvider({ userDataPath, mode, signal })
  })
  setRuntimeBrowserCommandsFactory(provider.factory, {
    headless: true,
    isAvailable: () => provider.isAvailable(),
    unavailableCause: () => provider.unavailableCause()
  })
  return provider
}

/** Keep profile admission until every runtime writer has stopped. */
export async function startOrcadWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  runQuitHandlers: () => void,
  browserMode: OrcadBrowserMode = 'auto'
): Promise<T & { stop(): Promise<void> }> {
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: OrcadDeferredBrowserProvider | null = null
  return startOrcadWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      browserProvider = installOrcadBrowserProvider(userDataPath, browserMode)
      const handle = await start(registerCleanup)
      // Why after start: readiness is already published, so a slow sidecar never delays it.
      browserProvider?.startInBackground()
      return handle
    },
    async (runtimeCleanupSucceeded) => {
      try {
        await browserProvider?.stop()
      } finally {
        setRuntimeBrowserCommandsFactory(null)
        runQuitHandlers()
        try {
          // Failed teardown excludes recovery until the process actually exits.
          if (runtimeCleanupSucceeded) {
            admission?.release()
          }
        } finally {
          instanceLock.release()
        }
      }
    }
  )
}

export async function flushOrcadProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(options?: { exportJsonCompatibility?: boolean }): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })
  } finally {
    await store.freezeWritesAsync()
  }
}
