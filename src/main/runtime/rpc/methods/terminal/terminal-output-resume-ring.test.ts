import { describe, expect, it } from 'vitest'
import { sourceRange } from '../../terminal-multiplex-source-range-fixtures'
import { TerminalOutputResumeRing } from './terminal-output-resume-ring'

function feed(ring: TerminalOutputResumeRing, start: number, ...chunks: string[]): number {
  let seq = start
  for (const chunk of chunks) {
    seq += chunk.length
    ring.record(chunk, { seq, rawLength: chunk.length })
  }
  return seq
}

function tailText(ring: TerminalOutputResumeRing, seq: number): string | null {
  const tail = ring.tailAfter({ token: ring.resumeToken, seq })
  return tail ? tail.map((chunk) => chunk.data).join('') : null
}

describe('TerminalOutputResumeRing', () => {
  it('returns exactly the output after the resume point, slicing a partly applied chunk', () => {
    const ring = new TerminalOutputResumeRing(10)
    feed(ring, 10, 'hello ', 'world\r\n', 'more')
    expect(tailText(ring, 10)).toBe('hello world\r\nmore')
    expect(tailText(ring, 13)).toBe('lo world\r\nmore')
    expect(tailText(ring, 16)).toBe('world\r\nmore')
  })

  it('resumes an idle terminal at its seeded position with an empty tail', () => {
    const ring = new TerminalOutputResumeRing(42)
    expect(tailText(ring, 42)).toBe('')
    expect(tailText(ring, 41)).toBeNull()
    expect(tailText(ring, 43)).toBeNull()
  })

  it('refuses a point older than the retained window once the byte budget evicts it', () => {
    const ring = new TerminalOutputResumeRing(0, 8)
    feed(ring, 0, 'aaaa', 'bbbb', 'cccc')
    expect(ring.retainedBytes()).toBeLessThanOrEqual(8)
    expect(tailText(ring, 0)).toBeNull()
    expect(tailText(ring, 4)).toBe('bbbbcccc')
  })

  it('starts a new token on a sequence discontinuity so an old point cannot match', () => {
    const ring = new TerminalOutputResumeRing(0)
    feed(ring, 0, 'first')
    const before = ring.resumeToken
    // A respawned PTY restarts its sequence domain.
    ring.record('again', { seq: 5, rawLength: 5 })
    expect(ring.resumeToken).not.toBe(before)
    expect(ring.tailAfter({ token: before, seq: 0 })).toBeNull()
    expect(tailText(ring, 0)).toBe('again')
  })

  it('forgets every position when a chunk carries no sequence', () => {
    const ring = new TerminalOutputResumeRing(0)
    feed(ring, 0, 'abc')
    ring.record('unplaced')
    expect(tailText(ring, 3)).toBeNull()
    ring.record('next', { seq: 20, rawLength: 4 })
    expect(tailText(ring, 16)).toBe('next')
  })

  it('falls back when the missed tail holds a reply-eliciting query the host already answered', () => {
    const ring = new TerminalOutputResumeRing(0)
    const end = feed(ring, 0, 'prompt$ ', '\x1b[6n', 'after')
    expect(tailText(ring, 0)).toBeNull()
    expect(tailText(ring, 'prompt$ \x1b[6n'.length)).toBe('after')
    expect(end).toBe('prompt$ \x1b[6nafter'.length)
  })

  it('does not treat the color-scheme subscription toggle as a reply query', () => {
    const ring = new TerminalOutputResumeRing(0)
    feed(ring, 0, 'x\x1b[?2031hy')
    expect(tailText(ring, 0)).toBe('x\x1b[?2031hy')
  })

  it('refuses to split a transformed chunk whose display text cannot map to raw offsets', () => {
    const ring = new TerminalOutputResumeRing(0)
    ring.record('shown', { seq: 10, rawLength: 10, transformed: true })
    expect(tailText(ring, 0)).toBe('shown')
    expect(tailText(ring, 4)).toBeNull()
  })

  it('never replays source ranges owned by an earlier stream generation', () => {
    const ring = new TerminalOutputResumeRing(0)
    ring.record('abc', {
      seq: 3,
      rawLength: 3,
      cwd: '/work',
      sourceRanges: [sourceRange(0, 3)]
    })
    const tail = ring.tailAfter({ token: ring.resumeToken, seq: 0 })
    expect(tail?.[0]?.meta).toEqual({ seq: 3, rawLength: 3, cwd: '/work' })
  })
})
