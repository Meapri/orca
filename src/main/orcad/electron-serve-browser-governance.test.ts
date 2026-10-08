import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElectronSidecarGovernance } from './electron-serve-browser-governance'
import {
  ElectronSidecarTabRegistry,
  type ElectronSidecarPage
} from './electron-sidecar-tab-registry'
import type { BrowserTabLimits } from './browser-tab-limits'

let clock: number
let tabs: ElectronSidecarTabRegistry
let alive: boolean
const closePage = vi.fn(async (_page: ElectronSidecarPage) => undefined)
const relaunch = vi.fn(async () => undefined)

function governance(
  limits: BrowserTabLimits = { maxTabs: 2, idleMs: 60_000 }
): ElectronSidecarGovernance {
  return new ElectronSidecarGovernance({
    tabs,
    closePage,
    isAlive: () => alive,
    relaunch,
    limits,
    now: () => clock
  })
}

beforeEach(() => {
  clock = 1_000_000
  tabs = new ElectronSidecarTabRegistry()
  alive = true
  closePage.mockReset()
  closePage.mockResolvedValue(undefined)
  relaunch.mockReset()
  relaunch.mockResolvedValue(undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('ElectronSidecarGovernance', () => {
  it('closes the least recently used sidecar tab to fit a new one under the cap', async () => {
    const subject = governance()
    tabs.register('s-a', 'a')
    subject.reclaimer.touch('a')
    clock += 10
    tabs.register('s-b', 'b')
    subject.reclaimer.touch('b')

    await subject.reclaimer.makeRoomForNewTab()

    expect(closePage.mock.calls.map(([page]) => page.publicPageId)).toEqual(['a'])
    expect(tabs.listPages().map((page) => page.publicPageId)).toEqual(['b'])
  })

  it('closes nothing while under the cap', async () => {
    const subject = governance({ maxTabs: 3, idleMs: null })
    tabs.register('s-a', 'a')
    await subject.reclaimer.makeRoomForNewTab()
    expect(closePage).not.toHaveBeenCalled()
  })

  it('reclaims only tabs idle past the limit', async () => {
    const subject = governance({ maxTabs: 10, idleMs: 60_000 })
    tabs.register('s-a', 'a')
    subject.reclaimer.touch('a')
    clock += 50_000
    tabs.register('s-b', 'b')
    subject.reclaimer.touch('b')
    clock += 20_000

    await subject.runMaintenance()

    expect(tabs.listPages().map((page) => page.publicPageId)).toEqual(['b'])
  })

  it('forgets a tab the sidecar refused to close instead of retrying it forever', async () => {
    const subject = governance({ maxTabs: 1, idleMs: null })
    tabs.register('s-a', 'a')
    closePage.mockRejectedValueOnce(new Error('sidecar gone'))

    await subject.reclaimer.makeRoomForNewTab()

    expect(tabs.listPages()).toEqual([])
  })

  it('relaunches a dead sidecar and respects the restart backoff', async () => {
    const subject = governance()
    tabs.register('s-a', 'a')
    alive = false
    relaunch.mockImplementation(async () => {
      // A relaunched sidecar starts with no tabs; the process's stop clears the registry.
      tabs.clear()
    })

    await subject.runMaintenance()
    expect(relaunch).toHaveBeenCalledOnce()
    expect(subject.crashCount()).toBe(1)
    expect(tabs.listPages()).toEqual([])

    // Still dead a second later: inside the backoff, no second launch.
    clock += 1_000
    await subject.runMaintenance()
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('does not relaunch a live sidecar', async () => {
    const subject = governance()
    await subject.runMaintenance()
    expect(relaunch).not.toHaveBeenCalled()
  })
})
