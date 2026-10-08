import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  checkMacBundleSwapTarget,
  launchMacBundleSwap,
  stageMacBundleSwapUpdate
} from './mac-bundle-swap-install'

const isPosix = process.platform !== 'win32'

function writeBundle(root: string, name: string, marker: string): string {
  const bundle = join(root, name)
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'marker.txt'), marker)
  return bundle
}

function writeRelaunchRecorder(root: string): { program: string; log: string } {
  const log = join(root, 'relaunched.txt')
  const program = join(root, 'relaunch.sh')
  writeFileSync(program, `#!/bin/sh\nprintf '%s' "$1" > '${log}'\n`)
  chmodSync(program, 0o755)
  return { program, log }
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${path}`)
}

describe('mac bundle swap', () => {
  let tempRoot: string | null = null

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = null
    }
  })

  it.runIf(isPosix)(
    'replaces the bundle only after the old app exits, then relaunches',
    async () => {
      tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-'))
      const target = writeBundle(join(tempRoot, 'Applications'), 'Orca Next.app', 'old')
      const cleanupDir = join(tempRoot, 'pending')
      const staged = writeBundle(cleanupDir, 'Orca Next.app', 'new')
      const recorder = writeRelaunchRecorder(tempRoot)
      const oldApp = spawnProcess({ program: '/bin/sleep', args: ['0.5'], stdio: 'ignore' })
      const oldAppPid = oldApp.pid
      if (oldAppPid === undefined) {
        throw new Error('sleep did not start')
      }

      launchMacBundleSwap({
        pid: oldAppPid,
        targetAppPath: target,
        stagedAppPath: staged,
        cleanupDir,
        logPath: join(tempRoot, 'swap.log'),
        relaunchProgram: recorder.program
      })
      // Why: the swap must not touch the bundle while the old process is alive.
      expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('old')

      expect(await waitForFile(recorder.log)).toBe(target)
      expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('new')
      expect(existsSync(`${target}.orca-update-old`)).toBe(false)
      expect(existsSync(cleanupDir)).toBe(false)
    }
  )

  it.runIf(isPosix)('restores the old bundle when the new one cannot be moved in', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-'))
    const target = writeBundle(join(tempRoot, 'Applications'), 'Orca Next.app', 'old')
    const recorder = writeRelaunchRecorder(tempRoot)

    launchMacBundleSwap({
      pid: 2_147_483_646,
      targetAppPath: target,
      stagedAppPath: join(tempRoot, 'missing', 'Orca Next.app'),
      cleanupDir: join(tempRoot, 'missing'),
      logPath: join(tempRoot, 'swap.log'),
      relaunchProgram: recorder.program
    })

    expect(await waitForFile(recorder.log)).toBe(target)
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('old')
    expect(readFileSync(join(tempRoot, 'swap.log'), 'utf8')).toContain('could not move the new app')
  })

  it('refuses in-place swaps from translocated, disk-image, or unwritable locations', () => {
    expect(
      checkMacBundleSwapTarget('/private/var/folders/x/AppTranslocation/ABC/d/Orca Next.app').ok
    ).toBe(false)
    expect(checkMacBundleSwapTarget('/Volumes/Orca Next/Orca Next.app').ok).toBe(false)
    expect(checkMacBundleSwapTarget('/nonexistent-orca-parent/Orca Next.app').ok).toBe(false)
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-'))
    expect(checkMacBundleSwapTarget(join(tempRoot, 'Orca Next.app'))).toEqual({ ok: true })
  })

  describe.runIf(process.platform === 'darwin')('staging a downloaded zip', () => {
    async function buildSignedZip(
      root: string,
      bundleId: string,
      version: string
    ): Promise<string> {
      const bundle = join(root, 'build', 'Orca Next.app')
      mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(
        join(bundle, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Orca Next</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`
      )
      copyFileSync('/usr/bin/true', join(bundle, 'Contents', 'MacOS', 'Orca Next'))
      const sign = await runProcess({
        program: '/usr/bin/codesign',
        args: ['--force', '-s', '-', bundle]
      })
      expect(sign.code).toBe(0)
      const zipPath = join(root, 'update.zip')
      const zip = await runProcess({
        program: '/usr/bin/ditto',
        args: ['-c', '-k', '--keepParent', bundle, zipPath]
      })
      expect(zip.code).toBe(0)
      return zipPath
    }

    it('accepts an intact ad-hoc bundle with the expected id and version', async () => {
      tempRoot = mkdtempSync(join(tmpdir(), 'orca-stage-'))
      const zipPath = await buildSignedZip(tempRoot, 'com.meapri.orca-next', '1.4.215')
      const staged = await stageMacBundleSwapUpdate({
        zipPath,
        stagingDir: join(tempRoot, 'staged'),
        expectedBundleId: 'com.meapri.orca-next',
        expectedVersion: '1.4.215'
      })
      expect(staged).toBe(join(tempRoot, 'staged', 'Orca Next.app'))
    })

    it('rejects a bundle for another app, such as the official Orca', async () => {
      tempRoot = mkdtempSync(join(tmpdir(), 'orca-stage-'))
      const zipPath = await buildSignedZip(tempRoot, 'com.stablyai.orca', '1.4.215')
      await expect(
        stageMacBundleSwapUpdate({
          zipPath,
          stagingDir: join(tempRoot, 'staged'),
          expectedBundleId: 'com.meapri.orca-next',
          expectedVersion: '1.4.215'
        })
      ).rejects.toThrow(/bundle id/)
    })

    it('rejects a bundle whose seal was modified after signing', async () => {
      tempRoot = mkdtempSync(join(tmpdir(), 'orca-stage-'))
      const bundle = join(tempRoot, 'build', 'Orca Next.app')
      await buildSignedZip(tempRoot, 'com.meapri.orca-next', '1.4.215')
      writeFileSync(join(bundle, 'Contents', 'MacOS', 'Orca Next'), 'tampered')
      const zipPath = join(tempRoot, 'tampered.zip')
      await runProcess({
        program: '/usr/bin/ditto',
        args: ['-c', '-k', '--keepParent', bundle, zipPath]
      })
      await expect(
        stageMacBundleSwapUpdate({
          zipPath,
          stagingDir: join(tempRoot, 'staged'),
          expectedBundleId: 'com.meapri.orca-next',
          expectedVersion: '1.4.215'
        })
      ).rejects.toThrow(/signature seal/)
    })
  })
})
