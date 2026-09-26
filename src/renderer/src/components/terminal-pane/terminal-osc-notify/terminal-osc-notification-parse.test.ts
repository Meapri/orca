import { describe, expect, it } from 'vitest'
import { parseOsc777Payload, parseOsc9Payload } from './terminal-osc-notification-parse'

describe('parseOsc9Payload', () => {
  it('parses an iTerm2 notification', () => {
    expect(parseOsc9Payload('Build finished')).toEqual({
      kind: 'notification',
      notification: { title: null, body: 'Build finished' }
    })
  })

  it('strips control characters and collapses whitespace from program text', () => {
    expect(parseOsc9Payload('  done\u0007\u001b[31m\n  now ')).toEqual({
      kind: 'notification',
      notification: { title: null, body: 'done [31m now' }
    })
  })

  it('caps very long messages', () => {
    const event = parseOsc9Payload('x'.repeat(2_000))
    expect(event?.kind === 'notification' && event.notification.body.length).toBe(500)
  })

  it.each([
    ['4;1;42', { kind: 'set', state: 'normal', percent: 42 }],
    ['4;1', { kind: 'set', state: 'normal', percent: null }],
    ['4;2;150', { kind: 'set', state: 'error', percent: 100 }],
    ['4;3;50', { kind: 'set', state: 'indeterminate', percent: null }],
    ['4;4;-3', { kind: 'set', state: 'paused', percent: 0 }],
    ['4;0', { kind: 'clear' }],
    ['4;0;0', { kind: 'clear' }]
  ])('parses ConEmu progress %s', (payload, progress) => {
    expect(parseOsc9Payload(payload)).toEqual({ kind: 'progress', progress })
  })

  it.each(['9;/Users/me/project', '1;500', '2;message box', '4;9;10', '4;', '', '   '])(
    'ignores other ConEmu sub-commands and empty payloads: %j',
    (payload) => {
      expect(parseOsc9Payload(payload)).toBeNull()
    }
  )

  it('treats text that merely starts with a digit as a notification', () => {
    expect(parseOsc9Payload('3 tests failed')).toEqual({
      kind: 'notification',
      notification: { title: null, body: '3 tests failed' }
    })
  })
})

describe('parseOsc777Payload', () => {
  it('parses title and body, keeping semicolons inside the body', () => {
    expect(parseOsc777Payload('notify;Deploy;done; 3 services')).toEqual({
      title: 'Deploy',
      body: 'done; 3 services'
    })
  })

  it('uses a lone title as the body', () => {
    expect(parseOsc777Payload('notify;Tests passed')).toEqual({ title: null, body: 'Tests passed' })
  })

  it.each(['orca-shell-ready', 'orca-shell-start:123', 'notify', 'notify;;', 'preexec'])(
    'ignores non-notification 777 payloads: %j',
    (payload) => {
      expect(parseOsc777Payload(payload)).toBeNull()
    }
  )
})
