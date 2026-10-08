import { describe, expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'

describe('buildNotificationOptions for OSC 9 / OSC 777 program notifications', () => {
  it('keeps the workspace context and uses the program title and body', () => {
    expect(
      buildNotificationOptions({
        source: 'terminal-bell',
        repoLabel: 'orca',
        worktreeLabel: 'feat-x',
        terminalNotification: { title: 'Deploy', body: 'shipped   to prod' }
      })
    ).toEqual({ title: 'orca / feat-x - Deploy', body: 'shipped to prod' })
  })

  it('titles an untitled OSC 9 message with the workspace alone', () => {
    expect(
      buildNotificationOptions({
        source: 'terminal-bell',
        worktreeLabel: 'feat-x',
        terminalNotification: { title: null, body: 'Build finished' }
      })
    ).toEqual({ title: 'feat-x', body: 'Build finished' })
  })

  it('falls back to the plain bell banner without program text', () => {
    expect(buildNotificationOptions({ source: 'terminal-bell', worktreeLabel: 'feat-x' })).toEqual({
      title: 'Bell in feat-x',
      body: 'Attention requested'
    })
    expect(
      buildNotificationOptions({
        source: 'terminal-bell',
        worktreeLabel: 'feat-x',
        terminalNotification: { title: 'x', body: '' }
      }).title
    ).toBe('Bell in feat-x')
  })

  it('never lets program text restyle an agent completion', () => {
    const options = buildNotificationOptions({
      source: 'agent-task-complete',
      worktreeLabel: 'feat-x',
      terminalNotification: { title: 'spoof', body: 'spoof' }
    })
    expect(options.title).not.toContain('spoof')
    expect(options.body).not.toContain('spoof')
  })
})
