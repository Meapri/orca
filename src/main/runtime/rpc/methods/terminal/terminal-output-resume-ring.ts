import { randomUUID } from 'node:crypto'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState
} from '../../../../../shared/terminal-reply-query-scan'
import type { TerminalOutputMeta } from '../../terminal-output-frame-chunks'
import { terminalStreamByteLength } from '../../terminal-stream-byte-length'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type { TerminalOutputChunk } from './terminal-stream-types'

// Why 256 KiB: a replayed tail must fit the per-stream ACK window (512 KiB) and the pending
// queue (256 KiB) or the reconnect would immediately overflow into a recovery snapshot anyway.
export const TERMINAL_OUTPUT_RESUME_RING_MAX_BYTES = 256 * 1024

// Why excluded: the 2031 pair is replayed to late views on purpose (terminal-reply-query-scan).
const NON_REPLY_SEQUENCES = new Set(['\x1b[?2031h', '\x1b[?2031l'])

type ResumeRingEntry = TerminalOutputChunk & {
  startSeq: number
  endSeq: number
  // Why: the host model answered this query while no view was attached; a replay would answer twice.
  elicitsReply: boolean
}

export type TerminalOutputResumePoint = {
  token: string
  seq: number
}

/**
 * The most recent PTY output of one terminal, in the host's output-sequence domain, so a client
 * that reconnects with the sequence it last applied can receive only what it missed. The token
 * names one contiguous run of that domain; any discontinuity starts a new run with a new token.
 */
export class TerminalOutputResumeRing {
  private token = randomUUID()
  private entries: ResumeRingEntry[] = []
  private bytes = 0
  // Oldest sequence a client may resume from, and the newest recorded; null = no known position.
  private floorSeq: number | null
  private endSeq: number | null
  private queryScan: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE

  constructor(
    currentSeq: number | null,
    private readonly maxBytes = TERMINAL_OUTPUT_RESUME_RING_MAX_BYTES
  ) {
    this.floorSeq = currentSeq
    this.endSeq = currentSeq
  }

  get resumeToken(): string {
    return this.token
  }

  record(data: string, meta?: TerminalOutputMeta): void {
    const seq = meta?.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      // Why: an unsequenced chunk cannot be placed, so no earlier position can be resumed past it.
      this.restart(null)
      return
    }
    const rawLength = meta?.rawLength ?? data.length
    const startSeq = seq - rawLength
    if (this.endSeq !== startSeq) {
      this.restart(startSeq)
    }
    const scan = scanTerminalReplyQuerySequences(data, startSeq, this.queryScan)
    this.queryScan = scan.state
    const bytes = terminalStreamByteLength(data)
    // Why no sourceRanges: they belong to the stream generation that consumed them live.
    this.entries.push({
      data,
      bytes,
      meta: {
        seq,
        rawLength,
        ...(meta?.transformed ? { transformed: true } : {}),
        ...(meta?.cwd !== undefined ? { cwd: meta.cwd } : {})
      },
      startSeq,
      endSeq: seq,
      elicitsReply: scan.queries.some((query) => !NON_REPLY_SEQUENCES.has(query.data))
    })
    this.bytes += bytes
    this.endSeq = seq
    while (this.bytes > this.maxBytes && this.entries.length > 0) {
      const evicted = this.entries.shift()!
      this.bytes -= evicted.bytes
    }
    this.floorSeq = this.entries[0]?.startSeq ?? this.endSeq
  }

  /** Output after `point.seq`, or null when this ring cannot prove it holds every byte of it. */
  tailAfter(point: TerminalOutputResumePoint): TerminalOutputChunk[] | null {
    if (
      point.token !== this.token ||
      this.floorSeq === null ||
      this.endSeq === null ||
      point.seq < this.floorSeq ||
      point.seq > this.endSeq
    ) {
      return null
    }
    const tail: TerminalOutputChunk[] = []
    for (const entry of this.entries) {
      if (entry.endSeq <= point.seq) {
        continue
      }
      const uncovered = getOutputAfterSnapshotSeq(entry, point.seq)
      if (!uncovered || entry.elicitsReply) {
        return null
      }
      tail.push(uncovered)
    }
    return tail
  }

  retainedBytes(): number {
    return this.bytes
  }

  private restart(startSeq: number | null): void {
    this.token = randomUUID()
    this.entries = []
    this.bytes = 0
    this.floorSeq = startSeq
    this.endSeq = startSeq
    this.queryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  }
}
