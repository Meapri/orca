import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import { resolveBrowserTabLimits, type BrowserTabLimits } from './browser-tab-limits'
import { BrowserTabReclaimer } from './browser-tab-reclaimer'
import { BrowserProviderRestartBudget } from './browser-provider-restart-budget'
import type {
  ElectronSidecarPage,
  ElectronSidecarTabRegistry
} from './electron-sidecar-tab-registry'

const MAINTENANCE_INTERVAL_MS = 60_000

export type ElectronSidecarGovernanceDeps = {
  tabs: ElectronSidecarTabRegistry
  /** Close one sidecar tab; the governance forgets it afterwards either way. */
  closePage: (page: ElectronSidecarPage) => Promise<void>
  isAlive: () => boolean
  /** Stop whatever is left of the sidecar and start a fresh one. */
  relaunch: () => Promise<void>
  limits?: BrowserTabLimits
  now?: () => number
  maintenanceIntervalMs?: number
}

/**
 * Tab cap, idle reclamation and crash relaunch for the installed-Electron sidecar provider.
 *
 * The sidecar is its own Electron process tree, so its renderers dying never reaches orcad; but
 * a dead sidecar stayed dead (every browser RPC failed until orcad restarted) and its tabs, one
 * renderer each, were never reclaimed on a headless host (#14552).
 */
export class ElectronSidecarGovernance {
  readonly reclaimer: BrowserTabReclaimer<ElectronSidecarPage>
  private readonly restartBudget: BrowserProviderRestartBudget
  private timer: ReturnType<typeof setInterval> | null = null
  private maintaining: Promise<void> | null = null

  constructor(private readonly deps: ElectronSidecarGovernanceDeps) {
    const now = deps.now ?? Date.now
    this.reclaimer = new BrowserTabReclaimer(
      () => deps.tabs.listPages(),
      async (page) => {
        await deps.closePage(page)
        deps.tabs.delete(page)
      },
      (page) => deps.tabs.delete(page),
      deps.limits ?? resolveBrowserTabLimits(),
      now
    )
    this.restartBudget = new BrowserProviderRestartBudget(now)
  }

  arm(): void {
    this.timer ??= setInterval(() => {
      void this.runMaintenance()
    }, this.deps.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS)
    this.timer.unref?.()
  }

  disarm(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  noteHost(host: RuntimeBrowserCommandHost): void {
    this.reclaimer.noteHost(host)
  }

  crashCount(): number {
    return this.restartBudget.crashCount()
  }

  /** One pass now; concurrent calls share it. */
  runMaintenance(): Promise<void> {
    this.maintaining ??= this.maintain().finally(() => {
      this.maintaining = null
    })
    return this.maintaining
  }

  private async maintain(): Promise<void> {
    if (!this.deps.isAlive()) {
      if (!this.restartBudget.tryBeginRestart()) {
        return
      }
      const pages = this.deps.tabs.listPages()
      this.restartBudget.recordCrash('sidecar process exited')
      console.warn('[orcad] Electron browser sidecar exited; relaunching it.')
      try {
        await this.deps.relaunch()
      } catch (error) {
        console.warn(
          '[orcad] Electron browser sidecar relaunch failed:',
          error instanceof Error ? error.message : String(error)
        )
      }
      for (const page of pages) {
        this.reclaimer.forgotten(page)
      }
      return
    }
    await this.reclaimer.reclaimIdle()
  }
}
