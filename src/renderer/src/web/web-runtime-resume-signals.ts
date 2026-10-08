/**
 * Browser equivalent of the desktop's OS-resume probe (#9092): a browser has no power events, so
 * the signals are the network coming back (`online`), a page restored from the back/forward cache
 * (`pageshow` with `persisted`), and a frozen tab resuming (Page Lifecycle `resume`).
 */

export type WebRuntimeResumeTarget = {
  reviveAfterResume(): void
}

const targets = new Set<WebRuntimeResumeTarget>()
let signalsInstalled = false

function reviveAll(): void {
  for (const target of Array.from(targets)) {
    target.reviveAfterResume()
  }
}

function installSignals(): void {
  // Why guarded: embedded or test hosts can expose a partial window; resume probing is best-effort.
  if (
    signalsInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return
  }
  signalsInstalled = true
  window.addEventListener('online', reviveAll)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reviveAll()
    }
  })
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('resume', reviveAll)
  }
}

export function registerWebRuntimeResumeTarget(target: WebRuntimeResumeTarget): () => void {
  installSignals()
  targets.add(target)
  return () => {
    targets.delete(target)
  }
}

/** Test seam and manual trigger: revive every live connection as if the page had just resumed. */
export function reviveWebRuntimeConnectionsNow(): number {
  const count = targets.size
  reviveAll()
  return count
}
