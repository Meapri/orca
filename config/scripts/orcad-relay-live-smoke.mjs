#!/usr/bin/env node
/**
 * Live smoke for Orca Relay on orcad: a phone reaches a host that has no reachable port.
 *
 * Starts, all on loopback and all throwaway:
 *   - a fake Orca Cloud account API (src/main/orcad/__fixtures__/fake-orca-cloud-api.ts),
 *   - the real relay from cloud/apps/relay in its combined role (SQLite, no Postgres),
 *   - a TLS front for the relay that records every byte it forwards (the relay's view),
 *   - the built orcad with --relay, a throwaway HOME and data root.
 * Then it signs orcad in with `orca serve relay sign-in`, mints `orca serve pairing new --mobile
 * --relay` whose direct endpoint is unroutable, runs the real mobile pairing client against it
 * (mobile/src/transport/relay-pairing-live.test.ts), and asserts the relay only saw ciphertext.
 * Production endpoints are never contacted: every Orca Cloud, relay and push URL is overridden.
 *
 * Needs: `pnpm build:orcad`, the CLI compiled to out/cli, `pnpm install` in cloud/ and mobile/.
 * Usage: node config/scripts/orcad-relay-live-smoke.mjs
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, get as httpsGet } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { startFakeOrcaCloudApi } from '../../src/main/orcad/__fixtures__/fake-orca-cloud-api.ts'

const root = resolve(import.meta.dirname, '../..')
const work = mkdtempSync(join(tmpdir(), 'orcad-relay-smoke-'))
const home = join(work, 'home')
const dataRoot = join(work, 'data')
mkdirSync(home, { recursive: true })
const children = []
const cleanups = []

const startedAt = Date.now()
function log(line) {
  process.stderr.write(`[relay-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}\n`)
}

async function unusedPort() {
  const server = createNetServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

function makeCertificate() {
  const keyPath = join(work, 'key.pem')
  const certPath = join(work, 'cert.pem')
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { encoding: 'utf-8' }
  )
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr}`)
  }
  return {
    keyPath,
    certPath,
    key: readFileSync(keyPath, 'utf-8'),
    cert: readFileSync(certPath, 'utf-8')
  }
}

function startChild(label, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push({ label, child })
  let output = ''
  const onData = (chunk) => {
    output += chunk.toString()
    if (process.env.RELAY_SMOKE_VERBOSE) {
      const stamp = ((Date.now() - startedAt) / 1000).toFixed(1)
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        process.stderr.write(`[${label} +${stamp}s] ${line}\n`)
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  return { child, output: () => output }
}

function waitForOutput(handle, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveWait, reject) => {
    const timer = setInterval(() => {
      const match = pattern.exec(handle.output())
      if (match) {
        clearInterval(timer)
        resolveWait(match)
      } else if (handle.child.exitCode !== null || Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`${label} did not become ready:\n${handle.output().slice(-4000)}`))
      }
    }, 100)
  })
}

/** TLS in front of the relay (it terminates TLS in production); records what the relay sees. */
function startTlsFront({ key, cert }, relayPort, seen) {
  const server = createHttpsServer({ key, cert }, (request, response) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: relayPort,
        method: request.method,
        path: request.url,
        headers: request.headers
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      }
    )
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  server.on('upgrade', (request, socket, head) => {
    const upstream = netConnect(relayPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstream.write(head)
      socket.on('data', (chunk) => seen.push(Buffer.from(chunk)))
      upstream.on('data', (chunk) => seen.push(Buffer.from(chunk)))
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  })
  return server
}

// Why async: the fake Orca Cloud and the relay's TLS front live in this process, so a
// synchronous child would freeze them while orcad is waiting on them.
function cli(args, env) {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      [join(root, 'out/cli/index.js'), ...args, '--data-root', dataRoot, '--json'],
      { env, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`orca ${args.join(' ')} failed: ${stdout}${stderr}`))
          return
        }
        done(JSON.parse(stdout).result)
      }
    )
  })
}

function runAsync(command, args, options) {
  return new Promise((done) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      done({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    })
  })
}

/** Every live descendant of `pid`, read before it exits so reparented children stay known. */
function descendantPids(pid) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
  const childrenOf = new Map()
  for (const line of result.stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child && parent) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
    }
  }
  const found = []
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

async function main() {
  const tls = makeCertificate()
  const cloud = await startFakeOrcaCloudApi({
    tls: { key: tls.key, cert: tls.cert },
    onRequest: process.env.RELAY_SMOKE_VERBOSE
      ? (method, path, status) => log(`cloud ${method} ${path} -> ${status}`)
      : undefined
  })
  cleanups.push(() => cloud.stop())
  log(`fake Orca Cloud at ${cloud.url}`)

  const relayPort = await unusedPort()
  const frontPort = await unusedPort()
  const relayUrl = `https://127.0.0.1:${frontPort}`
  const relayData = join(work, 'relay-data')
  const trustEnv = { NODE_EXTRA_CA_CERTS: tls.certPath }
  const relay = startChild('relay', process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(root, 'cloud/apps/relay'),
    env: {
      ...process.env,
      ...trustEnv,
      HOME: home,
      PORT: String(relayPort),
      ORCA_RELAY_PUBLIC_URL: relayUrl,
      ORCA_RELAY_CELL_URL: relayUrl,
      ORCA_RELAY_AUTH_ISSUER: cloud.issuer,
      ORCA_RELAY_JWKS_URL: `${cloud.issuer}/jwks`,
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'relay-smoke-assignment-key-with-32-bytes',
      ORCA_RELAY_DATA_DIR: relayData,
      ORCA_RELAY_ADMIN_AUDIENCE: `${relayUrl}/v1/admin/drain`,
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
      ORCA_RELAY_ADMIN_JWKS_URL: `${cloud.issuer}/jwks`
    }
  })
  await waitForOutput(relay, /\[orca-relay\] listening/, 30_000, 'relay')
  const seen = []
  const front = startTlsFront(tls, relayPort, seen)
  await new Promise((done) => front.listen(frontPort, '127.0.0.1', done))
  cleanups.push(
    () =>
      new Promise((done) => {
        front.closeAllConnections?.()
        front.close(() => done())
      })
  )
  log(`relay (combined role) behind TLS at ${relayUrl}`)
  if (process.env.RELAY_SMOKE_PROBE) {
    for (const path of ['/health', '/v1/regions']) {
      const started = Date.now()
      const status = await new Promise((done) => {
        httpsGet(`${relayUrl}${path}`, { ca: tls.cert, timeout: 10_000 }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => done(`${response.statusCode} ${body.slice(0, 200)}`))
        }).on('error', (error) => done(`error ${error.message}`))
      })
      log(`probe ${path}: ${status} (${Date.now() - started} ms)`)
    }
  }

  const orcadPort = await unusedPort()
  const orcadEnv = {
    ...process.env,
    ...trustEnv,
    HOME: home,
    ORCA_USER_DATA: dataRoot,
    XDG_DATA_HOME: join(home, '.local/share'),
    ORCA_CLOUD_API_URL: cloud.url,
    ORCA_CLOUD_CLIENT_ID: 'orcad-relay-smoke',
    ORCA_RELAY_URL: relayUrl,
    // Why a dead loopback origin: orcad's push client must never reach the production gateway.
    ORCA_PUSH_GATEWAY_URL: 'https://127.0.0.1:9'
  }
  const orcad = startChild(
    'orcad',
    process.execPath,
    [
      join(root, 'out/orcad/orcad.js'),
      '--bind',
      '127.0.0.1',
      '--port',
      String(orcadPort),
      '--relay',
      '--no-pairing',
      '--json'
    ],
    { env: orcadEnv }
  )
  await waitForOutput(orcad, /"runtimeId"/, 180_000, 'orcad')
  log(`orcad ready on ws://127.0.0.1:${orcadPort} (loopback only)`)

  const start = await cli(['serve', 'relay', 'sign-in'], orcadEnv)
  if (!start.started) {
    throw new Error(`sign-in refused: ${JSON.stringify(start)}`)
  }
  // The "browser": the fake account API consents at once and redirects to orcad's loopback.
  const redirect = await new Promise((done, reject) => {
    httpsGet(start.authorizeUrl, { ca: tls.cert }, (response) => {
      response.resume()
      done(response.headers.location)
    }).on('error', reject)
  })
  const callback = await fetch(redirect)
  if (callback.status !== 200) {
    throw new Error(`sign-in callback answered ${callback.status}`)
  }
  let report = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    report = await cli(['serve', 'relay', 'status'], orcadEnv)
    if (report.lastSignIn?.outcome !== 'pending') {
      break
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  if (report?.account.state !== 'connected') {
    throw new Error(`orcad did not sign in: ${JSON.stringify(report)}`)
  }
  log(`signed in as ${report.account.email} (session: ${report.account.persistence})`)

  // Why TEST-NET-1: an address no phone can reach, so only the relay can carry the pairing.
  const offer = await cli(
    ['serve', 'pairing', 'new', '--mobile', '--relay', '--pairing-address', '192.0.2.1'],
    orcadEnv
  )
  if (!offer.viaRelay) {
    throw new Error(`offer carries no relay invite: ${JSON.stringify(offer)}`)
  }
  log('minted a relay pairing offer whose direct endpoint is unroutable')

  const phone = await runAsync(
    process.execPath,
    [
      join(root, 'mobile/node_modules/vitest/vitest.mjs'),
      'run',
      'src/transport/relay-pairing-live.test.ts'
    ],
    {
      cwd: join(root, 'mobile'),
      env: {
        ...process.env,
        ...trustEnv,
        HOME: home,
        ORCA_RELAY_LIVE_PAIRING_URL: offer.pairingUrl
      },
      encoding: 'utf-8',
      timeout: 180_000
    }
  )
  const phoneSummary = `${phone.stdout}\n${phone.stderr}`
  log(
    `phone: ${phoneSummary
      .split('\n')
      .filter((line) => /Tests\s/.test(line))
      .join(' ')
      .trim()}`
  )
  // Why check the count: a skipped live test also exits 0.
  if (phone.status !== 0 || !/Tests\s+1 passed/.test(phoneSummary)) {
    throw new Error(`phone pairing failed:\n${phone.stdout}\n${phone.stderr}`)
  }
  report = await cli(['serve', 'relay', 'status'], orcadEnv)
  log(
    `relay connection after pairing: ${report.relay.status}${report.relay.cellUrl ? ` (${report.relay.cellUrl})` : ''}`
  )

  // The relay's view: no RPC method name, no pairing token, no host reply in cleartext. Frames a
  // client sends are masked, but each leg is also a relay-to-client frame (unmasked, deflate is
  // off), so a cleartext phone request would show on the host's leg and a reply on the phone's.
  const everything = Buffer.concat(seen)
  // Positive control: the relay's own cleartext control frames must be visible to this recorder.
  if (!everything.includes(Buffer.from('challengeId'))) {
    throw new Error(
      'recorder saw no relay control cleartext; the ciphertext check would prove nothing'
    )
  }
  const deviceToken = JSON.parse(
    Buffer.from(new URL(offer.pairingUrl).searchParams.get('code'), 'base64url').toString('utf-8')
  ).deviceToken
  const leaks = ['status.get', 'pairing.provisionRelay', 'e2ee_authenticated', deviceToken].filter(
    (needle) => everything.includes(Buffer.from(needle))
  )
  if (leaks.length > 0) {
    throw new Error(`relay saw plaintext: ${leaks.join(', ')}`)
  }
  log(
    `relay forwarded ${everything.length} bytes; none contained an RPC method, reply or the device token`
  )

  const devices = await cli(['serve', 'devices', 'list'], orcadEnv)
  const paired = devices.devices.find((device) => device.deviceId === offer.deviceId)
  if (paired?.state !== 'paired') {
    throw new Error(`device not paired: ${JSON.stringify(devices)}`)
  }
  log('PASS: phone paired and reconnected through the relay to a loopback-only orcad')
}

async function shutdown() {
  // Why collected first: orcad's daemon and browser sidecar are its descendants, and once orcad
  // exits they reparent; only this run's own tree is ever signalled.
  const descendants = children.flatMap(({ child }) => (child.pid ? descendantPids(child.pid) : []))
  for (const { child } of children.toReversed()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((done) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done()
        }, 20_000)
        child.once('exit', () => {
          clearTimeout(timer)
          done()
        })
      })
    }
  }
  for (const cleanup of cleanups.toReversed()) {
    await cleanup()
  }
  // Why also by path: a detached daemon may already have left the tree; the work dir is unique.
  const byPath = spawnSync('pgrep', ['-f', work], { encoding: 'utf-8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number)
  for (const pid of [...descendants, ...byPath]) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  rmSync(work, { recursive: true, force: true })
}

try {
  await main()
  await shutdown()
} catch (error) {
  process.stderr.write(
    `[relay-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}\n`
  )
  for (const { label, child } of children) {
    process.stderr.write(`[relay-smoke] ${label} exit=${child.exitCode}\n`)
  }
  await shutdown()
  process.exitCode = 1
}
