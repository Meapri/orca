import type {
  RuntimeBrowserCommandHost,
  RuntimeBrowserCommands
} from '../runtime/orca-runtime-browser'
import { BrowserError } from '../browser/browser-error'
import {
  ExternalChromiumBrowserSession,
  type ExternalChromiumLaunch
} from './external-chromium-browser-session'
export type { ExternalChromiumLaunch } from './external-chromium-browser-session'
import type { ExternalChromiumPageRecord as PageRecord } from './external-chromium-tab-projection'
import { ExternalChromiumCommandDispatch } from './external-chromium-command-dispatch'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
import {
  createExternalChromiumTabReclaimer,
  forgetAllExternalChromiumTabs,
  forgetVanishedExternalChromiumTabs,
  type ExternalChromiumTabReclaimer
} from './external-chromium-tab-reclamation'
import { resolveBrowserTabLimits, type BrowserTabLimits } from './browser-tab-limits'
import {
  ExternalChromiumBrowserHealth,
  isBrowserDriverFailure
} from './external-chromium-browser-health'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import type { ExternalChromiumReapOutcome } from './external-chromium-orphan-reaper'

const MAINTENANCE_INTERVAL_MS = 60_000
// Why short: a renderer that cannot report its URL in this long is dead or spinning forever.
const UNRESPONSIVE_PROBE_TIMEOUT_MS = 5_000

export type ExternalChromiumBrowserProcessOptions = {
  limits?: BrowserTabLimits
  now?: () => number
  maintenanceIntervalMs?: number
  reapProfileProcesses?: (profilePath: string) => Promise<ExternalChromiumReapOutcome>
}

export class ExternalChromiumBrowserProcess {
  private readonly session: ExternalChromiumBrowserSession
  private readonly tabs: ExternalChromiumTabRegistry
  private readonly reclaimer: ExternalChromiumTabReclaimer
  private readonly health: ExternalChromiumBrowserHealth
  private readonly dispatch: ExternalChromiumCommandDispatch
  private readonly maintenanceIntervalMs: number
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private queue: Promise<void> = Promise.resolve()
  private available = false
  private stopped = false
  private targetPage: PageRecord | null = null

  constructor(
    agentBrowserPath: string,
    launch: ExternalChromiumLaunch,
    statePath: string,
    options: ExternalChromiumBrowserProcessOptions = {}
  ) {
    this.session = new ExternalChromiumBrowserSession(
      agentBrowserPath,
      launch,
      statePath,
      options.reapProfileProcesses
    )
    this.tabs = new ExternalChromiumTabRegistry(this.session)
    const now = options.now ?? Date.now
    this.reclaimer = createExternalChromiumTabReclaimer(
      this.session,
      this.tabs,
      options.limits ?? resolveBrowserTabLimits(),
      now
    )
    this.health = new ExternalChromiumBrowserHealth(now)
    this.dispatch = new ExternalChromiumCommandDispatch(
      this.session,
      this.tabs,
      this.reclaimer,
      (page) => {
        this.targetPage = page
      }
    )
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS
  }

  async start(): Promise<void> {
    this.stopped = false
    this.tabs.initialize(await this.session.start())
    this.available = true
    this.maintenanceTimer ??= setInterval(() => {
      void this.runMaintenance()
    }, this.maintenanceIntervalMs)
    this.maintenanceTimer.unref?.()
  }

  /** Browser crashes observed and recovered from since start; for health reporting. */
  crashCount(): number {
    return this.health.crashCount()
  }

  reclaimedTabCount(): number {
    return this.reclaimer.totalReclaimed()
  }

  /** One maintenance pass now, queued behind in-flight commands; the timer calls the same. */
  runMaintenance(): Promise<void> {
    return this.enqueue(() => this.maintain())
  }

  createCommands(host: RuntimeBrowserCommandHost): RuntimeBrowserCommands {
    return new Proxy({} as RuntimeBrowserCommands, {
      get: (_target, property) => {
        if (property === 'then') {
          return undefined
        }
        if (typeof property !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => this.enqueue(() => this.invokeGuarded(host, property, args))
      }
    })
  }
  isAvailable(): boolean {
    return this.available
  }

  async stop(): Promise<void> {
    this.available = false
    this.stopped = true
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    await this.enqueue(async () => {
      await this.session.stop()
      this.tabs.clear()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async invokeGuarded(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    this.reclaimer.noteHost(host)
    if (!this.available) {
      await this.recover()
    }
    this.targetPage = null
    try {
      const result = await this.dispatch.invoke(host, method, args)
      this.health.recordSuccess()
      return result
    } catch (error) {
      throw await this.classifyFailure(error)
    }
  }

  private async classifyFailure(error: unknown): Promise<unknown> {
    if (isBrowserDriverFailure(error)) {
      if (this.health.recordDriverFailure(error)) {
        this.markCrashed()
      }
      return error
    }
    const page = this.targetPage
    if (!(error instanceof BrowserError) || error.code !== 'browser_timeout' || !page) {
      return error
    }
    try {
      await this.session.run(['get', 'url'], UNRESPONSIVE_PROBE_TIMEOUT_MS)
      return error
    } catch {
      // A crashed renderer answers nothing; close it so its tab stops holding memory.
      await this.reclaimer.reclaim(page, 'unresponsive')
      return new BrowserError(
        'browser_tab_closed',
        'Browser tab stopped responding and was closed to reclaim its memory.'
      )
    }
  }

  /** The browser tree is gone: forget its tabs and stop advertising it until relaunched. */
  private markCrashed(): void {
    this.available = false
    forgetAllExternalChromiumTabs(this.tabs, this.reclaimer)
    console.warn(
      `[orcad] External browser stopped responding (${this.health.lastCrash() ?? 'unknown'}); ` +
        'it will be relaunched on the next command or maintenance tick.'
    )
  }

  private async recover(): Promise<void> {
    if (this.stopped || !this.health.tryBeginRestart()) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The browser stopped responding and is waiting to be relaunched. Retry shortly.'
      )
    }
    try {
      this.tabs.clear()
      this.tabs.initialize(await this.session.start())
      this.available = true
      this.health.recordSuccess()
      console.warn('[orcad] External browser relaunched.')
    } catch (error) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        `The browser could not be relaunched: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async maintain(): Promise<void> {
    if (this.stopped) {
      return
    }
    if (!this.available) {
      await this.recover().catch(() => undefined)
      return
    }
    if (this.tabs.listPages().length === 0) {
      return
    }
    try {
      const tabs = await this.session.readTabs()
      this.health.recordSuccess()
      forgetVanishedExternalChromiumTabs(
        this.tabs,
        this.reclaimer,
        new Set(tabs.map((tab) => tab.tabId))
      )
      await this.reclaimer.reclaimIdle()
    } catch (error) {
      if (isBrowserDriverFailure(error) && this.health.recordDriverFailure(error)) {
        this.markCrashed()
      }
    }
  }
}
