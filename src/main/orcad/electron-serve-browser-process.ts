import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { BrowserError } from '../browser/browser-error'
import type {
  RuntimeBrowserCommandHost,
  RuntimeBrowserCommands
} from '../runtime/orca-runtime-browser'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { sendOrcadSidecarRequest } from './orcad-sidecar-runtime-client'
import {
  ElectronSidecarTabRegistry,
  ElectronSidecarTabSchema,
  type ElectronSidecarPage
} from './electron-sidecar-tab-registry'
import {
  electronSidecarRuntimeMethodName,
  TARGETLESS_BROWSER_METHODS
} from './electron-sidecar-method-routing'
import {
  electronServeEnvironment,
  processIsLive,
  reserveLoopbackPort,
  signalProcess
} from './electron-serve-sidecar-process-control'
import {
  ElectronSidecarGovernance,
  type ElectronSidecarGovernanceDeps
} from './electron-serve-browser-governance'

const START_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 5_000
const SIDECAR_TAB_CLOSE_TIMEOUT_MS = 5_000
const BrowserPageResult = z.object({ browserPageId: z.string() }).passthrough()
const BrowserCloseResult = z.object({ closed: z.boolean() }).passthrough()
const BrowserTabListResult = z.object({ tabs: z.array(ElectronSidecarTabSchema) }).passthrough()
const RuntimeStatusResult = z.object({ capabilities: z.array(z.string()).optional() }).passthrough()

export class ElectronServeBrowserProcess {
  private child: SpawnedProcess | null = null
  private metadata: RuntimeMetadata | null = null
  private readonly tabs = new ElectronSidecarTabRegistry()
  private sidecarDataPath: string | null = null
  private stopped = false
  private readonly governance: ElectronSidecarGovernance

  constructor(
    private readonly executablePath: string,
    options: Pick<ElectronSidecarGovernanceDeps, 'limits' | 'now' | 'maintenanceIntervalMs'> = {}
  ) {
    this.governance = new ElectronSidecarGovernance({
      ...options,
      tabs: this.tabs,
      closePage: async (page) => {
        if (this.metadata) {
          await sendOrcadSidecarRequest(
            this.metadata,
            'browser.tabClose',
            { page: page.sidecarPageId },
            SIDECAR_TAB_CLOSE_TIMEOUT_MS
          )
        }
      },
      // Why stopped counts as alive: a deliberate stop has nothing to recover.
      isAlive: () => this.stopped || this.isAvailable(),
      relaunch: async () => {
        await this.stopSidecar()
        await this.startSidecar()
      }
    })
  }

  /** Relaunches recovered and tabs reclaimed since start; for health reporting and tests. */
  crashCount(): number {
    return this.governance.crashCount()
  }

  reclaimedTabCount(): number {
    return this.governance.reclaimer.totalReclaimed()
  }

  runMaintenance(): Promise<void> {
    return this.governance.runMaintenance()
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.startSidecar()
    this.governance.arm()
  }

  private async startSidecar(): Promise<void> {
    const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
    const userDataPath = await mkdtemp(join(temporaryRoot, 'orcad-browser-'))
    this.sidecarDataPath = userDataPath
    const port = await reserveLoopbackPort()
    const child = spawnProcess({
      program: this.executablePath,
      args: [
        '--serve',
        '--serve-port',
        String(port),
        '--serve-json',
        '--serve-no-pairing',
        `--user-data-dir=${userDataPath}`
      ],
      env: electronServeEnvironment()
    })
    this.child = child
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', () => undefined)
      stream?.resume()
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const metadata = readRuntimeMetadata(userDataPath)
      if (metadata) {
        try {
          const status = RuntimeStatusResult.parse(
            await sendOrcadSidecarRequest(metadata, 'status.get', undefined, 5_000)
          )
          if (status.capabilities?.includes('browser.headless.v1')) {
            this.metadata = metadata
            return
          }
          lastError = new Error('Installed Electron app omitted browser.headless.v1.')
        } catch (error) {
          lastError = error
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }
      await delay(100)
    }
    throw new Error(
      `Installed Electron browser provider did not become ready: ${
        lastError instanceof Error ? lastError.message : 'no runtime metadata'
      }`
    )
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
        return (...args: unknown[]) => this.invoke(host, property, args)
      }
    })
  }
  isAvailable(): boolean {
    return this.metadata !== null && processIsLive(this.metadata.pid)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.governance.disarm()
    await this.stopSidecar()
  }

  private async stopSidecar(): Promise<void> {
    const child = this.child
    const sidecarPid = this.metadata?.pid ?? child?.pid ?? null
    const sidecarDataPath = this.sidecarDataPath
    this.child = null
    this.metadata = null
    this.sidecarDataPath = null
    this.tabs.clear()
    if (sidecarPid) {
      signalProcess(sidecarPid, 'SIGTERM')
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (processIsLive(sidecarPid) && Date.now() < deadline) {
        await delay(50)
      }
      if (processIsLive(sidecarPid)) {
        signalProcess(sidecarPid, 'SIGKILL')
      }
    }
    if (sidecarDataPath) {
      await rm(sidecarDataPath, { recursive: true, force: true })
    }
  }

  private async invoke(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (method === 'browserScreencast') {
      throw new BrowserError(
        'browser_screencast_unavailable',
        'The orcad Electron provider does not proxy screencast.'
      )
    }
    const metadata = this.metadata
    if (!metadata) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The Electron browser provider is not running.'
      )
    }
    this.governance.noteHost(host)
    const original = (args[0] ?? {}) as Record<string, unknown>
    const worktreeId =
      typeof original.worktree === 'string'
        ? (await host.resolveWorktreeSelector(original.worktree)).id
        : undefined
    const params: Record<string, unknown> = { ...original, worktree: undefined }
    const requestedPageId = typeof original.page === 'string' ? original.page : undefined
    const requestedIndex = typeof original.index === 'number' ? original.index : undefined
    let targetPage: ElectronSidecarPage | undefined
    let rpcMethod = electronSidecarRuntimeMethodName(method)
    if (method === 'browserTabCreate' && requestedPageId) {
      const existing = this.tabs.find(requestedPageId)
      if (existing) {
        this.tabs.require(requestedPageId, worktreeId)
        return { browserPageId: requestedPageId }
      }
      // Why drop `page`: the runtime advertises browser.tabCreate.known-id.v1, so web
      // clients send a provisional id for a page that does not exist yet. The sidecar
      // mints its own id and the caller's is adopted as the public one below; passing
      // the unknown id through would make the generic branch require() a missing page.
      delete params.page
    }
    if (method === 'browserTabCreate') {
      await this.governance.reclaimer.makeRoomForNewTab()
    }

    if (method === 'browserTabCurrent' && worktreeId) {
      targetPage = this.tabs.active(worktreeId)
      rpcMethod = 'browser.tabShow'
      params.page = targetPage.sidecarPageId
    } else if (method === 'browserTabSwitch' || method === 'browserTabClose') {
      targetPage = requestedPageId
        ? this.tabs.require(requestedPageId, worktreeId)
        : requestedIndex !== undefined
          ? this.tabs.pageAt(worktreeId, requestedIndex)
          : worktreeId
            ? this.tabs.active(worktreeId)
            : undefined
      if (targetPage) {
        params.page = targetPage.sidecarPageId
        delete params.index
      }
    } else if (requestedPageId && method !== 'browserTabCreate') {
      targetPage = this.tabs.require(requestedPageId, worktreeId)
      params.page = targetPage.sidecarPageId
    } else if (worktreeId && !TARGETLESS_BROWSER_METHODS[method]) {
      targetPage = this.tabs.active(worktreeId)
      params.page = targetPage.sidecarPageId
    }

    if (targetPage) {
      this.governance.reclaimer.touch(targetPage.publicPageId)
    }
    let result: unknown
    try {
      result = await sendOrcadSidecarRequest(metadata, rpcMethod, params)
    } catch (error) {
      if (
        targetPage &&
        error instanceof BrowserError &&
        (error.code === 'browser_tab_not_found' || error.code === 'browser_tab_closed')
      ) {
        this.tabs.delete(targetPage)
      }
      throw error
    }
    if (method === 'browserTabCreate') {
      const created = BrowserPageResult.parse(result)
      const page = this.tabs.register(created.browserPageId, requestedPageId, worktreeId)
      this.governance.reclaimer.touch(page.publicPageId)
      return { ...created, browserPageId: page.publicPageId }
    }
    if (method === 'browserTabList') {
      const listed = BrowserTabListResult.parse(result)
      return { ...listed, tabs: this.tabs.reconcileTabs(listed.tabs, worktreeId) }
    }
    if (method === 'browserTabSwitch') {
      const switched = BrowserPageResult.parse(result)
      const page = this.tabs.pageForSidecar(switched.browserPageId)
      if (page) {
        this.tabs.setActive(page)
      }
      return {
        ...switched,
        ...(requestedIndex !== undefined ? { switched: requestedIndex } : {}),
        browserPageId: this.tabs.publicPageId(switched.browserPageId)
      }
    }
    if (method === 'browserTabClose' && targetPage) {
      const closed = BrowserCloseResult.parse(result)
      if (closed.closed) {
        this.tabs.delete(targetPage)
      }
      return closed
    }
    if (method === 'browserTabProfileClone') {
      const cloned = BrowserPageResult.parse(result)
      this.tabs.register(cloned.browserPageId, undefined, targetPage?.worktreeId)
    }
    return this.tabs.rewriteResult(result)
  }
}
