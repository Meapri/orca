// @vitest-environment happy-dom
/**
 * Fast Korean typing replayed against what Claude Code and Codex actually painted: each syllable
 * is composed and committed where the capture typed it, spaces and punctuation arrive as the text
 * system inserts them, and the app's own output is fed between keys exactly as it arrived. What the
 * user sees on the input row must read as everything typed so far plus the syllable being composed,
 * with no step where a held commit, a space or the preedit is misplaced.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalImeCandidateAnchor } from '@/lib/pane-manager/terminal-ime-candidate-anchor'
import {
  compositionEvent,
  installGridPreeditTestHooks,
  openTerminal,
  renderedText,
  settle,
  underlinedText
} from './terminal-ime-grid-preedit-test-rig'

installGridPreeditTestHooks()

// Recorded with config/scripts/capture-agent-pty-transcript.mjs; see each .meta.json.
const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')

type Send = { text: string; transcriptByteOffset: number }

function isHangul(text: string): boolean {
  return /^[가-힣]$/.test(text)
}

function compose(terminal: Terminal, syllable: string): void {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(compositionEvent('compositionstart', ''))
  textarea.value += syllable
  textarea.dispatchEvent(compositionEvent('compositionupdate', syllable))
}

function commit(terminal: Terminal, syllable: string): void {
  terminal.textarea!.dispatchEvent(compositionEvent('compositionend', syllable))
}

function insertText(terminal: Terminal, text: string): void {
  terminal.textarea!.dispatchEvent(
    new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true })
  )
}

describe.each([
  { name: 'claude-code-ime-korean-fast-typed', row: 27, prompt: '❯' },
  { name: 'codex-ime-korean-fast-typed', row: 26, prompt: '›' }
])('fast Korean typing in $name', ({ name, row, prompt }) => {
  it('shows every typed syllable, space and mark in order, with the preedit after them', async () => {
    const data = readFileSync(join(FIXTURES, `${name}.txt`))
    const meta: { cols: number; rows: number; sends: Send[] } = JSON.parse(
      readFileSync(join(FIXTURES, `${name}.meta.json`), 'utf8')
    )
    const { container, terminal } = openTerminal({ cols: meta.cols, rows: meta.rows })
    let offset = 0
    const feedTo = async (end: number): Promise<void> => {
      // Bytes, not decoded text: a slice can end inside a UTF-8 sequence xterm must reassemble.
      const chunk = data.subarray(offset, end)
      await new Promise<void>((resolve) => terminal.write(chunk, resolve))
      offset = end
    }
    const typing = meta.sends.slice(
      0,
      meta.sends.findIndex((send) => send.text.startsWith('\x1b'))
    )
    expect(typing.map((send) => send.text).join('')).toBe('안녕하세요, 반가워요! 테스트')

    await feedTo(typing[0].transcriptByteOffset)
    terminal.focus()
    installTerminalImeCandidateAnchor(terminal)
    let typed = ''
    const shown = (): string => renderedText(container, row).replace(/ /g, ' ')
    for (const [index, send] of typing.entries()) {
      await feedTo(send.transcriptByteOffset)
      if (isHangul(send.text)) {
        compose(terminal, send.text)
        await settle()
        expect(shown(), `composing ${send.text} after "${typed}"`).toContain(
          `${prompt} ${typed}${send.text}`
        )
        expect(underlinedText(container, row)).toBe(send.text)
        commit(terminal, send.text)
      } else {
        insertText(terminal, send.text)
      }
      typed += send.text
      const next = typing[index + 1]
      if (next) {
        await feedTo(next.transcriptByteOffset)
        await settle()
        expect(shown(), `after "${typed}"`).toContain(`${prompt} ${typed.trimEnd()}`)
      }
    }
    await feedTo(meta.sends[typing.length].transcriptByteOffset)
    await settle()
    expect(shown()).toContain(`${prompt} ${typed}`)
  })
})
