import type {
  RemoteRuntimeMultiplexedTerminalState,
  RemoteRuntimeTerminalResumePoint
} from './remote-runtime-terminal-multiplexer-types'

function readMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

/**
 * Reads the resume fields of a `subscribed` event. Returns true when the host replaced the
 * initial snapshot with the missed tail, which only a host that echoed outputResume may do.
 */
export function acceptSubscribedResume(
  stream: RemoteRuntimeMultiplexedTerminalState,
  event: { type: string; capabilities?: unknown; resumeToken?: unknown; resumed?: unknown }
): boolean {
  const requested = stream.requestedResume
  stream.requestedResume = null
  if (readMember(event.capabilities, 'outputResume') !== 1) {
    stream.resumeToken = null
    return false
  }
  stream.resumeToken =
    typeof event.resumeToken === 'string' && event.resumeToken.length > 0 ? event.resumeToken : null
  if (!requested || readMember(event.resumed, 'fromSeq') !== requested.seq) {
    return false
  }
  stream.initialSnapshotReceived = true
  // Why keep a larger value: an Output frame that raced ahead of this event already advanced it.
  if (typeof stream.expectedSeq !== 'number' || stream.expectedSeq < requested.seq) {
    stream.expectedSeq = requested.seq
  }
  stream.commandProbeBaselineSeq = undefined
  return true
}

/** The point a reconnect may resume from, or undefined when the view may not hold every byte. */
export function readRemoteTerminalResumePoint(
  stream: RemoteRuntimeMultiplexedTerminalState
): RemoteRuntimeTerminalResumePoint | undefined {
  if (
    !stream.resumeToken ||
    !stream.initialSnapshotReceived ||
    typeof stream.expectedSeq !== 'number' ||
    stream.outputPaused ||
    stream.resyncInFlight ||
    stream.snapshotInfo !== null ||
    stream.capacityRejected
  ) {
    return undefined
  }
  return { token: stream.resumeToken, seq: stream.expectedSeq }
}
