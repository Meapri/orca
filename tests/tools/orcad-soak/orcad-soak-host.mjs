// Host-side primitives for the orcad soak harness: the orcad process under test, the CLI
// client, load generators and resource sampling. Everything here reads the execution host
// directly (PIDs, /proc, ps), so a fault verdict never rests on what orcad itself reports.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../../src/shared/orcad-artifacts.ts'

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** ESRCH is host evidence of exit; EPERM means some process holds the PID. Zombies count as exited. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'EPERM'
  }
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout
  return !stat.trim().startsWith('Z')
}

export async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await sleep(intervalMs)
  }
  return Boolean(await predicate())
}

/** The pinned Node an orcad slot names in `.runtime-node`, at `../runtimes/node-<sha256>/`. */
export function orcadSlotRuntime(orcadDir) {
  const target = readFileSync(join(orcadDir, '.server-target'), 'utf8').trim()
  const sha256 = readFileSync(join(orcadDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), 'utf8').trim()
  return join(orcadDir, ...orcadNodeRuntimeRelativePath(target, sha256))
}

export class OrcadUnderTest {
  constructor({ orcadDir, dataRoot, port, pairingAddress, logPath }) {
    Object.assign(this, { orcadDir, dataRoot, port, pairingAddress, logPath })
    this.child = null
    this.readiness = null
  }

  async start(timeoutMs = 120_000) {
    const log = openSync(this.logPath, 'a')
    const startedAt = Date.now()
    // Detached so harness signals never reach it, as a supervisor-managed process would be.
    this.child = spawn(
      orcadSlotRuntime(this.orcadDir),
      [
        join(this.orcadDir, 'orcad.js'),
        '--json',
        '--bind',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--pairing-address',
        this.pairingAddress
      ],
      {
        env: { ...process.env, ORCA_USER_DATA: this.dataRoot, ORCA_VERSION: 'soak' },
        detached: true,
        stdio: ['ignore', 'pipe', log]
      }
    )
    closeSync(log)
    const child = this.child
    child.exitInfo = null
    child.once('exit', (code, signal) => {
      child.exitInfo = { code, signal, at: Date.now() }
    })
    let buffered = ''
    this.readiness = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`orcad published no readiness in ${timeoutMs}ms`)),
        timeoutMs
      )
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffered += chunk
        const line = buffered
          .split('\n')
          .find((candidate) => candidate.includes('orca_server_ready'))
        if (line) {
          clearTimeout(timer)
          resolvePromise(JSON.parse(line))
        }
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        rejectPromise(new Error(`orcad exited (${code ?? signal}) before readiness`))
      })
    })
    this.readyMs = Date.now() - startedAt
    return this.readiness
  }

  get pid() {
    return this.child?.pid ?? null
  }

  get pairingCode() {
    const url = this.readiness?.pairing?.url
    return url ? new URL(url).searchParams.get('code') : null
  }

  get boundPort() {
    return Number(new URL(this.readiness.boundEndpoint).port)
  }

  signal(name) {
    if (this.pid && processAlive(this.pid)) {
      process.kill(this.pid, name)
    }
  }

  /** Resolve with how the process ended, or null if it outlived the timeout. */
  async waitExit(timeoutMs) {
    const child = this.child
    if (!child) {
      return null
    }
    const started = Date.now()
    await waitFor(() => child.exitInfo !== null || !processAlive(child.pid), timeoutMs, 25)
    if (child.exitInfo === null && processAlive(child.pid)) {
      return null
    }
    const diedAt = Date.now()
    // The PID can read as gone a moment before Node reaps it and reports the exit status.
    await waitFor(() => child.exitInfo !== null, 2_000, 10)
    return { ...(child.exitInfo ?? { code: null, signal: null }), ms: diedAt - started }
  }
}

/** Daemon PIDs recorded under the data root, read from its own PID records. */
export function recordedDaemonPids(dataRoot) {
  const dir = join(dataRoot, 'daemon')
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter((name) => /^daemon-v\d+\.pid$/.test(name))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8')).pid
      } catch {
        return null
      }
    })
    .filter((pid) => Number.isSafeInteger(pid))
}

/** The built CLI, driven either through the local socket or a pairing code. */
export class OrcaCli {
  constructor({ cliPath, dataRoot }) {
    this.cliPath = cliPath
    this.dataRoot = dataRoot
  }

  call(args, { pairingCode = null, timeoutMs = 45_000 } = {}) {
    const startedAt = Date.now()
    const env = { ...process.env, ORCA_USER_DATA_PATH: this.dataRoot }
    delete env.ORCA_PAIRING_CODE
    delete env.ORCA_REMOTE_PAIRING
    const argv = [
      this.cliPath,
      ...args,
      '--json',
      ...(pairingCode ? ['--pairing-code', pairingCode] : [])
    ]
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let timedOut = false
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.resume()
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.on('close', () => {
        clearTimeout(timer)
        let parsed = null
        try {
          parsed = JSON.parse(stdout.trim())
        } catch {
          parsed = null
        }
        resolvePromise({
          ok: parsed?.ok === true,
          result: parsed?.result ?? null,
          error: parsed?.error ?? (timedOut ? { code: 'harness_timeout' } : null),
          timedOut,
          durationMs: Date.now() - startedAt
        })
      })
    })
  }
}

/** Generator programs run inside terminals; each records its PID for host-side liveness checks. */
export function writeGenerators(dir, { streamBytesPerSecond }) {
  const pidPreamble = (name) =>
    `require('node:fs').writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid));\n`
  const programs = {
    heartbeat: [
      pidPreamble('heartbeat'),
      "let beat = 0; setInterval(() => console.log('SOAK_BEAT ' + (++beat)), 250)\n"
    ],
    stream: [
      pidPreamble('stream'),
      "const line = 'orca-soak-stream '.repeat(6) + '\\n'\n",
      `const perTick = Math.max(1, Math.round(${streamBytesPerSecond} / 20 / line.length))\n`,
      'setInterval(() => process.stdout.write(line.repeat(perTick)), 50)\n'
    ],
    tui: [
      pidPreamble('tui'),
      "process.stdout.write('\\x1b[?1049h\\x1b[?25l'); let frame = 0\n",
      'setInterval(() => { frame += 1; let out = "\\x1b[H"\n',
      '  for (let row = 0; row < 20; row += 1) out += "\\x1b[2K|" + String(frame * (row + 1)).padStart(12) + " " + "#".repeat(frame % 40) + "\\n"\n',
      '  process.stdout.write(out) }, 33)\n'
    ]
  }
  const paths = {}
  for (const [name, source] of Object.entries(programs)) {
    paths[name] = join(dir, `${name}.cjs`)
    writeFileSync(paths[name], source.join(''))
  }
  return paths
}

export function readGeneratorPid(dir, name) {
  try {
    return Number(readFileSync(join(dir, `${name}.pid`), 'utf8'))
  } catch {
    return null
  }
}

/** Highest heartbeat seen in a `terminal read` tail. */
export function latestBeat(readResult) {
  const tail = readResult?.result?.terminal?.tail ?? []
  let beat = null
  for (const line of tail) {
    const match = /SOAK_BEAT (\d+)/.exec(String(line))
    if (match) {
      beat = Math.max(beat ?? 0, Number(match[1]))
    }
  }
  return beat
}

/** RSS (KiB) and open descriptor count, or null for an exited process. */
export function sampleProcess(pid) {
  if (!processAlive(pid)) {
    return null
  }
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? Number.NaN)
      return { rssKb, fds: readdirSync(`/proc/${pid}/fd`).length }
    } catch {
      return null
    }
  }
  const rssKb = Number(
    spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  )
  const lsof = spawnSync('lsof', ['-n', '-P', '-p', String(pid), '-F', 'f'], { encoding: 'utf8' })
  const fds = lsof.stdout.split('\n').filter((line) => /^f\d+$/.test(line)).length
  return { rssKb, fds }
}

/** Direct children of a PID (the PTY shells a daemon owns). */
export function childCount(pid) {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout
  return table
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === pid).length
}

/** Least-squares slope in units per minute. */
export function slopePerMinute(points) {
  const usable = points.filter((point) => Number.isFinite(point.value))
  if (usable.length < 3) {
    return null
  }
  const xs = usable.map((point) => point.t / 60_000)
  const ys = usable.map((point) => point.value)
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}
