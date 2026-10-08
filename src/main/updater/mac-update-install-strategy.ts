import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

/**
 * `squirrel`: electron-updater's native install (needs a Developer ID signature).
 * `bundle-swap`: download, verify, and swap the .app ourselves (ad-hoc or unsigned builds).
 */
export type MacUpdateInstallStrategy = 'squirrel' | 'bundle-swap'

export type MacAppSignatureKind = 'developer-id' | 'adhoc' | 'unsigned' | 'other'

const CODESIGN_TIMEOUT_MS = 10_000

let resolvedStrategy: MacUpdateInstallStrategy | null = null
let pendingStrategy: Promise<MacUpdateInstallStrategy> | null = null

/** Classifies `codesign -dv --verbose=2` output (it writes to stderr). */
export function classifyCodesignDisplayOutput(
  output: string,
  exitCode: number | null
): MacAppSignatureKind {
  if (/^Authority=Developer ID Application:/m.test(output)) {
    return 'developer-id'
  }
  if (/^Signature=adhoc$/m.test(output) || /flags=0x[0-9a-f]*\(adhoc/i.test(output)) {
    return 'adhoc'
  }
  if (exitCode !== 0 && /not signed at all/i.test(output)) {
    return 'unsigned'
  }
  return 'other'
}

/**
 * Why only ad-hoc/unsigned swap bundles: Squirrel.Mac rejects any update whose signature does not
 * satisfy the running app's designated requirement, and an ad-hoc requirement is a cdhash that
 * changes every build. Anything else (Developer ID, Apple Development) keeps upstream's path.
 */
export function strategyForSignatureKind(kind: MacAppSignatureKind): MacUpdateInstallStrategy {
  return kind === 'adhoc' || kind === 'unsigned' ? 'bundle-swap' : 'squirrel'
}

/** `X.app/Contents/MacOS/X` → `X.app`, or null when the executable is not inside a bundle. */
export function resolveRunningMacAppBundlePath(execPath: string = process.execPath): string | null {
  const bundlePath = resolve(dirname(execPath), '..', '..')
  return bundlePath.endsWith('.app') && existsSync(join(bundlePath, 'Contents', 'Info.plist'))
    ? bundlePath
    : null
}

async function detectStrategy(bundlePath: string): Promise<MacUpdateInstallStrategy> {
  try {
    const result = await runProcess({
      program: '/usr/bin/codesign',
      args: ['-dv', '--verbose=2', bundlePath],
      timeoutMs: CODESIGN_TIMEOUT_MS
    })
    const kind = classifyCodesignDisplayOutput(`${result.stdout}\n${result.stderr}`, result.code)
    console.info(`[updater] macOS signature kind: ${kind}`)
    return strategyForSignatureKind(kind)
  } catch {
    return 'squirrel'
  }
}

/** Sync answer when known; null while the one-time codesign probe is still running. */
export function peekMacUpdateInstallStrategy(): MacUpdateInstallStrategy | null {
  if (resolvedStrategy) {
    return resolvedStrategy
  }
  if (process.platform !== 'darwin' || !app.isPackaged) {
    resolvedStrategy = 'squirrel'
    return resolvedStrategy
  }
  const bundlePath = resolveRunningMacAppBundlePath()
  if (!bundlePath) {
    resolvedStrategy = 'squirrel'
    return resolvedStrategy
  }
  return null
}

export function resolveMacUpdateInstallStrategy(): Promise<MacUpdateInstallStrategy> {
  const known = peekMacUpdateInstallStrategy()
  if (known) {
    return Promise.resolve(known)
  }
  if (!pendingStrategy) {
    const bundlePath = resolveRunningMacAppBundlePath()
    pendingStrategy = (
      bundlePath ? detectStrategy(bundlePath) : Promise.resolve('squirrel' as const)
    ).then((strategy) => {
      resolvedStrategy = strategy
      return strategy
    })
  }
  return pendingStrategy
}
