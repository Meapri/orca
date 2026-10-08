import { describe, expect, it } from 'vitest'
import {
  ORCAD_EXIT_CONFIGURATION,
  ORCAD_EXIT_FAILED,
  resolveOrcadExitCode
} from './orcad-exit-code'
import { WebSocketPinnedPortUnavailableError } from '../runtime/rpc/ws-transport-port-binding'

describe('resolveOrcadExitCode', () => {
  it('treats an unbindable pinned port as a configuration fault a supervisor must not retry', () => {
    const error = new WebSocketPinnedPortUnavailableError(
      '127.0.0.1',
      6768,
      Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    )

    expect(resolveOrcadExitCode(error)).toBe(ORCAD_EXIT_CONFIGURATION)
    expect(error.message).toContain('127.0.0.1:6768')
    expect(error.message).toContain('EADDRINUSE')
  })

  it('keeps an ordinary listen failure retryable', () => {
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })

    expect(resolveOrcadExitCode(error)).toBe(ORCAD_EXIT_FAILED)
  })
})
