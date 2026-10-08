import type {
  MultiplexSubscribeRequest,
  TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { MultiplexPublishedInitialState } from './terminal-multiplex-initial-snapshot'
import type { TerminalMultiplexStream } from './terminal-stream-types'

type SubscribedNegotiation = {
  capabilities?: { ackOutputSourceRanges?: 1; outputPause?: 1; outputResume?: 1 }
  streamGeneration?: string
  resumeToken?: string
}

/** What the `subscribed` event echoes; each capability only to a client that asked for it. */
export function multiplexSubscribedNegotiation(
  stream: TerminalMultiplexStream
): SubscribedNegotiation {
  const capabilities = {
    ...(stream.ackOutputSourceRanges ? { ackOutputSourceRanges: 1 as const } : {}),
    ...(stream.supportsOutputPause ? { outputPause: 1 as const } : {}),
    ...(stream.outputResume ? { outputResume: 1 as const } : {})
  }
  return {
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(stream.ackOutputSourceRanges ? { streamGeneration: stream.streamGeneration } : {}),
    ...(stream.outputResume ? { resumeToken: stream.outputResume.ring.resumeToken } : {})
  }
}

/**
 * Replaces the initial snapshot with only the output the client missed, when the ring still
 * holds all of it. Runs synchronously from the check to the drain, so no chunk can land between
 * the ring's view and the stream's parked output. Returns null to fall back to the snapshot.
 */
export function publishMultiplexResumedTail(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  stream: TerminalMultiplexStream
): MultiplexPublishedInitialState | null {
  const resume = request.resume
  // Why source ranges fall back: their ledger only accepts ranges this stream generation produced.
  if (!resume || !stream.outputResume || stream.ackOutputSourceRanges) {
    return null
  }
  const tail = stream.outputResume.ring.tailAfter(resume)
  if (!tail) {
    return null
  }
  const { runtime, emit } = state
  const size = runtime.getTerminalSize(stream.ptyId)
  const displayMode = runtime.getMobileDisplayMode(stream.ptyId)
  emit({
    type: 'subscribed',
    streamId: request.streamId,
    terminal: request.terminal,
    cols: size?.cols,
    rows: size?.rows,
    displayMode,
    seq: runtime.getLayout(stream.ptyId)?.seq,
    ...multiplexSubscribedNegotiation(stream),
    truncated: false,
    resumed: { fromSeq: resume.seq }
  })
  stream.lastResizeCols = size?.cols
  stream.buffering = false
  // Parked output is a suffix of what the ring already holds, so the tail covers it.
  stream.pendingOutput.splice(0)
  stream.pendingOutputBytes = 0
  stream.pendingOutputOverflowed = false
  for (const chunk of tail) {
    stream.outputBatcher.push(chunk.data, chunk.meta)
  }
  stream.outputBatcher.flush()
  return { isMobile: stream.isMobile, size, displayMode }
}
