import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'

const runProcessMock = vi.fn()
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('')),
  rm: vi.fn(async () => undefined)
}))

import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import type { ExternalChromiumTabLimits } from './external-chromium-tab-limits'

type FakeTab = { tabId: string; url: string }

/** A stand-in for agent-browser: one Chromium with tabs, which can crash or wedge a tab. */
class FakeAgentBrowser {
  tabs: FakeTab[] = []
  active: string | null = null
  nextId = 1
  driverDown = false
  wedged = new Set<string>()
  issued: string[][] = []

  respond(args: readonly string[]): unknown {
    // Drop `--session <name> --profile <path>` and the trailing `--json`.
    const command = args.slice(4, -1)
    this.issued.push(command)
    if (this.driverDown) {
      return { code: 1, signal: null, stdout: '', stderr: 'daemon crashed', timedOut: false }
    }
    const [verb, arg, extra] = command
    if ((verb === 'snapshot' || verb === 'get') && this.active && this.wedged.has(this.active)) {
      return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }
    }
    return {
      code: 0,
      signal: null,
      stdout: JSON.stringify(this.dispatch(verb, arg, extra)),
      stderr: '',
      timedOut: false
    }
  }

  private dispatch(verb?: string, arg?: string, extra?: string): unknown {
    const ok = (data: unknown): unknown => ({ success: true, data })
    if (verb === 'tab' && arg === undefined) {
      return ok({
        tabs: this.tabs.map((tab) => ({ ...tab, title: '', active: tab.tabId === this.active }))
      })
    }
    if (verb === 'tab' && arg === 'new') {
      const tab = { tabId: `t${this.nextId++}`, url: extra ?? 'about:blank' }
      this.tabs.push(tab)
      this.active = tab.tabId
      return ok({ tabId: tab.tabId })
    }
    if (verb === 'tab' && arg === 'close') {
      this.tabs = this.tabs.filter((tab) => tab.tabId !== extra)
      this.wedged.delete(extra ?? '')
      return ok({ closed: true })
    }
    if (verb === 'tab') {
      this.active = arg ?? null
      return ok({})
    }
    if (verb === 'open') {
      if (this.tabs.length === 0) {
        this.tabs.push({ tabId: `t${this.nextId++}`, url: arg ?? 'about:blank' })
        this.active = this.tabs[0].tabId
      }
      const current = this.tabs.find((tab) => tab.tabId === this.active)
      if (current) {
        current.url = arg ?? current.url
      }
      return ok({ url: arg, title: '' })
    }
    if (verb === 'close') {
      this.tabs = []
      this.active = null
      return ok({ closed: true })
    }
    if (verb === 'get') {
      return ok({ url: this.tabs.find((tab) => tab.tabId === this.active)?.url })
    }
    if (verb === 'snapshot') {
      return ok({ snapshot: 'page', refs: {} })
    }
    return ok({})
  }
}

const host: RuntimeBrowserCommandHost = {
  getAgentBrowserBridge: () => null,
  resolveWorktreeSelector: async (selector) => ({ id: selector }),
  resolveBrowserWorkspace: async (selector) => ({ id: selector }),
  resolveBrowserNetworkExecutionHost: () => {
    throw new Error('unused')
  },
  getBrowserHostLeaseRegistry: () => {
    throw new Error('unused')
  },
  getRuntimeBrowserPageRegistry: () => {
    throw new Error('unused')
  },
  getAuthoritativeWindow: () => {
    throw new Error('unused')
  },
  getAvailableAuthoritativeWindow: () => null,
  getOffscreenBrowserBackend: () => null
}

let fake: FakeAgentBrowser
let clock: number

beforeEach(() => {
  fake = new FakeAgentBrowser()
  clock = 1_000_000
  runProcessMock.mockReset()
  runProcessMock.mockImplementation(async (spec: { args?: readonly string[] }) =>
    fake.respond(spec.args ?? [])
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function startProvider(limits: ExternalChromiumTabLimits = { maxTabs: 2, idleMs: 60_000 }) {
  const provider = new ExternalChromiumBrowserProcess(
    '/opt/orca/agent-browser',
    { executablePath: '/opt/chromium', provider: 'chromium' },
    '/state',
    { limits, now: () => clock, maintenanceIntervalMs: 3_600_000 }
  )
  await provider.start()
  return { provider, commands: provider.createCommands(host) }
}

function closedTabIds(): string[] {
  return fake.issued.filter((c) => c[0] === 'tab' && c[1] === 'close').map((c) => c[2])
}

describe('ExternalChromiumBrowserProcess tab cap', () => {
  it('closes the least recently used tab when a create would exceed the cap', async () => {
    const { provider, commands } = await startProvider()
    await commands.browserTabCreate({ page: 'a', url: 'https://a.test' })
    clock += 10
    await commands.browserTabCreate({ page: 'b', url: 'https://b.test' })
    clock += 10
    // Touching `a` makes `b` the least recently used.
    await commands.browserSnapshot({ page: 'a' })
    clock += 10
    await commands.browserTabCreate({ page: 'c', url: 'https://c.test' })

    const listed = (await commands.browserTabList({})) as { tabs: { browserPageId: string }[] }
    expect(listed.tabs.map((tab) => tab.browserPageId).sort()).toEqual(['a', 'c'])
    expect(provider.reclaimedTabCount()).toBe(1)
    await expect(commands.browserSnapshot({ page: 'b' })).rejects.toMatchObject({
      code: 'browser_no_tab'
    })
    await provider.stop()
  })

  it('closes nothing while under the cap', async () => {
    const { provider, commands } = await startProvider({ maxTabs: 3, idleMs: null })
    await commands.browserTabCreate({ page: 'a' })
    await commands.browserTabCreate({ page: 'b' })
    expect(closedTabIds()).toEqual([])
    await provider.stop()
  })
})

describe('ExternalChromiumBrowserProcess idle reclamation', () => {
  it('reclaims tabs idle past the limit and blanks the last one instead of closing it', async () => {
    const { provider, commands } = await startProvider({ maxTabs: 5, idleMs: 60_000 })
    await commands.browserTabCreate({ page: 'a', url: 'https://a.test' })
    await commands.browserTabCreate({ page: 'b', url: 'https://b.test' })
    clock += 30_000
    await commands.browserSnapshot({ page: 'b' })
    clock += 40_000

    await provider.runMaintenance()
    expect(provider.reclaimedTabCount()).toBe(1)
    clock += 60_001
    await provider.runMaintenance()

    expect(provider.reclaimedTabCount()).toBe(2)
    // One Chromium tab survives, blanked, so the driver stays attached.
    expect(fake.tabs).toHaveLength(1)
    expect(fake.tabs[0].url).toBe('about:blank')
    await expect(commands.browserTabCreate({ page: 'c' })).resolves.toEqual({
      browserPageId: 'c'
    })
    await provider.stop()
  })

  it('keeps recently used tabs', async () => {
    const { provider, commands } = await startProvider({ maxTabs: 5, idleMs: 60_000 })
    await commands.browserTabCreate({ page: 'a' })
    clock += 59_000
    await provider.runMaintenance()
    expect(provider.reclaimedTabCount()).toBe(0)
    await provider.stop()
  })
})

describe('ExternalChromiumBrowserProcess crash isolation', () => {
  it('reports the browser unavailable after it dies and relaunches it on the next command', async () => {
    const { provider, commands } = await startProvider()
    await commands.browserTabCreate({ page: 'a' })
    fake.driverDown = true

    await expect(commands.browserSnapshot({ page: 'a' })).rejects.toMatchObject({
      code: 'browser_error'
    })
    await expect(commands.browserSnapshot({ page: 'a' })).rejects.toMatchObject({
      code: 'browser_error'
    })
    expect(provider.isAvailable()).toBe(false)
    expect(provider.crashCount()).toBe(1)

    // The browser comes back (agent-browser relaunches Chromium); its old tabs are gone.
    fake.driverDown = false
    fake.tabs = []
    clock += 10_000
    await expect(commands.browserTabCreate({ page: 'fresh' })).resolves.toEqual({
      browserPageId: 'fresh'
    })
    expect(provider.isAvailable()).toBe(true)
    await expect(commands.browserSnapshot({ page: 'a' })).rejects.toMatchObject({
      code: 'browser_no_tab'
    })
    await provider.stop()
  })

  it('refuses a relaunch loop inside the restart backoff', async () => {
    const { provider, commands } = await startProvider()
    fake.driverDown = true
    await commands.browserTabList({}).catch(() => undefined)
    await commands.browserTabList({}).catch(() => undefined)
    expect(provider.isAvailable()).toBe(false)

    // First relaunch attempt fails because the driver is still down.
    await expect(commands.browserTabList({})).rejects.toMatchObject({ code: 'browser_unavailable' })
    // Inside the backoff no second launch is attempted at all.
    const issuedBefore = fake.issued.length
    await expect(commands.browserTabList({})).rejects.toMatchObject({ code: 'browser_unavailable' })
    expect(fake.issued.length).toBe(issuedBefore)
    await provider.stop()
  })

  it('closes a tab whose renderer stopped answering and keeps the browser', async () => {
    const { provider, commands } = await startProvider({ maxTabs: 5, idleMs: null })
    await commands.browserTabCreate({ page: 'a' })
    await commands.browserTabCreate({ page: 'b' })
    fake.wedged.add('t2')

    await expect(commands.browserSnapshot({ page: 'b' })).rejects.toMatchObject({
      code: 'browser_tab_closed'
    })
    expect(closedTabIds()).toEqual(['t2'])
    expect(provider.isAvailable()).toBe(true)
    await expect(commands.browserSnapshot({ page: 'a' })).resolves.toMatchObject({
      browserPageId: 'a'
    })
    await provider.stop()
  })

  it('keeps a slow tab that still answers the liveness probe', async () => {
    const { provider, commands } = await startProvider({ maxTabs: 5, idleMs: null })
    await commands.browserTabCreate({ page: 'a' })
    // Only the snapshot times out; `get url` answers, so the tab is slow rather than dead.
    runProcessMock.mockImplementationOnce(async () => ({
      code: 0,
      signal: null,
      stdout: '{"success":true}',
      stderr: '',
      timedOut: false
    }))
    runProcessMock.mockImplementationOnce(async () => ({
      code: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      timedOut: true
    }))

    await expect(commands.browserSnapshot({ page: 'a' })).rejects.toMatchObject({
      code: 'browser_timeout'
    })
    expect(closedTabIds()).toEqual([])
    await provider.stop()
  })
})
