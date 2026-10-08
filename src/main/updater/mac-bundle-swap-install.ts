import { accessSync, constants, closeSync, openSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { readMacosBundleInfoValue } from '../macos-tcc-reset'

const EXTRACT_TIMEOUT_MS = 5 * 60_000
const VERIFY_TIMEOUT_MS = 2 * 60_000

/**
 * Waits for the old app to exit, renames it aside, moves the staged bundle into its place, and
 * relaunches. Any failed move restores the old bundle so the user is never left without an app.
 * Paths arrive as positional args, so nothing user-controlled is interpolated into the script.
 */
export const MAC_BUNDLE_SWAP_SCRIPT = [
  'pid="$1"; target="$2"; staged="$3"; backup="$4"; relaunch="$5"; cleanup="$6"',
  'n=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  n=$((n+1))',
  '  if [ "$n" -gt 1200 ]; then echo "old app did not exit" >&2; exit 1; fi',
  '  sleep 0.25',
  'done',
  'rm -rf "$backup"',
  'if ! mv "$target" "$backup"; then echo "could not move the old app aside" >&2; "$relaunch" "$target"; exit 1; fi',
  'if ! mv "$staged" "$target"; then echo "could not move the new app in" >&2; mv "$backup" "$target"; "$relaunch" "$target"; exit 1; fi',
  'rm -rf "$backup" "$cleanup"',
  '"$relaunch" "$target"'
].join('\n')

export type MacBundleSwapTargetCheck = { ok: true } | { ok: false; reason: string }

/** Whether the running bundle can be replaced in place; otherwise the user installs by hand. */
export function checkMacBundleSwapTarget(targetAppPath: string): MacBundleSwapTargetCheck {
  if (targetAppPath.includes('/AppTranslocation/')) {
    return {
      ok: false,
      reason: 'macOS is running this copy from a quarantine location (App Translocation).'
    }
  }
  if (targetAppPath.startsWith('/Volumes/')) {
    return { ok: false, reason: 'This copy is running from a disk image.' }
  }
  try {
    accessSync(dirname(targetAppPath), constants.W_OK)
  } catch {
    return { ok: false, reason: `${dirname(targetAppPath)} is not writable by this user.` }
  }
  return { ok: true }
}

async function runChecked(program: string, args: string[], timeoutMs: number, what: string) {
  const result = await runProcess({ program, args, timeoutMs })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').at(-1) ?? ''
    throw new Error(`${what} failed${detail ? `: ${detail}` : ''}`)
  }
}

/** Extracts the verified zip and proves the bundle is this app, at this version, with an intact seal. */
export async function stageMacBundleSwapUpdate(options: {
  zipPath: string
  stagingDir: string
  expectedBundleId: string
  expectedVersion: string
}): Promise<string> {
  await rm(options.stagingDir, { recursive: true, force: true })
  await mkdir(options.stagingDir, { recursive: true })
  // Why ditto: it preserves the symlinks, modes, and xattrs a signed bundle depends on.
  await runChecked(
    '/usr/bin/ditto',
    ['-x', '-k', options.zipPath, options.stagingDir],
    EXTRACT_TIMEOUT_MS,
    'Extracting the update'
  )
  const bundles = (await readdir(options.stagingDir)).filter((entry) => entry.endsWith('.app'))
  if (bundles.length !== 1) {
    throw new Error(`Update archive contains ${bundles.length} app bundles, expected 1`)
  }
  const stagedAppPath = join(options.stagingDir, bundles[0])
  const bundleId = await readMacosBundleInfoValue(stagedAppPath, 'CFBundleIdentifier')
  if (bundleId !== options.expectedBundleId) {
    throw new Error(
      `Update bundle id ${bundleId ?? 'unknown'} does not match ${options.expectedBundleId}`
    )
  }
  const version = await readMacosBundleInfoValue(stagedAppPath, 'CFBundleShortVersionString')
  if (version !== options.expectedVersion) {
    throw new Error(
      `Update bundle version ${version ?? 'unknown'} does not match ${options.expectedVersion}`
    )
  }
  await runChecked(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', stagedAppPath],
    VERIFY_TIMEOUT_MS,
    'Verifying the update signature seal'
  )
  return stagedAppPath
}

/** Starts the detached swap; the caller must quit the app right after this returns. */
export function launchMacBundleSwap(options: {
  pid: number
  targetAppPath: string
  stagedAppPath: string
  cleanupDir: string
  logPath: string
  relaunchProgram?: string
}): void {
  const logFd = openSync(options.logPath, 'a')
  try {
    const child = spawnProcess({
      program: '/bin/sh',
      args: [
        '-c',
        MAC_BUNDLE_SWAP_SCRIPT,
        'orca-update-swap',
        String(options.pid),
        options.targetAppPath,
        options.stagedAppPath,
        `${options.targetAppPath}.orca-update-old`,
        options.relaunchProgram ?? '/usr/bin/open',
        options.cleanupDir
      ],
      detached: true,
      stdio: ['ignore', logFd, logFd]
    })
    child.on('error', (error) => console.warn('[updater] bundle swap failed to start:', error))
    child.unref()
  } finally {
    closeSync(logFd)
  }
}
