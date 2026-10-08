#!/usr/bin/env node
/**
 * The packaged path end to end: install a release tarball with orcad-install.sh, run it as
 * a systemd *user* service, put live terminals on it, restart the unit with plain systemctl,
 * and check the terminals and their daemon survived. Then prove uninstall refuses while
 * those terminals are live and succeeds once they are closed.
 *
 * On Linux with a user manager this drives the real `systemctl --user` and requires the
 * daemon to be `isolated`. Elsewhere it uses tests/tools/orcad-soak/fake-systemctl.sh and
 * only exercises the installer flow (no cgroups exist to isolate anything).
 *
 *   node tests/tools/orcad-soak/orcad-service-restart-case.mjs --tarball out/orcad-release/orcad-<v>-<target>.tar.gz
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  OrcaCli,
  processAlive,
  recordedDaemonPids,
  waitFor,
  writeGenerators
} from './orcad-soak-host.mjs'
import { createLoad, generatorsAlive } from './orcad-soak-scenarios.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')
const INSTALLER = join(ROOT, 'config/orcad-host/orcad-install.sh')
const UNIT = 'orcad-soak.service'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function realUserManager() {
  return (
    process.platform === 'linux' &&
    spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout.trim() !==
      ''
  )
}

async function main() {
  const tarball = resolve(option('tarball', ''))
  const cliPath = resolve(option('cli', join(ROOT, 'out/cli/index.js')))
  const reportPath = resolve(
    option('report', join(ROOT, 'out/orcad-soak/service-restart-case.json'))
  )
  if (!existsSync(tarball)) {
    throw new Error('--tarball <orcad release tarball> is required (pnpm pack:orcad-release)')
  }
  const root = mkdtempSync(join(tmpdir(), 'osr-'))
  const useRealSystemd = realUserManager()
  const env = {
    ...process.env,
    ORCAD_BASE: join(root, 'base'),
    ORCA_USER_DATA: join(root, 'data'),
    ORCAD_UNIT: UNIT,
    ORCAD_PORT: String(30_000 + Math.floor(Math.random() * 10_000)),
    ORCAD_READY_TIMEOUT: '180',
    ORCAD_CENSUS_COMMAND: `"${process.execPath}" "${cliPath}" terminal list --json`
  }
  if (!useRealSystemd) {
    Object.assign(env, {
      XDG_CONFIG_HOME: join(root, 'config'),
      ORCAD_SYSTEMCTL: join(ROOT, 'tests/tools/orcad-soak/fake-systemctl.sh'),
      FAKE_SYSTEMCTL_STATE: join(root, 'svc'),
      FAKE_SYSTEMCTL_EXEC: `sh ${join(root, 'base/orcad-current/deploy/orcad-install.sh')} run`,
      ORCAD_READINESS_FILE: join(root, 'run/readiness.json')
    })
  }
  const readinessPath =
    env.ORCAD_READINESS_FILE ??
    join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'orcad', 'readiness.json')
  const systemctl = (...args) =>
    spawnSync(env.ORCAD_SYSTEMCTL ?? 'systemctl', ['--user', ...args], { env, encoding: 'utf8' })
  const install = (...args) => {
    const result = spawnSync('sh', [INSTALLER, ...args], {
      env,
      encoding: 'utf8',
      timeout: 300_000
    })
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      output: `${result.stdout}${result.stderr}`.trim()
    }
  }
  const readiness = () => {
    try {
      return JSON.parse(readFileSync(readinessPath, 'utf8').split('\n')[0])
    } catch {
      return null
    }
  }
  const steps = []
  const failures = []
  let isolation = null
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail })
    if (!ok) {
      failures.push(name)
    }
    process.stderr.write(
      `[service-restart] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail ?? null)}`}\n`
    )
  }
  mkdirSync(env.ORCA_USER_DATA, { recursive: true })
  const cli = new OrcaCli({ cliPath, dataRoot: env.ORCA_USER_DATA })
  const generatorsDir = join(root, 'gen')
  mkdirSync(generatorsDir)
  const ctx = {
    root,
    generatorsDir,
    generators: writeGenerators(generatorsDir, { streamBytesPerSecond: 64 * 1024 }),
    control: (args, callOptions) => cli.call(args, callOptions)
  }
  try {
    const installed = install('install', tarball)
    step('install verifies and installs the tarball', installed.status === 0, installed.output)
    const version = installed.stdout.split('\n').at(-1)
    step(
      'service-install writes the unit',
      install('service-install', '--port', env.ORCAD_PORT).status === 0
    )
    const activated = install('activate', version)
    step('activate passes the health gate', activated.status === 0, activated.output)
    const status = install('status').output
    isolation = JSON.parse(/^daemon: (.*)$/m.exec(status)?.[1] ?? '{}')
    if (useRealSystemd) {
      step('the daemon runs in its own scope', isolation.state === 'isolated', isolation)
    }
    await createLoad(ctx)
    const daemonBefore = readiness()?.health?.terminalDaemon?.pid ?? null
    const orcadBefore = readiness()?.health?.pid ?? null
    const restarted = systemctl('restart', UNIT)
    step('systemctl restart succeeds', restarted.status === 0, restarted.stderr)
    const back = await waitFor(
      () => (readiness()?.health?.pid ?? orcadBefore) !== orcadBefore,
      180_000,
      500
    )
    step('the restarted unit publishes readiness', back)
    const survivors = generatorsAlive(ctx)
    const daemonAfter = readiness()?.health?.terminalDaemon?.pid ?? null
    if (useRealSystemd) {
      step(
        'every terminal process survived the unit restart',
        Object.values(survivors).every(Boolean),
        survivors
      )
      step('the restarted orcad adopted the same daemon', daemonAfter === daemonBefore, {
        daemonBefore,
        daemonAfter
      })
    }
    const noop = install('activate', version)
    step(
      're-activating the active version is a no-op',
      noop.status === 0 && noop.output.includes('already active')
    )
    const refused = install('uninstall')
    step('uninstall refuses while terminals are live', refused.status === 20, refused.output)
    const listed = await cli.call(['terminal', 'list'])
    for (const terminal of listed.result?.terminals ?? []) {
      await cli.call(['terminal', 'close', '--terminal', terminal.handle])
    }
    const removed = install('uninstall')
    step('uninstall succeeds once the census is empty', removed.status === 0, removed.output)
    const unitPath = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user', UNIT)
    step('uninstall removed the unit', !existsSync(unitPath))
    const daemonsGone = await waitFor(
      () => recordedDaemonPids(env.ORCA_USER_DATA).every((pid) => !processAlive(pid)),
      20_000
    )
    step('uninstall retired the daemon', daemonsGone)
  } catch (error) {
    step(
      'the case ran to completion',
      false,
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    const report = {
      schemaVersion: 1,
      tool: 'orcad-service-restart-case',
      platform: process.platform,
      realSystemd: useRealSystemd,
      tarball: basename(tarball),
      isolation,
      steps,
      failures
    }
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write(`[service-restart] report: ${reportPath}\n`)
    systemctl('stop', UNIT)
    for (const pid of [
      ...recordedDaemonPids(env.ORCA_USER_DATA),
      ...Object.values(ctx.generatorPids ?? {})
    ]) {
      if (processAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
  process.exitCode = failures.length === 0 ? 0 : 1
}

await main()
