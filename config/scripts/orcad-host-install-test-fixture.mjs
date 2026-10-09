// Fake orcad release tarballs for driving config/orcad-host/orcad-install.sh in tests: every
// declared artifact present, a node-backed shim at the referenced runtime path, and the real
// bundled policy code.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_RUNTIMES_DIRNAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames,
  orcadNodeRuntimeRelativePath
} from '../../src/shared/orcad-artifacts.ts'
import {
  ORCAD_HOST_INSTALL_BUNDLE,
  orcadReleaseTarballName,
  sha256File,
  sha256Line
} from './pack-orcad-release.mjs'

export const ORCAD_INSTALLER = join(
  resolve(import.meta.dirname, '../..'),
  'config/orcad-host/orcad-install.sh'
)

export function orcadInstallHostTarget() {
  const arch = process.arch === 'x64' ? 'x64' : 'arm64'
  if (process.platform !== 'linux') {
    return `${process.platform}-${arch}`
  }
  return `linux-${arch}-${process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'}`
}

function fakeOrcadSource(daemonState, writesState) {
  return `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const buildHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16)
if (${writesState}) fs.writeFileSync(path.join(process.env.ORCA_USER_DATA, 'orca-profile-index.json'), JSON.stringify({ by: process.env.ORCA_VERSION }))
process.stdout.write(JSON.stringify({ type: 'orca_server_ready', runtimeId: 'fake', boundEndpoint: 'ws://127.0.0.1:1',
  advertisedEndpoint: null, pairing: { available: false, reason: 'disabled_by_operator', guidance: '' },
  health: { buildHash, buildVersion: process.env.ORCA_VERSION, pid: process.pid, terminalDaemon: { state: '${daemonState}',
    ownsFreshSessions: true, selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 1 } } } }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`
}

/**
 * Packs `orcad-<version>/` under `root` and writes `<tarball>.sha256` beside it.
 * `policyBundle` is a prebuilt `bundleHostInstallPolicy` output; `tarballName` defaults to the
 * versioned release name.
 */
export function packFakeOrcadRelease(root, version, options) {
  const { policyBundle, daemonState = 'live', writesState = true, tarballName } = options
  const target = orcadInstallHostTarget()
  const stage = join(root, 'stage', version)
  const dir = join(stage, `orcad-${version}`)
  for (const name of orcadArtifactFilenames(target)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), name)
  }
  writeFileSync(join(dir, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
  writeFileSync(join(dir, '.version'), version)
  writeFileSync(join(dir, 'orcad.js'), fakeOrcadSource(daemonState, writesState))
  // The slot names its runtime by digest, so the shim's own hash becomes the marker.
  const shim = `#!/bin/sh\nexec "${process.execPath}" "$@"\n`
  const shimSha256 = createHash('sha256').update(shim).digest('hex')
  writeFileSync(join(dir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), shimSha256)
  const runtime = join(dir, ...orcadNodeRuntimeRelativePath(target, shimSha256))
  mkdirSync(dirname(runtime), { recursive: true })
  writeFileSync(runtime, shim)
  chmodSync(runtime, 0o755)
  copyFileSync(policyBundle, join(dir, ORCAD_HOST_INSTALL_BUNDLE))
  mkdirSync(join(dir, 'deploy'))
  copyFileSync(ORCAD_INSTALLER, join(dir, 'deploy', 'orcad-install.sh'))
  const name = tarballName ?? orcadReleaseTarballName(version, target)
  const tarball = join(root, name)
  const packed = spawnSync(
    'tar',
    ['-C', stage, '-czf', tarball, `orcad-${version}`, ORCAD_RUNTIMES_DIRNAME],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (packed.status !== 0) {
    throw new Error(`tar failed: ${String(packed.stderr)}`)
  }
  writeFileSync(`${tarball}.sha256`, sha256Line(sha256File(tarball), name))
  return tarball
}
