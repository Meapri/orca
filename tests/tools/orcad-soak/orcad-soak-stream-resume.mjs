// Measures what a terminal-stream reconnect costs through the fault proxy: a terminal with deep
// scrollback misses a burst of output while its client's link is reset, then the client
// reconnects presenting its resume point (only the missed tail should cross) or not (the full
// snapshot crosses, which is what every client did before stream resumption).
import { sleep } from './orcad-soak-host.mjs'
import { decodePairingUrl, openTerminalStream } from './orcad-soak-multiplex-client.mjs'

const SCROLLBACK_LINES = 4_000
// Idle (the common laptop-sleep case) up to a burst far larger than one screen.
const MISSED_SIZES = [0, 1024, 8 * 1024, 32 * 1024, 128 * 1024]
// Beyond the host's 256 KiB resume ring, so this reconnect must fall back to the snapshot.
const OVERFLOW_BYTES = 400 * 1024
const TRIALS = 3
const QUIET_MS = 500
// A WAN-like link, so catch-up time includes what the extra bytes cost to deliver.
const LINK = { kind: 'latency', latencyMs: 40, jitterMs: 10 }

async function waitQuiet(stream, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = stream.stats.lastByteAt ?? stream.stats.subscribeSentAt
    if (last !== null && Date.now() - last >= QUIET_MS) {
      return
    }
    await sleep(50)
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

async function printBytes(ctx, terminal, bytes) {
  await ctx.control([
    'terminal',
    'send',
    '--terminal',
    terminal,
    '--text',
    `"${process.execPath}" -e "process.stdout.write('m'.repeat(${bytes}) + '\\\\n')"`,
    '--enter'
  ])
}

async function reconnectTrial(ctx, { terminal, pairing, endpoint, missedBytes, presentResume }) {
  const first = await openTerminalStream({ pairing, endpoint, terminal })
  await waitQuiet(first)
  const point = first.resumePoint()
  ctx.proxy.setMode({ kind: 'reset' })
  await sleep(100)
  ctx.proxy.setMode(LINK)
  first.close()
  if (missedBytes > 0) {
    await printBytes(ctx, terminal, missedBytes)
  }
  // Let the burst finish on the host while no client is attached.
  await sleep(1_500)
  const second = await openTerminalStream({
    pairing,
    endpoint,
    terminal,
    resume: presentResume ? (point ?? undefined) : undefined
  })
  await waitQuiet(second)
  second.close()
  ctx.proxy.setMode({ kind: 'pass' })
  const { stats } = second
  return {
    missedBytes,
    presentedResume: presentResume && point !== null,
    resumed: Boolean(stats.subscribed?.resumed),
    wireBytes: stats.wireBytes,
    snapshotBytes: stats.snapshotBytes,
    outputBytes: stats.outputBytes,
    catchUpMs: (stats.lastByteAt ?? stats.subscribeSentAt) - stats.subscribeSentAt
  }
}

export function createStreamResumeScenario({ ensureWorktree, mustCall }) {
  return async function streamResume(ctx, check) {
    await ensureWorktree(ctx)
    const created = await mustCall(ctx, ['terminal', 'create', '--worktree', ctx.worktreeId])
    const terminal = created.terminal.handle
    await mustCall(ctx, [
      'terminal',
      'send',
      '--terminal',
      terminal,
      '--text',
      `"${process.execPath}" -e "for (let i = 0; i < ${SCROLLBACK_LINES}; i++) console.log('scrollback line ' + i + ' ' + 'x'.repeat(60))"`,
      '--enter'
    ])
    await sleep(3_000)
    const pairing = decodePairingUrl(ctx.orcad.readiness.pairing.url)
    const endpoint = `ws://127.0.0.1:${ctx.proxy.port}`
    const trials = []
    for (const missedBytes of MISSED_SIZES) {
      for (let index = 0; index < TRIALS; index++) {
        for (const presentResume of [true, false]) {
          trials.push(
            await reconnectTrial(ctx, { terminal, pairing, endpoint, missedBytes, presentResume })
          )
        }
      }
    }
    const overflow = await reconnectTrial(ctx, {
      terminal,
      pairing,
      endpoint,
      missedBytes: OVERFLOW_BYTES,
      presentResume: true
    })
    check(
      trials.every(
        (trial) => trial.presentedResume === (trial.resumed && trial.snapshotBytes === 0)
      ),
      'a reconnect was not served the missed tail exactly when it presented a held resume point'
    )
    check(
      !overflow.resumed && overflow.snapshotBytes > 0,
      'a reconnect past the resume ring did not fall back to the snapshot'
    )
    const bySize = MISSED_SIZES.map((missedBytes) => {
      const of = (resume) =>
        trials.filter(
          (trial) => trial.missedBytes === missedBytes && trial.presentedResume === resume
        )
      return {
        missedBytes,
        resumeWireBytes: median(of(true).map((trial) => trial.wireBytes)),
        snapshotWireBytes: median(of(false).map((trial) => trial.wireBytes)),
        resumeCatchUpMs: median(of(true).map((trial) => trial.catchUpMs)),
        snapshotCatchUpMs: median(of(false).map((trial) => trial.catchUpMs))
      }
    })
    const idle = bySize[0]
    check(
      idle.resumeWireBytes < idle.snapshotWireBytes,
      `an idle reconnect did not save bytes (resume ${idle.resumeWireBytes}, snapshot ${idle.snapshotWireBytes})`
    )
    return { scrollbackLines: SCROLLBACK_LINES, link: LINK, bySize, overflow, trials }
  }
}
