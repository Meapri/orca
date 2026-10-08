import { describe, expect, it } from 'vitest'
import { COMPRESSIBLE_RUNTIME_RPC_METHODS } from './runtime-rpc-compressible-methods'

describe('compressible runtime RPC methods', () => {
  it('never admits a family that mixes secrets with attacker-influenced text', () => {
    // Why: one entry from any of these families reopens the CRIME/BREACH length side channel.
    const forbiddenFamilies = [
      'terminal.',
      'agentSession.',
      'session.tabs.',
      'accounts.',
      'devices.',
      'pairing.',
      'browser.',
      'orchestration.'
    ]
    for (const method of COMPRESSIBLE_RUNTIME_RPC_METHODS) {
      expect(
        forbiddenFamilies.some((family) => method.startsWith(family)),
        method
      ).toBe(false)
    }
    for (const contentMethod of ['files.read', 'files.readChunk', 'git.diff', 'git.commitDiff']) {
      expect(COMPRESSIBLE_RUNTIME_RPC_METHODS.has(contentMethod), contentMethod).toBe(false)
    }
  })
})
