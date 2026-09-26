import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBackpressuredLatestStatePublisher,
  STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
} from './backpressured-latest-state-publisher'

describe('createBackpressuredLatestStatePublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends immediately and in order while the connection is clear', () => {
    const sent: string[] = []
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => 0
    })
    publisher.offer('a', 'a1')
    publisher.offer('a', 'a2')
    publisher.offer('b', 'b1')
    expect(sent).toEqual(['a1', 'a2', 'b1'])
    expect(publisher.parkedCount()).toBe(0)
  })

  it('parks the newest frame per key while backlogged and drains in last-change order', async () => {
    const sent: string[] = []
    let backlog = STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => backlog
    })
    publisher.offer('a', 'a1')
    publisher.offer('b', 'b1')
    publisher.offer('a', 'a2')
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual([])
    expect(publisher.parkedCount()).toBe(2)

    backlog = 0
    await vi.advanceTimersByTimeAsync(25)
    expect(sent).toEqual(['b1', 'a2'])
  })

  it('stops draining mid-way when a sent frame re-fills the backlog', async () => {
    let backlog = STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
    const sent: string[] = []
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => {
        sent.push(frame)
        backlog = STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
      },
      backlogBytes: () => backlog
    })
    publisher.offer('a', 'a1')
    publisher.offer('b', 'b1')
    backlog = 0
    await vi.advanceTimersByTimeAsync(25)
    expect(sent).toEqual(['a1'])
    backlog = 0
    await vi.advanceTimersByTimeAsync(25)
    expect(sent).toEqual(['a1', 'b1'])
  })

  it('keeps a frame queued behind parked frames so a key never overtakes its own backlog', async () => {
    let backlog = STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
    const sent: string[] = []
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => backlog
    })
    publisher.offer('a', 'a1')
    backlog = 0
    // The link just cleared but the drain timer has not run: b1 must wait behind a1.
    publisher.offer('b', 'b1')
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(25)
    expect(sent).toEqual(['a1', 'b1'])
  })

  it('drops parked frames on dispose and on discard', async () => {
    let backlog = STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
    const sent: string[] = []
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => backlog
    })
    publisher.offer('a', 'a1')
    publisher.offer('b', 'b1')
    publisher.discard('a')
    publisher.dispose()
    backlog = 0
    await vi.advanceTimersByTimeAsync(100)
    publisher.offer('c', 'c1')
    expect(sent).toEqual([])
  })

  it('treats a missing or throwing backlog signal as a clear link', () => {
    const sent: string[] = []
    createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: undefined
    }).offer('a', 'a1')
    createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => {
        throw new Error('socket gone')
      }
    }).offer('a', 'a2')
    expect(sent).toEqual(['a1', 'a2'])
  })

  it('keeps one frame in flight until the peer confirms delivery, then sends the newest', () => {
    const sent: string[] = []
    const receipts: (() => void)[] = []
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: (frame) => sent.push(frame),
      backlogBytes: () => 0,
      awaitDelivery: (onDelivered) => {
        receipts.push(onDelivered)
        return () => {}
      }
    })
    publisher.offer('a', 'a1')
    publisher.offer('a', 'a2')
    publisher.offer('a', 'a3')
    expect(sent).toEqual(['a1'])

    receipts.shift()?.()
    expect(sent).toEqual(['a1', 'a3'])
    receipts.shift()?.()
    publisher.offer('a', 'a4')
    expect(sent).toEqual(['a1', 'a3', 'a4'])
  })

  it('cancels an outstanding delivery wait on dispose', () => {
    const cancel = vi.fn()
    const publisher = createBackpressuredLatestStatePublisher<string>({
      send: () => {},
      backlogBytes: undefined,
      awaitDelivery: () => cancel
    })
    publisher.offer('a', 'a1')
    publisher.dispose()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

// Deterministic link model for #22151: 17 terminals' worth of session.tabs snapshot (~34 KB,
// measured against orcad) republished 6x/s over a 0.8 Mbps single-flow link with a 128 KB kernel
// send buffer the process cannot see, plus a 1 KB interactive reply every 500 ms. It is a FIFO
// model, not measured WAN latency.
describe('session state publication over a thin link (model)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const SNAPSHOT_BYTES = 34 * 1024
  const KERNEL_BUFFER_BYTES = 128 * 1024
  const LINK_BYTES_PER_MS = 800_000 / 8 / 1000
  const DURATION_MS = 30_000

  async function runModel(signals: 'none' | 'local-buffer' | 'delivery-receipts') {
    let queued = 0
    let delivered = 0
    let written = 0
    let snapshotsSent = 0
    const receiptWaiters: { at: number; onDelivered: () => void }[] = []
    const replyLatencies: number[] = []
    const publisher = createBackpressuredLatestStatePublisher<number>({
      send: () => {
        snapshotsSent += 1
        queued += SNAPSHOT_BYTES
        written += SNAPSHOT_BYTES
      },
      // The process sees only what overflows the kernel buffer, like ws.bufferedAmount.
      backlogBytes:
        signals === 'none' ? undefined : () => Math.max(0, queued - KERNEL_BUFFER_BYTES),
      awaitDelivery:
        signals === 'delivery-receipts'
          ? (onDelivered) => {
              receiptWaiters.push({ at: written, onDelivered })
              return () => {}
            }
          : undefined
    })
    let version = 0
    for (let elapsed = 0; elapsed < DURATION_MS; elapsed += 5) {
      const drained = Math.min(queued, LINK_BYTES_PER_MS * 5)
      queued -= drained
      delivered += drained
      for (const waiter of receiptWaiters.splice(0)) {
        if (waiter.at <= delivered) {
          waiter.onDelivered()
        } else {
          receiptWaiters.push(waiter)
        }
      }
      if (elapsed % 165 === 0) {
        version += 1
        publisher.offer('worktree', version)
      }
      if (elapsed % 500 === 0) {
        replyLatencies.push(queued / LINK_BYTES_PER_MS)
        queued += 1024
        written += 1024
      }
      await vi.advanceTimersByTimeAsync(5)
    }
    publisher.dispose()
    replyLatencies.sort((left, right) => left - right)
    return {
      snapshotsPerSecond: Number((snapshotsSent / (DURATION_MS / 1000)).toFixed(2)),
      replyP95Ms: Math.round(replyLatencies[Math.floor(replyLatencies.length * 0.95)]!),
      offeredPerSecond: Number((version / (DURATION_MS / 1000)).toFixed(2))
    }
  }

  it('bounds interactive latency by the link instead of the snapshot backlog', async () => {
    const before = await runModel('none')
    const localBufferOnly = await runModel('local-buffer')
    const after = await runModel('delivery-receipts')
    console.info('[session-tabs link model]', { before, localBufferOnly, after })

    // Before: the link cannot carry 6 x 34 KB/s, so replies queue behind an ever-growing backlog.
    expect(before.snapshotsPerSecond).toBeCloseTo(before.offeredPerSecond, 0)
    expect(before.replyP95Ms).toBeGreaterThan(10_000)
    // The local buffer alone still leaves the hidden kernel queue in front of every reply.
    expect(localBufferOnly.replyP95Ms).toBeGreaterThan(1_300)
    // Delivery receipts keep one snapshot in flight, so a reply waits for at most about one.
    expect(after.snapshotsPerSecond).toBeLessThan(before.snapshotsPerSecond / 1.5)
    expect(after.replyP95Ms).toBeLessThan(500)
  })
})
