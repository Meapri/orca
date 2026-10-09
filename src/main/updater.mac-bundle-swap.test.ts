import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const STAGED_APP = '/tmp/orca-next-test/pending-app-update/staged/Orca Next.app'
const RUNNING_APP = '/Applications/Orca Next.app'
const SHA512 = `${'c'.repeat(86)}==`

const mocks = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const appMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    getPath: vi.fn(() => '/tmp/orca-next-test'),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEventHandlers.set(event, [...(appEventHandlers.get(event) ?? []), handler])
      return appMock
    }),
    quit: vi.fn()
  }
  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler])
      return autoUpdaterMock
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(...args)
      }
    },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn()
  }
  return {
    appMock,
    autoUpdaterMock,
    resetHandlers: () => {
      appEventHandlers.clear()
      eventHandlers.clear()
    },
    netFetch: vi.fn(),
    showItemInFolder: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    downloadAsset: vi.fn(async () => '/tmp/orca-next-test/pending-app-update/download/u.zip'),
    stage: vi.fn(async () => STAGED_APP),
    checkTarget: vi.fn((): { ok: true } | { ok: false; reason: string } => ({ ok: true })),
    launchSwap: vi.fn(),
    killAllPty: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: mocks.appMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  autoUpdater: { on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: mocks.showItemInFolder },
  dialog: { showMessageBox: mocks.showMessageBox },
  net: { fetch: mocks.netFetch }
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdaterMock }))
vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => mocks.autoUpdaterMock
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./ipc/pty', () => ({ killAllPty: mocks.killAllPty }))
vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: vi.fn(),
  disarmUpdateInstallExitWatchdog: vi.fn()
}))
vi.mock('./macos-tcc-reset', () => ({
  readMacosBundleId: vi.fn(async () => 'com.meapri.orca-next')
}))
vi.mock('./updater/mac-update-install-strategy', () => ({
  peekMacUpdateInstallStrategy: () => 'bundle-swap',
  resolveMacUpdateInstallStrategy: async () => 'bundle-swap',
  resolveRunningMacAppBundlePath: () => RUNNING_APP
}))
vi.mock('./updater/mac-bundle-swap-download', () => ({
  downloadMacBundleSwapAsset: mocks.downloadAsset
}))
vi.mock('./updater/mac-bundle-swap-install', () => ({
  stageMacBundleSwapUpdate: mocks.stage,
  checkMacBundleSwapTarget: mocks.checkTarget,
  launchMacBundleSwap: mocks.launchSwap
}))

warmUpdaterModule()

function manifestFor(version: string): string {
  return [
    `version: ${version}`,
    'files:',
    '  - url: orca-next-macos-arm64.zip',
    `    sha512: ${SHA512}`,
    '    size: 10',
    '  - url: orca-next-macos-x64.zip',
    `    sha512: ${SHA512}`,
    '    size: 10'
  ].join('\n')
}

async function reachDownloaded(): Promise<{
  send: ReturnType<typeof vi.fn>
  updater: Awaited<ReturnType<typeof loadUpdaterModule>>
}> {
  const send = vi.fn()
  const updater = await loadUpdaterModule()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater only calls webContents.send on its window.
  updater.setupAutoUpdater({ webContents: { send } } as never)
  await vi.waitFor(() => expect(mocks.autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1))
  mocks.autoUpdaterMock.emit('checking-for-update')
  mocks.autoUpdaterMock.emit('update-available', { version: '1.0.61' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  updater.downloadUpdate()
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
    )
  )
  return { send, updater }
}

describe.runIf(process.platform === 'darwin')('ad-hoc macOS update via bundle swap', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.resetHandlers()
    for (const fn of [
      mocks.autoUpdaterMock.checkForUpdates,
      mocks.autoUpdaterMock.downloadUpdate,
      mocks.autoUpdaterMock.quitAndInstall,
      mocks.appMock.quit,
      mocks.launchSwap,
      mocks.showItemInFolder,
      mocks.showMessageBox,
      mocks.stage,
      mocks.downloadAsset
    ]) {
      fn.mockClear()
    }
    mocks.autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    mocks.checkTarget.mockReturnValue({ ok: true })
    mocks.netFetch.mockImplementation(async (url: string) =>
      url.endsWith('/v1.0.61/latest-mac.yml')
        ? { ok: true, status: 200, text: async () => manifestFor('1.0.61') }
        : Promise.reject(new Error('offline'))
    )
  })

  it('downloads and stages outside Squirrel, then swaps the bundle on restart', async () => {
    const { updater } = await reachDownloaded()

    // Why: Squirrel.Mac rejects ad-hoc bundles, so electron-updater must never download here.
    expect(mocks.autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(mocks.netFetch).toHaveBeenCalledWith(
      'https://github.com/Meapri/orca/releases/download/v1.0.61/latest-mac.yml',
      expect.anything()
    )
    expect(mocks.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBundleId: 'com.meapri.orca-next',
        expectedVersion: '1.0.61'
      })
    )

    updater.quitAndInstall()
    await vi.waitFor(() => expect(mocks.appMock.quit).toHaveBeenCalledTimes(1))
    expect(mocks.launchSwap).toHaveBeenCalledWith(
      expect.objectContaining({ targetAppPath: RUNNING_APP, stagedAppPath: STAGED_APP })
    )
    expect(mocks.killAllPty).toHaveBeenCalled()
    expect(mocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.isQuittingForUpdate()).toBe(true)
  })

  it('falls back to a guided manual install when the bundle cannot be replaced in place', async () => {
    mocks.checkTarget.mockReturnValue({
      ok: false,
      reason: 'This copy is running from a disk image.'
    })
    const { send, updater } = await reachDownloaded()

    updater.quitAndInstall()
    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1))
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(STAGED_APP)
    expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
    expect(mocks.launchSwap).not.toHaveBeenCalled()
    expect(mocks.appMock.quit).not.toHaveBeenCalled()
    expect(updater.isQuittingForUpdate()).toBe(false)
  })
})
