import { app, BrowserWindow, dialog, net, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_DISTRIBUTION } from '../../shared/app-distribution'
import { killAllPty } from '../ipc/pty'
import { readMacosBundleId } from '../macos-tcc-reset'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { getReleaseDownloadUrl } from '../updater-prerelease-feed'
import { downloadMacBundleSwapAsset } from './mac-bundle-swap-download'
import {
  checkMacBundleSwapTarget,
  launchMacBundleSwap,
  stageMacBundleSwapUpdate
} from './mac-bundle-swap-install'
import { selectMacBundleSwapAsset } from './mac-bundle-swap-manifest'
import {
  peekMacUpdateInstallStrategy,
  resolveMacUpdateInstallStrategy,
  resolveRunningMacAppBundlePath
} from './mac-update-install-strategy'
import { UpdaterPackageRecovery } from './updater-package-recovery'

const MANIFEST_TIMEOUT_MS = 15_000

/**
 * Update path for ad-hoc/unsigned macOS builds, which Squirrel.Mac can never install: check stays on
 * electron-updater, while download, verification, and the bundle replacement happen here.
 */
export abstract class UpdaterMacBundleSwap extends UpdaterPackageRecovery {
  protected stagedMacBundleSwap: { version: string; stagedAppPath: string } | null = null

  private getMacBundleSwapWorkDir(): string {
    return join(app.getPath('userData'), 'pending-app-update')
  }

  /** 'bundle-swap' only for ordinary release updates of an ad-hoc bundle; null while probing. */
  protected getMacUpdateInstallStrategy(): 'squirrel' | 'bundle-swap' | null {
    if (this.activeUpdateSource !== 'release' || this.isPinnedBuildActive) {
      return 'squirrel'
    }
    return peekMacUpdateInstallStrategy()
  }

  protected prepareMacUpdateInstallStrategy(): Promise<unknown> {
    return resolveMacUpdateInstallStrategy()
  }

  protected async downloadMacBundleSwapUpdate(version: string): Promise<void> {
    const workDir = this.getMacBundleSwapWorkDir()
    this.stagedMacBundleSwap = null
    try {
      // Why the v-tag: the fork release workflow publishes every build as `v<version>`.
      const releaseDownloadUrl = getReleaseDownloadUrl(`v${version}`)
      const manifestResponse = await net.fetch(`${releaseDownloadUrl}/latest-mac.yml`, {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
      })
      if (!manifestResponse.ok) {
        throw new Error(`Could not read the update manifest (HTTP ${manifestResponse.status})`)
      }
      const asset = selectMacBundleSwapAsset({
        manifestText: await manifestResponse.text(),
        releaseDownloadUrl,
        expectedVersion: version,
        arch: process.arch
      })
      await rm(workDir, { recursive: true, force: true })
      let lastPercent = 0
      const zipPath = await downloadMacBundleSwapAsset({
        asset,
        destinationDir: join(workDir, 'download'),
        request: (url, init) => net.fetch(url, init),
        onProgress: (fraction) => {
          // Why cap at 99: 100% while 'downloading' arms the Squirrel quit guard (updater-mac-install).
          const percent = Math.min(99, Math.floor(fraction * 100))
          if (percent > lastPercent) {
            lastPercent = percent
            this.sendStatus({ state: 'downloading', percent, version })
          }
        }
      })
      const runningBundlePath = resolveRunningMacAppBundlePath()
      const expectedBundleId = runningBundlePath ? await readMacosBundleId(runningBundlePath) : null
      if (!expectedBundleId) {
        throw new Error('Could not read the running app bundle id')
      }
      const stagedAppPath = await stageMacBundleSwapUpdate({
        zipPath,
        stagingDir: join(workDir, 'staged'),
        expectedBundleId,
        expectedVersion: version
      })
      await rm(zipPath, { force: true })
      this.downloadInFlight = false
      // A newer check may have superseded this download while it ran.
      if (this.availableVersion !== version) {
        return
      }
      this.stagedMacBundleSwap = { version, stagedAppPath }
      recordUpdaterLifecycle('macos_bundle_swap_staged', { version })
      this.sendStatus({ state: 'downloaded', version, releaseUrl: this.getKnownReleaseUrl() })
    } catch (error) {
      this.downloadInFlight = false
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      recordUpdaterLifecycle(
        'macos_bundle_swap_download_failed',
        { version },
        { level: 'warn', message }
      )
      this.sendErrorStatus(`Could not download the update: ${message}`)
    }
  }

  /** Returns false when no staged bundle exists, so the caller falls through to Squirrel. */
  protected async performMacBundleSwapInstall(pendingVersion: string): Promise<boolean> {
    const staged = this.stagedMacBundleSwap
    if (process.platform !== 'darwin' || !staged || staged.version !== pendingVersion) {
      return false
    }
    const targetAppPath = resolveRunningMacAppBundlePath()
    const targetCheck = targetAppPath
      ? checkMacBundleSwapTarget(targetAppPath)
      : ({ ok: false, reason: 'The running app is not inside an .app bundle.' } as const)
    if (!targetAppPath || !targetCheck.ok) {
      this.mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
      await this.showManualMacBundleInstall(staged.stagedAppPath, targetCheck)
      return true
    }
    this.quitAndInstallInProgress = true
    this.quittingForUpdate = true
    try {
      recordUpdaterLifecycle('macos_bundle_swap_started', { version: pendingVersion })
      await this.runBeforeUpdateQuitCleanup()
      launchMacBundleSwap({
        pid: process.pid,
        targetAppPath,
        stagedAppPath: staged.stagedAppPath,
        cleanupDir: this.getMacBundleSwapWorkDir(),
        logPath: join(app.getPath('userData'), 'app-update-swap.log')
      })
      this.updateInstallCommitted = true
      // Why: the swap waits for this pid to exit; a wedged shutdown must not strand it.
      armUpdateInstallExitWatchdog()
      killAllPty()
      for (const win of BrowserWindow.getAllWindows()) {
        win.removeAllListeners('close')
      }
      app.quit()
    } catch (error) {
      this.resetQuitForUpdateState()
      this.sendInstallFailureStatus({
        state: 'error',
        message: this.withInstallFailureCause(
          `Could not start the update. ${APP_DISTRIBUTION.productName} remains open.`,
          error
        )
      })
    }
    return true
  }

  private async showManualMacBundleInstall(
    stagedAppPath: string,
    targetCheck: { ok: false; reason: string } | { ok: true }
  ): Promise<void> {
    const reason = targetCheck.ok ? '' : `${targetCheck.reason}\n\n`
    recordUpdaterLifecycle('macos_bundle_swap_manual_install', {})
    shell.showItemInFolder(stagedAppPath)
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'Install the Update Manually',
      message: `${APP_DISTRIBUTION.productName} can't replace itself here.`,
      detail: `${reason}The verified update is selected in Finder. Quit ${APP_DISTRIBUTION.productName}, then drag the selected app into your Applications folder and choose Replace.`,
      buttons: ['OK'],
      noLink: true
    }
    await (this.mainWindowRef
      ? dialog.showMessageBox(this.mainWindowRef, options)
      : dialog.showMessageBox(options))
  }
}
