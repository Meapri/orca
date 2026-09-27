// Fault scenarios for the orcad soak harness. Each returns observations and pushes failures
// through `check`; the verdicts about terminals rest on host evidence (PIDs), and the one
// invariant every scenario enforces is ssh-execution-boundary.md's: a terminal whose process
// is still alive on the host is never reported `exited`, whatever happened to contact.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import {
  childCount,
  latestBeat,
  processAlive,
  readGeneratorPid,
  recordedDaemonPids,
  sampleProcess,
  sleep,
  slopePerMinute,
  waitFor
} from './orcad-soak-host.mjs'
import { createStreamResumeScenario } from './orcad-soak-stream-resume.mjs'
import { createE2eeCompressionScenario } from './orcad-soak-e2ee-compression.mjs'

const GENERATORS = ['heartbeat', 'stream', 'tui']

function reportsExited(response) {
  return /"status":"exited"|"exited":true/.test(JSON.stringify(response?.result ?? null))
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    : null
}

function seedRepo(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# orcad soak\n')
  for (const args of [
    ['init', '-b', 'main'],
    ['add', '-A'],
    ['-c', 'user.email=soak@orca.test', '-c', 'user.name=Orca Soak', 'commit', '-m', 'seed']
  ]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    }
  }
  return realpathSync(dir)
}

async function mustCall(ctx, args, options) {
  const response = await ctx.control(args, options)
  if (!response.ok) {
    throw new Error(`orca ${args.join(' ')} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result
}

async function ensureWorktree(ctx) {
  if (!ctx.worktreeId) {
    const repoPath = seedRepo(join(ctx.root, 'repo'))
    const repo = (await mustCall(ctx, ['repo', 'add', '--path', repoPath])).repo
    const listed = await mustCall(ctx, ['worktree', 'list', '--repo', `id:${repo.id}`])
    const main = (listed.worktrees ?? []).find((worktree) => worktree.path === repoPath)
    if (!main) {
      throw new Error(`repo ${repo.id} listed no main worktree at ${repoPath}`)
    }
    ctx.worktreeId = main.id
  }
}

export async function createLoad(ctx) {
  await ensureWorktree(ctx)
  ctx.terminals = {}
  for (const name of [...GENERATORS, 'echo']) {
    const created = await mustCall(ctx, ['terminal', 'create', '--worktree', ctx.worktreeId])
    ctx.terminals[name] = created.terminal.handle
    const command = name === 'echo' ? 'cat' : `"${process.execPath}" "${ctx.generators[name]}"`
    await mustCall(ctx, [
      'terminal',
      'send',
      '--terminal',
      created.terminal.handle,
      '--text',
      command,
      '--enter'
    ])
  }
  const started = await waitFor(
    () => GENERATORS.every((name) => processAlive(readGeneratorPid(ctx.generatorsDir, name))),
    30_000,
    250
  )
  if (!started) {
    throw new Error('load generators did not start inside their terminals')
  }
  ctx.generatorPids = Object.fromEntries(
    GENERATORS.map((name) => [name, readGeneratorPid(ctx.generatorsDir, name)])
  )
}

export function generatorsAlive(ctx) {
  return Object.fromEntries(
    Object.entries(ctx.generatorPids).map(([name, pid]) => [name, processAlive(pid)])
  )
}

async function heartbeat(ctx, via = 'control') {
  const read = await ctx[via](['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
  return latestBeat(read)
}

async function beatAdvances(ctx, since, timeoutMs, via = 'control') {
  let latest = since
  const advanced = await waitFor(
    async () => {
      latest = (await heartbeat(ctx, via)) ?? latest
      return latest !== null && (since === null || latest > since)
    },
    timeoutMs,
    500
  )
  return { advanced, latest }
}

/** The invariant: host-alive terminals are never reported exited. */
async function assertNoFalseExit(ctx, check, label) {
  const listed = await ctx.control(['terminal', 'list'])
  const alive = generatorsAlive(ctx)
  const statuses = {}
  for (const name of GENERATORS) {
    const read = await ctx.control(['terminal', 'read', '--terminal', ctx.terminals[name]])
    statuses[name] = read.result?.terminal?.status ?? read.error?.code ?? 'unknown'
    if (alive[name]) {
      check(
        statuses[name] !== 'exited',
        `${label}: ${name} is alive on the host but reported exited`
      )
      check(
        (listed.result?.terminals ?? []).some(
          (terminal) => terminal.handle === ctx.terminals[name]
        ),
        `${label}: ${name} is alive on the host but missing from terminal list`
      )
    }
  }
  return { alive, statuses }
}

async function restartAndAdopt(ctx, check, daemonBefore) {
  const readiness = await ctx.restartOrcad()
  const daemonAfter = readiness.health?.terminalDaemon?.pid ?? null
  check(
    daemonAfter === daemonBefore,
    `daemon was replaced (${daemonBefore} -> ${daemonAfter}), not adopted`
  )
  return {
    readyMs: ctx.orcad.readyMs,
    daemonAfter,
    daemonState: readiness.health?.terminalDaemon?.state
  }
}

export const SCENARIOS = {
  async boot(ctx, check) {
    const daemon = ctx.orcad.readiness.health?.terminalDaemon
    check(daemon?.state === 'live', `daemon state is ${daemon?.state}`)
    check(daemon?.selfTest?.ok === true, `PTY self-test: ${daemon?.selfTest?.verdict}`)
    return {
      readyMs: ctx.orcad.readyMs,
      daemonPid: daemon?.pid,
      cgroupUnit: daemon?.cgroupUnit ?? null,
      selfTest: daemon?.selfTest
    }
  },

  async load(ctx, check) {
    await createLoad(ctx)
    const first = await heartbeat(ctx, 'remote')
    const { advanced, latest } = await beatAdvances(ctx, first, 10_000, 'remote')
    check(advanced, 'heartbeat did not advance through the remote client')
    return { terminals: ctx.terminals, generatorPids: ctx.generatorPids, beats: [first, latest] }
  },

  async 'kill9-orcad'(ctx, check) {
    const daemonBefore = ctx.orcad.readiness.health.terminalDaemon.pid
    const beatBefore = await heartbeat(ctx)
    ctx.orcad.signal('SIGKILL')
    const exit = await ctx.orcad.waitExit(10_000)
    check(exit !== null, 'orcad survived SIGKILL')
    await sleep(1_000)
    check(processAlive(daemonBefore), 'the terminal daemon died with orcad')
    const aliveDuringOutage = generatorsAlive(ctx)
    for (const [name, alive] of Object.entries(aliveDuringOutage)) {
      check(alive, `${name} PTY process died with orcad`)
    }
    const adoption = await restartAndAdopt(ctx, check, daemonBefore)
    const { advanced, latest } = await beatAdvances(ctx, beatBefore, 15_000)
    check(advanced, 'heartbeat did not advance after re-adoption')
    const invariant = await assertNoFalseExit(ctx, check, 'after kill -9')
    return { exit, aliveDuringOutage, ...adoption, beats: [beatBefore, latest], ...invariant }
  },

  async 'daemon-freeze'(ctx, check) {
    // SIGSTOP: orcad loses contact with a daemon whose PTYs are all still alive.
    const daemonPid = ctx.orcad.readiness.health.terminalDaemon.pid
    const beatBefore = await heartbeat(ctx)
    process.kill(daemonPid, 'SIGSTOP')
    const frozenAt = Date.now()
    let during
    try {
      during = await Promise.all([
        ctx.control(['terminal', 'list'], { timeoutMs: 90_000 }),
        ctx.control(['terminal', 'read', '--terminal', ctx.terminals.heartbeat], {
          timeoutMs: 90_000
        })
      ])
    } finally {
      process.kill(daemonPid, 'SIGCONT')
    }
    const frozenMs = Date.now() - frozenAt
    for (const response of during) {
      check(!reportsExited(response), 'a terminal was reported exited while only contact was lost')
      check(!response.timedOut, 'a request hung past 90s against a frozen daemon')
    }
    const { advanced, latest } = await beatAdvances(ctx, beatBefore, 20_000)
    check(advanced, 'heartbeat did not resume after SIGCONT')
    const invariant = await assertNoFalseExit(ctx, check, 'after daemon freeze')
    return {
      frozenMs,
      duringFreeze: during.map((response) => ({
        ok: response.ok,
        ms: response.durationMs,
        error: response.error?.code ?? null
      })),
      beats: [beatBefore, latest],
      ...invariant
    }
  },

  async 'sigterm-timing'(ctx, check) {
    const daemonBefore = ctx.orcad.readiness.health.terminalDaemon.pid
    ctx.orcad.signal('SIGTERM')
    const exit = await ctx.orcad.waitExit(25_000)
    check(exit !== null, 'orcad did not exit within 25s of SIGTERM')
    check(exit?.code === 0, `SIGTERM exit code ${exit?.code} (signal ${exit?.signal})`)
    check((exit?.ms ?? Infinity) <= 17_000, `graceful stop took ${exit?.ms}ms (deadline 15s)`)
    check(processAlive(daemonBefore), 'the terminal daemon died on graceful stop')
    const adoption = await restartAndAdopt(ctx, check, daemonBefore)
    const invariant = await assertNoFalseExit(ctx, check, 'after SIGTERM restart')
    return { exit, ...adoption, ...invariant }
  },

  async 'restart-while-connected'(ctx, check) {
    const daemonBefore = ctx.orcad.readiness.health.terminalDaemon.pid
    const raw = net.connect(ctx.proxy.port, '127.0.0.1')
    const rawState = { head: '', closedAt: null }
    raw.on('data', (chunk) => {
      rawState.head ||= chunk.toString('latin1').split('\r\n')[0]
    })
    raw.on('close', () => {
      rawState.closedAt = Date.now()
    })
    raw.on('error', () => {})
    raw.write(
      'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    )
    const inflight = [
      ctx.remote(
        [
          'terminal',
          'wait',
          '--terminal',
          ctx.terminals.heartbeat,
          '--for',
          'exit',
          '--timeout-ms',
          '60000'
        ],
        { timeoutMs: 120_000 }
      ),
      ctx.remote(
        [
          'terminal',
          'wait',
          '--terminal',
          ctx.terminals.echo,
          '--for',
          'exit',
          '--timeout-ms',
          '60000'
        ],
        { timeoutMs: 120_000 }
      )
    ]
    await sleep(2_000)
    const stoppedAt = Date.now()
    ctx.orcad.signal('SIGTERM')
    const exit = await ctx.orcad.waitExit(25_000)
    const adoption = await restartAndAdopt(ctx, check, daemonBefore)
    const settled = await Promise.all(inflight)
    for (const response of settled) {
      check(!response.timedOut, 'an in-flight client hung across the restart')
      check(!reportsExited(response), 'an in-flight wait reported exit for a live terminal')
    }
    await waitFor(() => rawState.closedAt !== null, 20_000)
    check(rawState.closedAt !== null, 'a connected socket was left half-open across the restart')
    raw.destroy()
    const after = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
    check(after.ok, `remote read failed after restart: ${JSON.stringify(after.error)}`)
    return {
      exit,
      ...adoption,
      inflight: settled.map((response) => ({
        ok: response.ok,
        error: response.error?.code ?? null,
        returnedMsAfterStop: response.durationMs - 2_000
      })),
      rawSocket: {
        firstLine: rawState.head,
        closedMsAfterStop: rawState.closedAt && rawState.closedAt - stoppedAt
      }
    }
  },

  async 'network-latency'(ctx, check) {
    ctx.proxy.setMode({ kind: 'latency', latencyMs: 250, jitterMs: 50 })
    const durations = []
    try {
      for (let index = 0; index < 8; index += 1) {
        const read = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
        check(read.ok, `remote read failed under latency: ${JSON.stringify(read.error)}`)
        durations.push(read.durationMs)
      }
    } finally {
      ctx.proxy.setMode({ kind: 'pass' })
    }
    return { p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), durations }
  },

  async 'network-partition'(ctx, check) {
    const seconds = ctx.options.partitionSeconds
    ctx.proxy.setMode({ kind: 'partition' })
    const startedAt = Date.now()
    const remoteCalls = [
      ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat], {
        timeoutMs: 180_000
      }),
      ctx.remote(
        [
          'terminal',
          'wait',
          '--terminal',
          ctx.terminals.heartbeat,
          '--for',
          'exit',
          '--timeout-ms',
          '5000'
        ],
        { timeoutMs: 180_000 }
      )
    ]
    const controlDuring = await ctx.control([
      'terminal',
      'read',
      '--terminal',
      ctx.terminals.heartbeat
    ])
    check(
      controlDuring.ok,
      'the local control plane failed while only the client link was partitioned'
    )
    const invariantDuring = await assertNoFalseExit(ctx, check, 'during partition')
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - startedAt)))
    ctx.proxy.setMode({ kind: 'pass' })
    const healedAt = Date.now()
    const settled = await Promise.all(remoteCalls)
    for (const response of settled) {
      check(!response.timedOut, 'a remote call hung after the partition healed')
      check(
        !reportsExited(response),
        'a remote call reported exit because the link was partitioned'
      )
    }
    const after = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
    check(after.ok, `remote read failed after heal: ${JSON.stringify(after.error)}`)
    return {
      partitionMs: healedAt - startedAt,
      remote: settled.map((response) => ({
        ok: response.ok,
        error: response.error?.code ?? null,
        settledMsAfterHeal: startedAt + response.durationMs - healedAt
      })),
      controlDuringMs: controlDuring.durationMs,
      ...invariantDuring
    }
  },

  async 'network-reset'(ctx, check) {
    ctx.proxy.setMode({ kind: 'reset' })
    let during
    try {
      during = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat], {
        timeoutMs: 60_000
      })
    } finally {
      ctx.proxy.setMode({ kind: 'pass' })
    }
    check(!during.ok, 'a remote call succeeded through a resetting link')
    check(during.durationMs < 15_000, `a reset link took ${during.durationMs}ms to fail`)
    const after = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
    check(after.ok, 'remote read failed after the link recovered')
    return { failedInMs: during.durationMs, error: during.error?.code ?? null }
  },

  async 'daemon-kill'(ctx, check, warn) {
    const daemonPid = ctx.orcad.readiness.health.terminalDaemon.pid
    const before = { ...ctx.generatorPids }
    process.kill(daemonPid, 'SIGKILL')
    const ptysEnded = await waitFor(
      () => Object.values(before).every((pid) => !processAlive(pid)),
      15_000
    )
    const statuses = {}
    for (const name of GENERATORS) {
      const read = await ctx.control(['terminal', 'read', '--terminal', ctx.terminals[name]])
      statuses[name] = read.result?.terminal?.status ?? read.error?.code ?? 'unknown'
      if (processAlive(before[name])) {
        check(statuses[name] !== 'exited', `${name} reported exited while its process is alive`)
      }
    }
    const oldHandles = { ...ctx.terminals }
    await createLoad(ctx)
    const respawned = recordedDaemonPids(ctx.dataRoot).find(
      (pid) => pid !== daemonPid && processAlive(pid)
    )
    check(Boolean(respawned), 'no replacement daemon is serving after the daemon was killed')
    check(
      Object.values(generatorsAlive(ctx)).every(Boolean),
      'fresh terminals did not start after daemon death'
    )
    const statusesAfterRespawn = {}
    for (const name of GENERATORS) {
      const read = await ctx.control(['terminal', 'read', '--terminal', oldHandles[name]])
      statusesAfterRespawn[name] = read.result?.terminal?.status ?? read.error?.code ?? 'unknown'
      // Not the forbidden direction, but a host-verified exit reported as running is stale.
      if (!processAlive(before[name]) && statusesAfterRespawn[name] === 'running') {
        warn(`${name}'s process exited with the daemon, yet its terminal still reads running`)
      }
    }
    return {
      killedDaemon: daemonPid,
      ptysEndedWithDaemon: ptysEnded,
      oldStatuses: statuses,
      statusesAfterRespawn,
      respawned
    }
  },

  async soak(ctx, check) {
    const durationMs = ctx.options.durationSeconds * 1000
    const daemonPid = () =>
      recordedDaemonPids(ctx.dataRoot).find((pid) => processAlive(pid)) ?? null
    const startedAt = Date.now()
    const samples = []
    let reads = 0
    let failedReads = 0
    let nextSample = 0
    while (Date.now() - startedAt < durationMs) {
      const read = await ctx.remote(['terminal', 'read', '--terminal', ctx.terminals.heartbeat])
      reads += 1
      failedReads += read.ok ? 0 : 1
      if (Date.now() >= nextSample) {
        const daemon = daemonPid()
        samples.push({
          t: Date.now() - startedAt,
          orcad: sampleProcess(ctx.orcad.pid),
          daemon: daemon
            ? { pid: daemon, ...sampleProcess(daemon), ptys: childCount(daemon) }
            : null,
          proxyConnections: ctx.proxy.liveConnections
        })
        nextSample = Date.now() + ctx.options.sampleSeconds * 1000
      }
      await sleep(1_000)
    }
    ctx.report.samples.push(...samples)
    const series = (pick) => samples.map((sample) => ({ t: sample.t, value: pick(sample) }))
    const growth = {
      orcadRssMbPerMin: slopePerMinute(series((s) => (s.orcad?.rssKb ?? Number.NaN) / 1024)),
      orcadFdsPerMin: slopePerMinute(series((s) => s.orcad?.fds ?? Number.NaN)),
      daemonRssMbPerMin: slopePerMinute(series((s) => (s.daemon?.rssKb ?? Number.NaN) / 1024)),
      daemonFdsPerMin: slopePerMinute(series((s) => s.daemon?.fds ?? Number.NaN))
    }
    const first = samples[0]
    const last = samples.at(-1)
    const fdDelta = (last?.orcad?.fds ?? 0) - (first?.orcad?.fds ?? 0)
    check(failedReads === 0, `${failedReads}/${reads} remote reads failed with no fault injected`)
    check(fdDelta <= ctx.options.maxFdGrowth, `orcad grew ${fdDelta} descriptors over the soak`)
    // Short runs are dominated by warm-up; only judge slopes over a long enough window.
    const judged = durationMs >= 10 * 60_000
    if (judged) {
      check(
        (growth.orcadRssMbPerMin ?? 0) <= ctx.options.maxRssMbPerMin,
        `orcad RSS grew ${growth.orcadRssMbPerMin?.toFixed(2)} MB/min`
      )
      check(
        (growth.daemonRssMbPerMin ?? 0) <= ctx.options.maxRssMbPerMin,
        `daemon RSS grew ${growth.daemonRssMbPerMin?.toFixed(2)} MB/min`
      )
    }
    return {
      durationMs: Date.now() - startedAt,
      reads,
      failedReads,
      fdDelta,
      growth,
      slopesJudged: judged,
      samples: samples.length
    }
  }
}

SCENARIOS['stream-resume'] = createStreamResumeScenario({ ensureWorktree, mustCall })
SCENARIOS['e2ee-compression'] = createE2eeCompressionScenario({ ensureWorktree })

export const SCENARIO_ORDER = Object.keys(SCENARIOS)
