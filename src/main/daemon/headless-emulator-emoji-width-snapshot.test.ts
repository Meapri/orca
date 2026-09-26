/**
 * #18779: VS16 emoji, keycaps and post-Unicode-11 emoji are two cells in both the
 * daemon model and the renderer. Both sides share terminal-unicode-provider.ts, so
 * this pins that a restore the renderer replays lands every cell where the model
 * put it, including when the widened emoji straddles the wrap boundary.
 */
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import {
  createRendererParityTerminal,
  cursorPosition,
  visibleRowStyles,
  visibleRows,
  writeToTerminal
} from '../../shared/terminal-restore-parity-fixture'
import type { Terminal } from '@xterm/headless'

const VS16 = String.fromCodePoint(0xfe0f)
const ZWJ = String.fromCodePoint(0x200d)
const KEYCAP = String.fromCodePoint(0x20e3)
const LINE = [
  `ok ${String.fromCodePoint(0x2764)}${VS16} done`,
  `step 1${VS16}${KEYCAP} of 3`,
  `flag ${String.fromCodePoint(0x1f3f3)}${VS16}${ZWJ}${String.fromCodePoint(0x1f308)} |`,
  `new ${String.fromCodePoint(0x1fae0)} ${String.fromCodePoint(0x1f972)} |`,
  '한글 漢字 かな |'
].join(' ')

function modelTerminal(emu: HeadlessEmulator): Terminal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reads the emulator's private headless terminal to compare against the replay.
  return (emu as unknown as { terminal: Terminal }).terminal
}

describe('headless emulator emoji-width snapshot parity', () => {
  it('replays VS16, keycap and new emoji onto the same cells across wrap widths', async () => {
    const mismatches: string[] = []
    for (let cols = 10; cols <= 48; cols++) {
      const emu = new HeadlessEmulator({ cols, rows: 12 })
      emu.write(`${LINE}\r\n${LINE}`)
      const model = modelTerminal(emu)
      const snapshot = emu.getSnapshot({ scrollbackRows: 200 })
      const replay = createRendererParityTerminal({ cols, rows: 12 })
      await writeToTerminal(
        replay.terminal,
        `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi}`
      )
      const expected = {
        rows: visibleRows(model),
        styles: visibleRowStyles(model),
        cursor: cursorPosition(model)
      }
      const actual = {
        rows: visibleRows(replay.terminal),
        styles: visibleRowStyles(replay.terminal),
        cursor: cursorPosition(replay.terminal)
      }
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(
          `cols=${cols}\n  model:  ${expected.rows.join('⏎')}\n  replay: ${actual.rows.join('⏎')}`
        )
      }
      replay.terminal.dispose()
      emu.dispose()
    }
    expect(mismatches).toEqual([])
  })

  it('budgets the widened emoji as two cells in the daemon model', () => {
    const emu = new HeadlessEmulator({ cols: 40, rows: 4 })
    emu.write(`${String.fromCodePoint(0x2764)}${VS16}x`)
    const model = modelTerminal(emu)
    expect(model.buffer.active.cursorX).toBe(3)
    expect(model.buffer.active.getLine(0)?.getCell(0)?.getWidth()).toBe(2)
    emu.dispose()
  })
})
