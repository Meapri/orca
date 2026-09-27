// Drives config/orcad-host/orcad-install.sh end to end against fake orcad bundles and a fake
// systemctl: checksum refusal, health-gated activation, census-gated stops, snapshot-backed
// upgrade/rollback, and uninstall. The policy verbs are the real bundled host-install code.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleHostInstallPolicy, sha256File } from './pack-orcad-release.mjs'
import {
  ORCAD_INSTALLER as INSTALLER,
  packFakeOrcadRelease
} from './orcad-host-install-test-fixture.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
// Ubuntu's /bin/sh is dash; set this to exercise another POSIX shell elsewhere.
const INSTALL_SHELL = process.env.ORCAD_INSTALL_TEST_SHELL ?? '/bin/sh'
const FAKE_SYSTEMCTL = join(ROOT, 'tests/tools/orcad-soak/fake-systemctl.sh')
const EMPTY_CENSUS = JSON.stringify({
  ok: true,
  result: { terminals: [], truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } }
})
const LIVE_CENSUS = EMPTY_CENSUS.replace('"terminals":[]', '"terminals":[{"handle":"term_1"}]')

describe.skipIf(process.platform === 'win32')('orcad-install.sh', () => {
  let root
  let env
  let censusFile
  let daemonPid
  const tarballs = {}

  function makeRelease(version, options = {}) {
    return packFakeOrcadRelease(root, version, {
      policyBundle: join(root, 'policy.js'),
      ...options
    })
  }

  function install(...args) {
    const result = spawnSync(INSTALL_SHELL, [INSTALLER, ...args], {
      env,
      encoding: 'utf8',
      timeout: 90_000
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  const base = () => env.ORCAD_BASE
  const record = () => JSON.parse(readFileSync(join(base(), 'orcad-active.json'), 'utf8'))
  const current = () => readlinkSync(join(base(), 'orcad-current'))

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'oih-'))
    await bundleHostInstallPolicy(join(root, 'policy.js'))
    censusFile = join(root, 'census.json')
    writeFileSync(censusFile, EMPTY_CENSUS)
    mkdirSync(join(root, 'home'))
    env = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      ORCAD_BASE: join(root, 'base'),
      ORCA_USER_DATA: join(root, 'data'),
      ORCAD_SERVICE: 'user',
      ORCAD_SYSTEMCTL: FAKE_SYSTEMCTL,
      FAKE_SYSTEMCTL_STATE: join(root, 'svc'),
      FAKE_SYSTEMCTL_EXEC: `${INSTALL_SHELL} ${join(root, 'base', 'orcad-current', 'deploy', 'orcad-install.sh')} run`,
      ORCAD_READINESS_FILE: join(root, 'run', 'readiness.json'),
      ORCAD_READY_TIMEOUT: '20',
      ORCAD_CENSUS_COMMAND: `cat ${censusFile}`
    }
    mkdirSync(env.ORCA_USER_DATA)
    tarballs.a = makeRelease('9.0.0+a1')
    tarballs.b = makeRelease('9.0.0+b2')
    tarballs.bad = makeRelease('9.0.0+c3', { daemonState: 'degraded', writesState: false })
  }, 120_000)

  afterAll(() => {
    spawnSync('/bin/sh', [FAKE_SYSTEMCTL, '--user', 'stop', 'orcad.service'], { env })
    try {
      process.kill(daemonPid, 'SIGKILL')
    } catch {
      // Already retired by uninstall.
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a tarball without a checksum, with a wrong one, or with foreign entries', () => {
    const bare = join(root, 'bare.tar.gz')
    copyFileSync(tarballs.a, bare)
    expect(install('install', bare)).toMatchObject({ status: 1 })
    expect(install('install', tarballs.a, '--sha256', '0'.repeat(64)).output).toContain(
      'checksum mismatch'
    )
    const hostile = join(root, 'hostile.tar.gz')
    writeFileSync(join(root, 'stray'), 'x')
    spawnSync('tar', [
      '-C',
      join(root, 'stage', '9.0.0+a1'),
      '-czf',
      hostile,
      'orcad-9.0.0+a1',
      '-C',
      root,
      'stray'
    ])
    const hostileResult = install('install', hostile, '--sha256', sha256File(hostile))
    expect(hostileResult.status).toBe(1)
    expect(hostileResult.output).toContain('entries outside')
    expect(existsSync(join(base(), 'orcad-9.0.0+a1'))).toBe(false)
  })

  it('installs idempotently and activates the first version behind the health gate', () => {
    expect(install('install', tarballs.a)).toMatchObject({ status: 0 })
    expect(install('install', tarballs.a).output).toContain('already installed')
    expect(install('service-install', '--port', '6799')).toMatchObject({ status: 0 })
    const unit = readFileSync(join(env.XDG_CONFIG_HOME, 'systemd/user/orcad.service'), 'utf8')
    expect(unit).not.toMatch(/@[A-Z_]+@/)
    expect(unit).toContain(`ExecStart=/bin/sh ${base()}/orcad-current/deploy/orcad-install.sh run`)
    expect(unit).toMatch(/^RestartPreventExitStatus=78$/m)
    expect(unit).toMatch(/^KillMode=mixed$/m)
    expect(unit).toMatch(/^#Type=notify$/m)
    expect(readFileSync(join(env.XDG_CONFIG_HOME, 'orcad/orcad.env'), 'utf8')).toContain(
      'ORCAD_BIND=127.0.0.1\nORCAD_PORT=6799'
    )
    // A readiness dir left permissive by an older install is tightened before the line is written.
    mkdirSync(dirname(env.ORCAD_READINESS_FILE), { recursive: true, mode: 0o755 })
    chmodSync(dirname(env.ORCAD_READINESS_FILE), 0o755)
    writeFileSync(env.ORCAD_READINESS_FILE, 'stale', { mode: 0o644 })
    const activated = install('activate', '9.0.0+a1')
    expect(activated.output).toContain('is active')
    // The readiness line carries a pairing credential.
    expect(statSync(dirname(env.ORCAD_READINESS_FILE)).mode & 0o777).toBe(0o700)
    expect(statSync(env.ORCAD_READINESS_FILE).mode & 0o777).toBe(0o600)
    expect(readFileSync(env.ORCAD_READINESS_FILE, 'utf8')).toContain('orca_server_ready')
    expect(unit).toMatch(/^RuntimeDirectoryMode=0700$/m)
    expect(unit).toMatch(/^#NotifyAccess=all$/m)
    expect(record()).toMatchObject({ active: '9.0.0+a1', previous: null })
    expect(current()).toBe('orcad-9.0.0+a1')
  }, 60_000)

  it('refuses to stop a service whose unverified daemon owns live terminals, even with --force', () => {
    // Reparented to init so its exit is reaped promptly and kill(pid, 0) can observe it.
    daemonPid = Number(
      spawnSync('/bin/sh', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], {
        encoding: 'utf8'
      }).stdout.trim()
    )
    mkdirSync(join(env.ORCA_USER_DATA, 'daemon'), { recursive: true })
    writeFileSync(
      join(env.ORCA_USER_DATA, 'daemon', 'daemon-v36.pid'),
      JSON.stringify({
        pid: daemonPid,
        entryPath: join(base(), 'orcad-9.0.0+a1', 'daemon-entry.js')
      })
    )
    writeFileSync(censusFile, LIVE_CENSUS)
    const refused = install('upgrade', tarballs.b, '--force')
    expect(refused.status).toBe(20)
    expect(refused.output).toContain('--force does not override this')
    expect(record().active).toBe('9.0.0+a1')
    expect(current()).toBe('orcad-9.0.0+a1')
  }, 60_000)

  it('upgrades once the census is empty, snapshotting the state it replaces', () => {
    writeFileSync(censusFile, EMPTY_CENSUS)
    expect(install('upgrade', tarballs.b)).toMatchObject({ status: 0 })
    expect(record()).toMatchObject({ active: '9.0.0+b2', previous: '9.0.0+a1' })
    expect(record().snapshot).toMatchObject({ readableByVersion: '9.0.0+a1' })
    expect(readFileSync(join(env.ORCA_USER_DATA, 'orca-profile-index.json'), 'utf8')).toContain(
      '9.0.0+b2'
    )
    // The version the live daemon was forked from survives pruning.
    expect(existsSync(join(base(), 'orcad-9.0.0+a1'))).toBe(true)
  }, 60_000)

  it('rejects an unhealthy candidate and restores the incumbent when state is unchanged', () => {
    const rejected = install('upgrade', tarballs.bad, '--force')
    expect(rejected.status).toBe(30)
    expect(rejected.output).toContain('degraded')
    expect(rejected.output).toContain('restored 9.0.0+b2')
    expect(record().active).toBe('9.0.0+b2')
    expect(current()).toBe('orcad-9.0.0+b2')
  }, 90_000)

  it('rolls back to the previous version and restores its pre-activation state', () => {
    const rolledBack = install('rollback')
    expect(rolledBack.output).toContain('rolled back to orcad 9.0.0+a1')
    expect(record()).toMatchObject({ active: '9.0.0+a1', previous: null, snapshot: null })
    expect(current()).toBe('orcad-9.0.0+a1')
    expect(install('rollback')).toMatchObject({ status: 20 })
  }, 60_000)

  it('uninstall refuses while terminals are live, then removes versions but keeps data', () => {
    writeFileSync(censusFile, LIVE_CENSUS)
    expect(install('uninstall')).toMatchObject({ status: 20 })
    expect(existsSync(join(base(), 'orcad-current'))).toBe(true)
    writeFileSync(censusFile, EMPTY_CENSUS)
    expect(install('uninstall')).toMatchObject({ status: 0 })
    expect(existsSync(join(base(), 'orcad-current'))).toBe(false)
    expect(existsSync(join(base(), 'orcad-9.0.0+a1'))).toBe(false)
    expect(existsSync(join(env.ORCA_USER_DATA, 'orca-profile-index.json'))).toBe(true)
    // The recorded daemon was retired as part of decommissioning.
    expect(() => process.kill(daemonPid, 0)).toThrow()
  }, 60_000)
})
