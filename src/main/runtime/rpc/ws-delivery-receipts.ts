import type { WebSocket } from 'ws'

// Why: ws.bufferedAmount only sees bytes still in this process; on a thin link the kernel send
// buffer (128 KB+) and any bottleneck queue hide the rest, so a state stream cannot tell from it
// how far behind the peer is. A ping is queued behind everything sent before it, and RFC 6455
// makes the peer echo its payload in the pong, so the pong for ping N proves delivery of all
// earlier frames end to end. Every peer auto-pongs, so this needs no negotiation.
const DELIVERY_PAYLOAD_PREFIX = 'd:'
// Why: an intermediary that swallows pings, or a peer that skips them, must not stall a stream
// forever; after this the waiter is released and the stream degrades to unpaced sends.
const DELIVERY_RECEIPT_TIMEOUT_MS = 10_000

type Waiter = { seq: number; onDelivered: () => void; timer: ReturnType<typeof setTimeout> }

export type WebSocketDeliveryReceipts = {
  /** Ping now and call `onDelivered` once the peer has received everything sent before it. */
  request: (onDelivered: () => void) => () => void
  notePong: (payload: Buffer) => void
  dispose: () => void
}

export function createWebSocketDeliveryReceipts(
  ws: Pick<WebSocket, 'ping' | 'readyState' | 'OPEN'>,
  timeoutMs = DELIVERY_RECEIPT_TIMEOUT_MS
): WebSocketDeliveryReceipts {
  let nextSeq = 1
  let waiters: Waiter[] = []

  const release = (predicate: (waiter: Waiter) => boolean): void => {
    const ready = waiters.filter(predicate)
    if (ready.length === 0) {
      return
    }
    waiters = waiters.filter((waiter) => !predicate(waiter))
    for (const waiter of ready) {
      clearTimeout(waiter.timer)
      waiter.onDelivered()
    }
  }

  return {
    request: (onDelivered) => {
      const seq = nextSeq++
      const timer = setTimeout(() => release((waiter) => waiter.seq === seq), timeoutMs)
      timer.unref?.()
      waiters.push({ seq, onDelivered, timer })
      try {
        if (ws.readyState !== ws.OPEN) {
          throw new Error('socket not open')
        }
        ws.ping(Buffer.from(`${DELIVERY_PAYLOAD_PREFIX}${seq}`))
      } catch {
        // Why: a closing socket cannot confirm anything; release so the stream's close path runs.
        release((waiter) => waiter.seq === seq)
      }
      return () => {
        const waiter = waiters.find((candidate) => candidate.seq === seq)
        if (waiter) {
          clearTimeout(waiter.timer)
          waiters = waiters.filter((candidate) => candidate !== waiter)
        }
      }
    },
    notePong: (payload) => {
      if (waiters.length === 0) {
        return
      }
      const text = payload.toString('latin1')
      if (text.length === 0) {
        // Why: a peer that pongs without echoing cannot be correlated; releasing degrades to the
        // unpaced behaviour instead of stalling.
        release(() => true)
        return
      }
      if (!text.startsWith(DELIVERY_PAYLOAD_PREFIX)) {
        return
      }
      const seq = Number(text.slice(DELIVERY_PAYLOAD_PREFIX.length))
      if (Number.isSafeInteger(seq)) {
        // Why: a peer may answer only the latest ping (RFC 6455 5.5.3), which covers earlier ones.
        release((waiter) => waiter.seq <= seq)
      }
    },
    dispose: () => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
      }
      waiters = []
    }
  }
}

/** Per-socket receipts, created lazily so sockets that never pace a stream cost nothing. */
export class WebSocketDeliveryReceiptRegistry {
  private readonly bySocket = new WeakMap<WebSocket, WebSocketDeliveryReceipts>()

  request(ws: WebSocket, onDelivered: () => void): () => void {
    let receipts = this.bySocket.get(ws)
    if (!receipts) {
      receipts = createWebSocketDeliveryReceipts(ws)
      this.bySocket.set(ws, receipts)
    }
    return receipts.request(onDelivered)
  }

  notePong(ws: WebSocket, payload: Buffer): void {
    this.bySocket.get(ws)?.notePong(payload)
  }

  release(ws: WebSocket): void {
    this.bySocket.get(ws)?.dispose()
    this.bySocket.delete(ws)
  }
}
