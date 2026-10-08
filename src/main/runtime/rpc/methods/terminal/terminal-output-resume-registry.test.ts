import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalOutputMeta } from '../../terminal-output-frame-chunks'
import { TerminalOutputResumeRegistry } from './terminal-output-resume-registry'

function fakeRuntime() {
  const listeners = new Map<string, Set<(data: string, meta?: TerminalOutputMeta) => void>>()
  const sequences = new Map<string, number>()
  return {
    listeners,
    getPtyOutputSequence: (ptyId: string) => sequences.get(ptyId) ?? 0,
    subscribeToTerminalData: (
      ptyId: string,
      listener: (data: string, meta?: TerminalOutputMeta) => void
    ) => {
      const set = listeners.get(ptyId) ?? new Set()
      set.add(listener)
      listeners.set(ptyId, set)
      return () => set.delete(listener)
    },
    emit(ptyId: string, data: string) {
      const seq = (sequences.get(ptyId) ?? 0) + data.length
      sequences.set(ptyId, seq)
      for (const listener of listeners.get(ptyId) ?? []) {
        listener(data, { seq, rawLength: data.length })
      }
    }
  }
}

describe('TerminalOutputResumeRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps recording after the last stream detaches so a reconnect finds the missed output', () => {
    const runtime = fakeRuntime()
    const registry = new TerminalOutputResumeRegistry(runtime, 60_000)
    runtime.emit('pty-1', 'before')
    const first = registry.acquire('pty-1')
    const token = first.ring.resumeToken
    runtime.emit('pty-1', 'seen')
    first.release()
    runtime.emit('pty-1', 'missed')
    vi.advanceTimersByTime(59_000)
    const second = registry.acquire('pty-1')
    expect(second.ring).toBe(first.ring)
    expect(
      second.ring.tailAfter({ token, seq: 'beforeseen'.length })?.map((chunk) => chunk.data)
    ).toEqual(['missed'])
    second.release()
  })

  it('drops an idle ring after the retention window and stops listening', () => {
    const runtime = fakeRuntime()
    const registry = new TerminalOutputResumeRegistry(runtime, 60_000)
    const lease = registry.acquire('pty-1')
    lease.release()
    lease.release()
    vi.advanceTimersByTime(60_000)
    expect(registry.ringCount()).toBe(0)
    expect(runtime.listeners.get('pty-1')?.size ?? 0).toBe(0)
    const fresh = registry.acquire('pty-1')
    expect(fresh.ring).not.toBe(lease.ring)
  })

  it('shares one ring between concurrent streams and waits for both to detach', () => {
    const runtime = fakeRuntime()
    const registry = new TerminalOutputResumeRegistry(runtime, 1_000)
    const a = registry.acquire('pty-1')
    const b = registry.acquire('pty-1')
    a.release()
    vi.advanceTimersByTime(5_000)
    expect(registry.ringCount()).toBe(1)
    expect(runtime.listeners.get('pty-1')?.size).toBe(1)
    b.release()
    vi.advanceTimersByTime(1_000)
    expect(registry.ringCount()).toBe(0)
  })

  it('evicts the oldest idle rings beyond the idle cap', () => {
    const runtime = fakeRuntime()
    const registry = new TerminalOutputResumeRegistry(runtime, 60_000, 2)
    for (const ptyId of ['pty-1', 'pty-2', 'pty-3']) {
      registry.acquire(ptyId).release()
    }
    const held = registry.acquire('pty-4')
    expect(registry.ringCount()).toBe(3)
    expect(runtime.listeners.get('pty-1')?.size ?? 0).toBe(0)
    held.release()
  })
})
