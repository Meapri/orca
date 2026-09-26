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
})

// Deterministic link model for #22151: 17 terminals' worth of session.tabs snapshot (~34 KB,
// measured against orcad) republished 6x/s over a 0.8 Mbps single-flow link, with a small
// interactive reply queued behind it every 500 ms. It is a FIFO model, not measured WAN latency.
describe('session state publication over a thin link (model)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const SNAPSHOT_BYTES = 34 * 1024
  const LINK_BYTES_PER_MS = 800_000 / 8 / 1000
  const DURATION_MS = 30_000

  async function runModel(withBacklogSignal: boolean) {
    let backlog = 0
    let snapshotsSent = 0
    const replyLatencies: number[] = []
    const publisher = createBackpressuredLatestStatePublisher<number>({
      send: () => {
        snapshotsSent += 1
        backlog += SNAPSHOT_BYTES
      },
      backlogBytes: withBacklogSignal ? () => backlog : undefined
    })
    let version = 0
    for (let elapsed = 0; elapsed < DURATION_MS; elapsed += 5) {
      backlog = Math.max(0, backlog - LINK_BYTES_PER_MS * 5)
      if (elapsed % 165 === 0) {
        version += 1
        publisher.offer('worktree', version)
      }
      if (elapsed % 500 === 0) {
        replyLatencies.push(backlog / LINK_BYTES_PER_MS)
        backlog += 1024
      }
      await vi.advanceTimersByTimeAsync(5)
    }
    publisher.dispose()
    replyLatencies.sort((left, right) => left - right)
    return {
      snapshotsPerSecond: snapshotsSent / (DURATION_MS / 1000),
      replyP95Ms: replyLatencies[Math.floor(replyLatencies.length * 0.95)]!,
      offeredPerSecond: version / (DURATION_MS / 1000)
    }
  }

  it('bounds interactive latency by the link instead of the snapshot backlog', async () => {
    const before = await runModel(false)
    const after = await runModel(true)
    console.info('[session-tabs link model]', { before, after })

    // Before: the link cannot carry 6 x 34 KB/s, so replies queue behind an ever-growing backlog.
    expect(before.snapshotsPerSecond).toBeCloseTo(before.offeredPerSecond, 0)
    expect(before.replyP95Ms).toBeGreaterThan(10_000)
    // After: the stream sends what the link carries and replies wait at most about one snapshot.
    expect(after.snapshotsPerSecond).toBeLessThan(before.snapshotsPerSecond / 1.5)
    expect(after.replyP95Ms).toBeLessThan(1_200)
  })
})
