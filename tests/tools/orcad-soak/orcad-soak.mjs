#!/usr/bin/env node
/**
 * Soak and chaos harness for a built orcad (`pnpm build:orcad && pnpm build:cli`).
 *
 * Boots orcad on an isolated data root, drives terminal load (heartbeat, throughput stream,
 * full-screen redraw, cat echo) through a paired client routed via an in-process TCP fault
 * proxy, then injects faults: kill -9 orcad, a frozen daemon (lost contact, live PTYs), SIGTERM
 * stop timing, restart under connected clients, link latency / partition / reset, daemon death,
 * and a long run sampling RSS and descriptors. Writes a machine-readable JSON report and exits
 * non-zero when any scenario fails.
 *
 *   node tests/tools/orcad-soak/orcad-soak.mjs [--duration 60] [--scenarios boot,load,soak]
 *     [--orcad-dir out/orcad] [--report out/orcad-soak/report.json] [--partition-seconds 20]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { TcpFaultProxy } from './tcp-fault-proxy.mjs'
import {
  OrcaCli,
  OrcadUnderTest,
  processAlive,
  recordedDaemonPids,
  sleep,
  writeGenerators
} from './orcad-soak-host.mjs'
import { SCENARIOS, SCENARIO_ORDER } from './orcad-soak-scenarios.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function log(message) {
  process.stderr.write(`[orcad-soak] ${message}\n`)
}

const options = {
  orcadDir: resolve(option('orcad-dir', join(ROOT, 'out', 'orcad'))),
  cliPath: resolve(option('cli', join(ROOT, 'out', 'cli', 'index.js'))),
  durationSeconds: Number(option('duration', '60')),
  sampleSeconds: Number(option('sample-seconds', '5')),
  partitionSeconds: Number(option('partition-seconds', '20')),
  streamBytesPerSecond: Number(option('stream-bytes-per-second', String(512 * 1024))),
  maxFdGrowth: Number(option('max-fd-growth', '32')),
  maxRssMbPerMin: Number(option('max-rss-mb-per-min', '8')),
  port: Number(option('port', String(20_000 + Math.floor(Math.random() * 20_000)))),
  scenarios: option('scenarios', SCENARIO_ORDER.join(',')).split(',').filter(Boolean),
  report: resolve(
    option(
      'report',
      join(
        ROOT,
        'out',
        'orcad-soak',
        `orcad-soak-${new Date().toISOString().replaceAll(':', '-')}.json`
      )
    )
  ),
  keep: process.argv.includes('--keep')
}

async function main() {
  const unknown = options.scenarios.filter((name) => !SCENARIOS[name])
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenarios: ${unknown.join(', ')} (known: ${SCENARIO_ORDER.join(', ')})`
    )
  }
  // Short root: the data root holds a unix socket, and macOS caps socket paths at 104 bytes.
  const root = mkdtempSync(join(tmpdir(), 'osk-'))
  const dataRoot = join(root, 'data')
  const generatorsDir = join(root, 'gen')
  mkdirSync(dataRoot)
  mkdirSync(generatorsDir)
  const report = {
    schemaVersion: 1,
    tool: 'orcad-soak',
    startedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus().length
    },
    orcad: {
      dir: options.orcadDir,
      version: readFileSync(join(options.orcadDir, '.version'), 'utf8').trim()
    },
    options: { ...options, report: undefined },
    scenarios: [],
    samples: []
  }
  const proxy = new TcpFaultProxy({ targetPort: options.port })
  await proxy.start()
  const cli = new OrcaCli({ cliPath: options.cliPath, dataRoot })
  const ctx = {
    root,
    dataRoot,
    generatorsDir,
    generators: writeGenerators(generatorsDir, options),
    options,
    proxy,
    report,
    orcad: null,
    control: (args, callOptions) => cli.call(args, callOptions),
    remote: (args, callOptions) =>
      cli.call(args, { ...callOptions, pairingCode: ctx.orcad.pairingCode })
  }
  ctx.restartOrcad = async () => {
    ctx.orcad = new OrcadUnderTest({
      orcadDir: options.orcadDir,
      dataRoot,
      port: options.port,
      pairingAddress: `127.0.0.1:${proxy.port}`,
      logPath: join(root, 'orcad.stderr.log')
    })
    const readiness = await ctx.orcad.start()
    proxy.retarget(ctx.orcad.boundPort)
    return readiness
  }

  let exitCode = 0
  try {
    log(`orcad ${report.orcad.version} on port ${options.port}, proxy ${proxy.port}, root ${root}`)
    await ctx.restartOrcad()
    for (const name of options.scenarios) {
      const failures = []
      const warnings = []
      const check = (condition, message) => {
        if (!condition) {
          failures.push(message)
        }
      }
      const warn = (message) => warnings.push(message)
      const startedAt = Date.now()
      let observations = null
      log(`scenario ${name}`)
      try {
        observations = await SCENARIOS[name](ctx, check, warn)
      } catch (error) {
        failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      const status = failures.length === 0 ? 'pass' : 'fail'
      report.scenarios.push({
        name,
        status,
        durationMs: Date.now() - startedAt,
        failures,
        warnings,
        observations
      })
      log(`  ${status}${[...failures, ...warnings].map((line) => `\n    ${line}`).join('')}`)
      if (status === 'fail') {
        exitCode = 1
      }
      // A scenario that left orcad down would cascade into every later one.
      if (!ctx.orcad.pid || !processAlive(ctx.orcad.pid)) {
        log('  orcad is down; restarting before the next scenario')
        await ctx.restartOrcad().catch((error) => log(`  restart failed: ${error.message}`))
      }
    }
  } finally {
    await teardown(ctx)
    report.finishedAt = new Date().toISOString()
    report.summary = {
      passed: report.scenarios.filter((scenario) => scenario.status === 'pass').length,
      failed: report.scenarios.filter((scenario) => scenario.status === 'fail').length,
      warnings: report.scenarios.reduce((total, scenario) => total + scenario.warnings.length, 0)
    }
    mkdirSync(dirname(options.report), { recursive: true })
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
    log(
      `report: ${options.report} (${report.summary.passed} passed, ${report.summary.failed} failed)`
    )
    if (!options.keep) {
      rmSync(root, { recursive: true, force: true })
    }
  }
  process.exitCode = exitCode
}

/** Stop everything this run started: orcad, then every daemon recorded under its own root. */
async function teardown(ctx) {
  ctx.orcad?.signal('SIGTERM')
  await ctx.orcad?.waitExit(20_000)
  ctx.orcad?.signal('SIGKILL')
  for (const pid of recordedDaemonPids(ctx.dataRoot)) {
    if (processAlive(pid)) {
      process.kill(pid, 'SIGTERM')
    }
  }
  await sleep(2_000)
  for (const pid of [
    ...recordedDaemonPids(ctx.dataRoot),
    ...Object.values(ctx.generatorPids ?? {})
  ]) {
    if (processAlive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  await ctx.proxy.close()
}

await main()
