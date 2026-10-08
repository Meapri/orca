import { describe, expect, it } from 'vitest'
import {
  REMOTE_DESKTOP_INPUT_CLAIM_QUIET_MS,
  RemoteDesktopTerminalFloor
} from './remote-desktop-terminal-floor'

const PTY = 'pty-shared'
const A = 'multiplex:conn-a:1'
const B = 'multiplex:conn-b:1'

/** Two desktop clients on one host PTY, with the geometry the PTY actually holds. */
function twoClientHost() {
  let now = 10_000
  let size = { cols: 120, rows: 40 }
  const applied: { cols: number; rows: number }[] = []
  const floor = new RemoteDesktopTerminalFloor({
    isMobileDriven: () => false,
    getTerminalSize: () => size,
    resolveHostTarget: () => ({ cols: 120, rows: 40 }),
    applyLayout: async (_ptyId, target) => {
      size = { cols: target.cols, rows: target.rows }
      applied.push(size)
      return { ok: true }
    },
    now: () => now
  })
  return {
    floor,
    applied,
    size: () => size,
    advance: (ms: number) => {
      now += ms
    }
  }
}

async function attachPassively(host: ReturnType<typeof twoClientHost>) {
  // Subscribing records geometry without taking control.
  await host.floor.updateViewer(PTY, A, 'client-a', 100, 30, false)
  await host.floor.updateViewer(PTY, B, 'client-b', 80, 24, false)
}

describe('remote desktop geometry follows the latest typist', () => {
  it('moves the grid to whoever types, when the owner is quiet', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    expect(host.applied).toEqual([])

    await host.floor.claimViewerForInput(PTY, A)
    expect(host.size()).toEqual({ cols: 100, rows: 30 })
    host.advance(REMOTE_DESKTOP_INPUT_CLAIM_QUIET_MS + 1)
    await host.floor.claimViewerForInput(PTY, B)
    expect(host.size()).toEqual({ cols: 80, rows: 24 })
    expect(host.floor.isViewerOwner(PTY, B)).toBe(true)
  })

  it('does not flip the grid on every keystroke while two clients type concurrently', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    await host.floor.claimViewerForInput(PTY, A)
    for (let keystroke = 0; keystroke < 20; keystroke++) {
      host.advance(50)
      // Damped claims still admit the input: shared control at the owner's grid.
      await expect(host.floor.claimViewerForInput(PTY, B)).resolves.toBe(true)
      host.advance(50)
      await host.floor.claimViewerForInput(PTY, A)
    }
    expect(host.applied).toEqual([{ cols: 100, rows: 30 }])
    expect(host.floor.isViewerOwner(PTY, A)).toBe(true)
  })

  it('repeated input from the owner applies no layout at all', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    await host.floor.claimViewerForInput(PTY, A)
    for (let keystroke = 0; keystroke < 10; keystroke++) {
      host.advance(10)
      await host.floor.claimViewerForInput(PTY, A)
    }
    expect(host.applied).toHaveLength(1)
  })

  it('an explicit claim still takes the grid immediately', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    await host.floor.claimViewerForInput(PTY, A)
    host.advance(10)
    await host.floor.claimViewer(PTY, B)
    expect(host.size()).toEqual({ cols: 80, rows: 24 })
  })

  it('damps a remote typist against recent host-local input too', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    await host.floor.claimHost(PTY, 120, 40)
    host.advance(10)
    await host.floor.claimViewerForInput(PTY, A)
    expect(host.applied).toEqual([])
    host.advance(REMOTE_DESKTOP_INPUT_CLAIM_QUIET_MS)
    await host.floor.claimViewerForInput(PTY, A)
    expect(host.size()).toEqual({ cols: 100, rows: 30 })
  })

  it('refuses to claim for a stream that never reported geometry', async () => {
    const host = twoClientHost()
    await expect(host.floor.claimViewerForInput(PTY, A)).resolves.toBe(false)
    expect(host.applied).toEqual([])
  })

  it('forgets input history with the PTY', async () => {
    const host = twoClientHost()
    await attachPassively(host)
    await host.floor.claimViewerForInput(PTY, A)
    host.floor.clearPty(PTY)
    await attachPassively(host)
    await host.floor.claimViewerForInput(PTY, B)
    expect(host.floor.isViewerOwner(PTY, B)).toBe(true)
  })

  it('two legacy clients resizing converge on the last resize without re-applying equal geometry', async () => {
    const host = twoClientHost()
    // Legacy clients claim on every Resize frame.
    await host.floor.updateViewer(PTY, A, 'client-a', 100, 30, true)
    await host.floor.updateViewer(PTY, A, 'client-a', 100, 30, true)
    await host.floor.updateViewer(PTY, B, 'client-b', 80, 24, true)
    await host.floor.updateViewer(PTY, B, 'client-b', 80, 24, true)
    expect(host.applied).toEqual([
      { cols: 100, rows: 30 },
      { cols: 80, rows: 24 }
    ])
    expect(host.floor.isViewerOwner(PTY, B)).toBe(true)
  })
})
