import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_CARET_ARMING_WINDOW_MS, AppCaretAdoption } from './terminal-app-caret-adoption'
import { scanAppDrawnCarets } from './terminal-app-drawn-caret'

// Recorded with config/scripts/capture-agent-pty-transcript.mjs at 100x30; see each .meta.json.
const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')
// cursor-agent repaints its input box once per key with this prefix.
const CURSOR_AGENT_REPAINT = `${'\x1b[2K\x1b[1A'.repeat(5)}\x1b[2K\x1b[G`

type Rig = {
  terminal: Terminal
  adoption: AppCaretAdoption
  clock: { now: number }
  setEnabled: (enabled: boolean) => void
}

const adoptions: AppCaretAdoption[] = []

afterEach(() => {
  adoptions.splice(0).forEach((adoption) => adoption.dispose())
})

function openRig(cols = 100, rows = 30): Rig {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  const clock = { now: 10_000 }
  let enabled = true
  const adoption = new AppCaretAdoption(
    terminal,
    () => enabled,
    () => clock.now
  )
  adoptions.push(adoption)
  return {
    terminal,
    adoption,
    clock,
    setEnabled: (value) => {
      enabled = value
      adoption.invalidate()
    }
  }
}

function write(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function transcript(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')
}

/** The startup screen, then one chunk per key the capture sent. */
function cursorAgentFrames(name: string): { prelude: string; frames: string[] } {
  const [prelude, ...frames] = transcript(name).split(CURSOR_AGENT_REPAINT)
  return { prelude, frames: frames.map((frame) => CURSOR_AGENT_REPAINT + frame) }
}

/** A key the user typed, whose echo lands a few milliseconds later. */
async function typeAndEcho(rig: Rig, echo: string | Uint8Array): Promise<void> {
  rig.adoption.noteInput()
  rig.clock.now += 12
  await write(rig.terminal, echo)
}

function loneCaret(terminal: Terminal): { x: number; y: number } | undefined {
  const scan = scanAppDrawnCarets({
    buffer: terminal.buffer.active,
    rows: terminal.rows,
    cols: terminal.cols
  })
  return scan.nearest ? { x: scan.nearest.column, y: scan.nearest.row } : undefined
}

describe('AppCaretAdoption on captured agent transcripts', () => {
  it('leaves cursor-agent’s startup caret to the app until a key moves it', async () => {
    const rig = openRig()
    const { prelude, frames } = cursorAgentFrames('cursor-agent-ime-korean-typed')
    await write(rig.terminal, prelude)

    expect(rig.terminal.modes.showCursor).toBe(false)
    expect(loneCaret(rig.terminal)).toEqual({ x: 4, y: 9 })
    expect(rig.adoption.resolve()).toBeUndefined()

    await typeAndEcho(rig, frames[0])
    expect(rig.adoption.resolve()).toEqual(loneCaret(rig.terminal))
    expect(rig.adoption.resolve()).not.toEqual({ x: 4, y: 9 })
  })

  it('follows cursor-agent’s caret through Korean, Latin, Backspace and Left/Right', async () => {
    const rig = openRig()
    const { prelude, frames } = cursorAgentFrames('cursor-agent-ime-korean-typed')
    await write(rig.terminal, prelude)

    expect(frames.length).toBeGreaterThan(5)
    const columns: number[] = []
    for (const frame of frames) {
      await typeAndEcho(rig, frame)
      const adopted = rig.adoption.resolve()
      expect(adopted).toEqual(loneCaret(rig.terminal))
      columns.push(adopted!.x)
    }
    // "→ 안녕 하세요a한b" with the caret moved back onto "b"; the buffer keeps the app's inverse.
    expect(rig.adoption.resolve()).toEqual({ x: 18, y: 9 })
    const buffer = rig.terminal.buffer.active
    const cell = buffer.getLine(buffer.baseY + 9)!.getCell(18)!
    expect(cell.getChars()).toBe('b')
    expect(cell.isInverse()).not.toBe(0)
    // Left/Right moved it back and forth, so the rule follows the app rather than typing order.
    expect(new Set(columns).size).toBeGreaterThan(3)
  })

  it.each(['claude-code-ime-korean-typed', 'codex-ime-korean-typed', 'grok-ime-korean-typed'])(
    'never adopts in %s, which keeps its real cursor on the caret',
    async (name) => {
      const rig = openRig()
      const bytes = readFileSync(join(FIXTURES, `${name}.txt`))
      // Every chunk is treated as the echo of a key, the most permissive arming there is.
      for (let offset = 0; offset < bytes.length; offset += 256) {
        await typeAndEcho(rig, bytes.subarray(offset, offset + 256))
        expect(rig.adoption.resolve()).toBeUndefined()
      }
      expect(rig.terminal.modes.showCursor).toBe(true)
    }
  )
})

describe('AppCaretAdoption guards', () => {
  it('never adopts a highlighted run of inverse cells', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l')
    await typeAndEcho(rig, '\x1b[H\x1b[7m› 1. Trust and continue\x1b[27m\r\n  2. Quit')
    await typeAndEcho(rig, '\x1b[H  1. Trust and continue\r\n\x1b[7m› 2. Quit\x1b[27m')

    expect(rig.adoption.resolve()).toBeUndefined()
  })

  it('adopts the lone caret beside a highlighted run, but not two lone cells', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l\x1b[7m menu \x1b[27m\r\n> a')
    await typeAndEcho(rig, '\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).toEqual({ x: 3, y: 1 })

    await typeAndEcho(rig, '\x1b[3;1H\x1b[7m?\x1b[27m')
    expect(rig.adoption.resolve()).toBeUndefined()
  })

  it('drops adoption when the caret disappears and when the real cursor is shown', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l> ')
    await typeAndEcho(rig, 'a\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).toEqual({ x: 3, y: 0 })

    await write(rig.terminal, '\x1b[1;1H\x1b[2K> a')
    expect(rig.adoption.resolve()).toBeUndefined()

    await typeAndEcho(rig, 'b\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).toEqual({ x: 4, y: 0 })

    await write(rig.terminal, '\x1b[?25h')
    expect(rig.adoption.resolve()).toBeUndefined()

    // Hidden again, the same caret is not adopted until a key moves it once more.
    rig.clock.now += APP_CARET_ARMING_WINDOW_MS * 2
    await write(rig.terminal, '\x1b[?25l')
    expect(rig.adoption.resolve()).toBeUndefined()
  })

  it('stays armed while the cursor stays hidden, e.g. after the caret is repainted elsewhere', async () => {
    const rig = openRig(40, 6)
    await write(rig.terminal, '\x1b[?25l> ')
    await typeAndEcho(rig, 'a\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).toEqual({ x: 3, y: 0 })
    rig.clock.now += APP_CARET_ARMING_WINDOW_MS * 4
    await write(rig.terminal, '\x1b[1;1H\x1b[2K\x1b[4;1H> \x1b[7m \x1b[27m')

    expect(rig.adoption.resolve()).toEqual({ x: 2, y: 3 })
  })

  it('never arms on a caret that moves without local input', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l> ')
    for (const text of ['a', 'b', 'c']) {
      rig.clock.now += APP_CARET_ARMING_WINDOW_MS + 1
      await write(rig.terminal, `\x1b[1;1H\x1b[2K> ${text}\x1b[7m \x1b[27m`)
      expect(rig.adoption.resolve()).toBeUndefined()
    }
  })

  it('never adopts in the alternate screen', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?1049h\x1b[?25l> ')
    await typeAndEcho(rig, 'a\x1b[7m \x1b[27m')

    expect(rig.adoption.resolve()).toBeUndefined()
  })

  it('follows the setting', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l> ')
    await typeAndEcho(rig, 'a\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).toEqual({ x: 3, y: 0 })

    rig.setEnabled(false)
    expect(rig.adoption.resolve()).toBeUndefined()
    rig.setEnabled(true)
    expect(rig.adoption.resolve()).toBeUndefined()
  })

  it('rescans only after output, so repeated render passes reuse the answer', async () => {
    const rig = openRig(40, 4)
    await write(rig.terminal, '\x1b[?25l> ')
    await typeAndEcho(rig, 'a\x1b[7m \x1b[27m')
    const first = rig.adoption.resolve()

    expect(rig.adoption.resolve()).toBe(first)
    await typeAndEcho(rig, '\x1b[1;1H\x1b[2K> ab\x1b[7m \x1b[27m')
    expect(rig.adoption.resolve()).not.toBe(first)
    expect(rig.adoption.resolve()).toEqual({ x: 4, y: 0 })
  })
})
