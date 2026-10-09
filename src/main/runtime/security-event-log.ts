// Why: an unattended host needs an audit trail of who was let in and who was turned away. NDJSON so
// it greps and ships like the daemon log; rotation reuses the trace sink's size-bounded family.
import { createLocalFileSink, type LocalFileSink } from '../observability/local-file-sink'
import type { DeviceScope } from '../../shared/runtime-types'

export type SecurityEventName =
  | 'pairing.offered'
  | 'pairing.consumed'
  | 'pairing.expired'
  | 'pairing.superseded'
  | 'device.revoked'
  | 'device.rotated'
  | 'auth.failed'
  | 'auth.failed.suppressed'

/** Every field is non-secret by construction: ids, labels, scopes and fixed reason strings. */
export type SecurityEvent = {
  event: SecurityEventName
  deviceId?: string
  scope?: DeviceScope
  name?: string
  offerExpiresAt?: number | null
  transport?: 'direct' | 'relay' | 'local-socket'
  reason?: string
  closedConnections?: number
  suppressed?: number
}

export type SecurityEventSink = {
  record(event: SecurityEvent): void
}

export const SECURITY_LOG_FILENAME = 'security.log'
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
const AUTH_FAILURE_WINDOW_MS = 60_000
const AUTH_FAILURES_PER_WINDOW = 20

type SecurityEventLogOptions = {
  now?: () => number
  maxBytes?: number
  maxFiles?: number
  authFailuresPerWindow?: number
}

export class SecurityEventLog implements SecurityEventSink {
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly authFailuresPerWindow: number
  private sink: LocalFileSink | null = null
  private disabled = false
  private authWindowStartedAt = 0
  private authFailuresInWindow = 0
  private suppressedAuthFailures = 0

  constructor(
    private readonly filePath: string,
    options: SecurityEventLogOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.authFailuresPerWindow = options.authFailuresPerWindow ?? AUTH_FAILURES_PER_WINDOW
  }

  record(event: SecurityEvent): void {
    if (event.event === 'auth.failed' && !this.admitAuthFailure()) {
      return
    }
    this.write(event)
  }

  close(): void {
    this.flushSuppressedAuthFailures()
    this.sink?.close()
    this.sink = null
  }

  // Why: an unauthenticated peer controls how often this fires, so it must not be able to fill the disk.
  private admitAuthFailure(): boolean {
    const now = this.now()
    if (now - this.authWindowStartedAt >= AUTH_FAILURE_WINDOW_MS) {
      this.flushSuppressedAuthFailures()
      this.authWindowStartedAt = now
      this.authFailuresInWindow = 0
    }
    this.authFailuresInWindow += 1
    if (this.authFailuresInWindow > this.authFailuresPerWindow) {
      this.suppressedAuthFailures += 1
      return false
    }
    return true
  }

  private flushSuppressedAuthFailures(): void {
    if (this.suppressedAuthFailures === 0) {
      return
    }
    const suppressed = this.suppressedAuthFailures
    this.suppressedAuthFailures = 0
    this.write({ event: 'auth.failed.suppressed', suppressed })
  }

  private write(event: SecurityEvent): void {
    const sink = this.openSink()
    if (!sink) {
      return
    }
    sink.push({ ts: new Date(this.now()).toISOString(), type: 'orca.security', ...event })
  }

  private openSink(): LocalFileSink | null {
    if (this.sink || this.disabled) {
      return this.sink
    }
    try {
      // Why threshold 1: events are rare and each must reach disk before a crash can drop it.
      this.sink = createLocalFileSink({
        filePath: this.filePath,
        maxBytes: this.maxBytes,
        maxFiles: this.maxFiles,
        flushBufferThreshold: 1
      })
    } catch (error) {
      // Why: an unwritable log must never take authentication down with it.
      this.disabled = true
      console.error(`[runtime] Security log unavailable at ${this.filePath}:`, error)
    }
    return this.sink
  }
}
