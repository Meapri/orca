import type { RpcContext } from '../../core'
import { TerminalOutputResumeRing } from './terminal-output-resume-ring'

// Why 10 minutes: long enough to cover a laptop sleep or a network change, short enough that a
// client that never comes back stops costing the host memory.
export const TERMINAL_OUTPUT_RESUME_RETENTION_MS = 10 * 60 * 1000
// Bounds unleased rings (each up to 256 KiB) so abandoned terminals cannot grow memory without limit.
export const TERMINAL_OUTPUT_RESUME_MAX_IDLE_RINGS = 64

type TerminalOutputResumeRuntime = Pick<
  RpcContext['runtime'],
  'subscribeToTerminalData' | 'getPtyOutputSequence'
>

type RingRecord = {
  ring: TerminalOutputResumeRing
  leases: number
  unsubscribe: () => void
  expiry: ReturnType<typeof setTimeout> | null
}

export type TerminalOutputResumeLease = {
  ring: TerminalOutputResumeRing
  release: () => void
}

/** Per-runtime owner of resume rings; a ring outlives its stream so the reconnect can find it. */
export class TerminalOutputResumeRegistry {
  private readonly records = new Map<string, RingRecord>()

  constructor(
    private readonly runtime: TerminalOutputResumeRuntime,
    private readonly retentionMs = TERMINAL_OUTPUT_RESUME_RETENTION_MS,
    private readonly maxIdleRings = TERMINAL_OUTPUT_RESUME_MAX_IDLE_RINGS
  ) {}

  acquire(ptyId: string): TerminalOutputResumeLease {
    let record = this.records.get(ptyId)
    if (!record) {
      const ring = new TerminalOutputResumeRing(this.runtime.getPtyOutputSequence(ptyId))
      record = {
        ring,
        leases: 0,
        unsubscribe: this.runtime.subscribeToTerminalData(ptyId, (data, meta) =>
          ring.record(data, meta)
        ),
        expiry: null
      }
      this.records.set(ptyId, record)
    }
    if (record.expiry) {
      clearTimeout(record.expiry)
      record.expiry = null
    }
    record.leases += 1
    const leased = record
    let released = false
    return {
      ring: leased.ring,
      release: () => {
        if (released) {
          return
        }
        released = true
        this.release(ptyId, leased)
      }
    }
  }

  ringCount(): number {
    return this.records.size
  }

  private release(ptyId: string, record: RingRecord): void {
    record.leases -= 1
    if (record.leases > 0 || this.records.get(ptyId) !== record) {
      return
    }
    record.expiry = setTimeout(() => this.drop(ptyId, record), this.retentionMs)
    record.expiry.unref?.()
    this.evictExcessIdleRings()
  }

  private evictExcessIdleRings(): void {
    const idle = Array.from(this.records.entries()).filter(([, record]) => record.leases === 0)
    // Map order is insertion order, so the front holds the longest-lived idle rings.
    for (const [ptyId, record] of idle.slice(0, Math.max(0, idle.length - this.maxIdleRings))) {
      this.drop(ptyId, record)
    }
  }

  private drop(ptyId: string, record: RingRecord): void {
    if (this.records.get(ptyId) !== record) {
      return
    }
    if (record.expiry) {
      clearTimeout(record.expiry)
    }
    record.unsubscribe()
    this.records.delete(ptyId)
  }
}

const registries = new WeakMap<TerminalOutputResumeRuntime, TerminalOutputResumeRegistry>()

export function getTerminalOutputResumeRegistry(
  runtime: TerminalOutputResumeRuntime
): TerminalOutputResumeRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new TerminalOutputResumeRegistry(runtime)
    registries.set(runtime, registry)
  }
  return registry
}
