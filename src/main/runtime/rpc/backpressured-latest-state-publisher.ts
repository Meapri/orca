// Why: a state stream (e.g. session.tabs) re-sends the whole snapshot on every change, and on a
// thin link each frame lands behind the previous ones in the socket and kernel buffers.
// Interactive replies on the same socket then wait behind seconds of snapshots that the client
// discards anyway, since it keeps only the newest version per key (#22151). This keeps at most
// one state frame in flight: while the previous one is undelivered, or the local buffer is
// backlogged, only the latest frame per key is parked and sent when the link catches up. The
// link then carries what it can and every key still converges on its final state.

export const STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES = 64 * 1024
const STATE_PUBLICATION_DRAIN_POLL_MS = 25

export type BackpressuredLatestStatePublisher<TFrame> = {
  /** Send now when the link is clear, else park it as the newest frame for `key`. */
  offer: (key: string, frame: TFrame) => void
  /** Drop a parked frame for `key`, e.g. because a newer frame bypassed parking. */
  discard: (key: string) => void
  parkedCount: () => number
  dispose: () => void
}

export function createBackpressuredLatestStatePublisher<TFrame>(options: {
  send: (frame: TFrame) => void
  /** Bytes this connection has accepted but not yet written; undefined means no backlog signal. */
  backlogBytes: (() => number) | undefined
  /** Calls back once the peer received everything sent so far; undefined disables pacing. */
  awaitDelivery?: ((onDelivered: () => void) => () => void) | undefined
  thresholdBytes?: number
  pollMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}): BackpressuredLatestStatePublisher<TFrame> {
  const thresholdBytes = options.thresholdBytes ?? STATE_PUBLICATION_BACKLOG_THRESHOLD_BYTES
  const pollMs = options.pollMs ?? STATE_PUBLICATION_DRAIN_POLL_MS
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  // Insertion order is the order keys last changed, so a drain replays changes in causal order.
  const parked = new Map<string, TFrame>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelDeliveryWait: (() => void) | null = null
  let awaitingDelivery = false
  let disposed = false

  const backlogged = (): boolean => {
    if (!options.backlogBytes) {
      return false
    }
    try {
      const bytes = options.backlogBytes()
      return Number.isFinite(bytes) && bytes >= thresholdBytes
    } catch {
      // A socket mid-teardown can throw on read; treat as clear so close handling owns it.
      return false
    }
  }

  const blocked = (): boolean => awaitingDelivery || backlogged()

  const sendAndPace = (frame: TFrame): void => {
    options.send(frame)
    if (!options.awaitDelivery || disposed) {
      return
    }
    awaitingDelivery = true
    cancelDeliveryWait = options.awaitDelivery(() => {
      cancelDeliveryWait = null
      awaitingDelivery = false
      drain()
    })
  }

  const arm = (): void => {
    // Why: a delivery wait re-drains on its own callback; the poll only covers a local backlog.
    if (timer !== null || disposed || awaitingDelivery || parked.size === 0) {
      return
    }
    timer = setTimer(onTimer, pollMs)
    // Why: a parked frame must never keep a shutting-down process alive.
    timer.unref?.()
  }

  const onTimer = (): void => {
    timer = null
    drain()
  }

  const drain = (): void => {
    while (!disposed && parked.size > 0 && !blocked()) {
      const next = parked.entries().next()
      if (next.done) {
        break
      }
      const [key, frame] = next.value
      parked.delete(key)
      sendAndPace(frame)
    }
    arm()
  }

  return {
    offer: (key, frame) => {
      if (disposed) {
        return
      }
      if (parked.size === 0 && !blocked()) {
        sendAndPace(frame)
        return
      }
      // Why delete-then-set: the key moves to the tail, so a drain never sends a newer state for
      // this key ahead of an older change to another key that happened after its previous frame.
      parked.delete(key)
      parked.set(key, frame)
      arm()
    },
    discard: (key) => {
      parked.delete(key)
    },
    parkedCount: () => parked.size,
    dispose: () => {
      disposed = true
      parked.clear()
      cancelDeliveryWait?.()
      cancelDeliveryWait = null
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    }
  }
}
