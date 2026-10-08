import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { SESSION_TAB_METHODS } from './session-tabs'

type Listener = (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void

function snapshot(
  worktree: string,
  snapshotVersion: number,
  extra: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: `tab-${snapshotVersion}`,
    activeTabType: 'terminal',
    tabs: [],
    ...extra
  }
}

function createRuntime(initial: RuntimeMobileSessionTabsResult[]) {
  const listeners: Listener[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these streams reach only these runtime members; a missing one throws and fails the test.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabsWithChangeSequence: vi.fn(async () => ({
      snapshots: initial,
      changeSequence: 0
    })),
    listMobileSessionTabs: vi.fn(async () => initial[0]),
    onMobileSessionTabsChanged: vi.fn((listener: Listener) => {
      listeners.push(listener)
      return vi.fn()
    }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn()
  } as unknown as OrcaRuntimeService
  let sequence = 0
  return {
    runtime,
    publish: (next: RuntimeMobileSessionTabsResult) => {
      sequence += 1
      for (const listener of listeners) {
        listener(next, sequence)
      }
    }
  }
}

function updatedFrames(messages: string[]): RuntimeMobileSessionTabsResult[] {
  return messages
    .map((message) => JSON.parse(message).result)
    .filter((result) => result?.type === 'updated')
}

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'sub-1', authToken: 'tok', method, params }
}

describe('session.tabs publication under connection backpressure (#22151)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends only the newest frame per worktree once a backlogged link drains', async () => {
    const { runtime, publish } = createRuntime([snapshot('wt-a', 1), snapshot('wt-b', 1)])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    let backlog = 0
    await dispatcher.dispatchStreaming(
      request('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1', outboundBacklogBytes: () => backlog }
    )

    backlog = 1024 * 1024
    for (let version = 2; version <= 21; version += 1) {
      publish(snapshot('wt-a', version))
      publish(snapshot('wt-b', version))
    }
    publish(snapshot('wt-a', 22))
    await vi.advanceTimersByTimeAsync(200)
    expect(updatedFrames(messages)).toEqual([])

    backlog = 0
    await vi.advanceTimersByTimeAsync(50)

    // wt-b last changed before wt-a's final change, so it drains first.
    expect(updatedFrames(messages).map((frame) => [frame.worktree, frame.snapshotVersion])).toEqual(
      [
        ['wt-b', 21],
        ['wt-a', 22]
      ]
    )
  })

  it('sends every change immediately while the link keeps up', async () => {
    const { runtime, publish } = createRuntime([snapshot('wt-a', 1)])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    await dispatcher.dispatchStreaming(
      request('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1', outboundBacklogBytes: () => 0 }
    )

    for (let version = 2; version <= 6; version += 1) {
      publish(snapshot('wt-a', version))
    }

    expect(updatedFrames(messages).map((frame) => frame.snapshotVersion)).toEqual([2, 3, 4, 5, 6])
  })

  it('never supersedes a one-shot follow intent with a later parked frame', async () => {
    const { runtime, publish } = createRuntime([snapshot('wt-a', 1)])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    let backlog = 1024 * 1024
    await dispatcher.dispatchStreaming(
      request('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1', outboundBacklogBytes: () => backlog }
    )

    publish(snapshot('wt-a', 2))
    publish(snapshot('wt-a', 3, { navigationIntent: 'follow' }))
    publish(snapshot('wt-a', 4))
    backlog = 0
    await vi.advanceTimersByTimeAsync(50)

    expect(
      updatedFrames(messages).map((frame) => [frame.snapshotVersion, frame.navigationIntent])
    ).toEqual([
      [3, 'follow'],
      [4, undefined]
    ])
  })

  it('applies the same latest-wins publication to a single-worktree subscription', async () => {
    const { runtime, publish } = createRuntime([snapshot('wt-a', 1)])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    let backlog = 1024 * 1024
    await dispatcher.dispatchStreaming(
      request('session.tabs.subscribe', { worktree: 'wt-a' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1', outboundBacklogBytes: () => backlog }
    )

    for (let version = 2; version <= 30; version += 1) {
      publish(snapshot('wt-a', version))
    }
    publish(snapshot('wt-other', 99))
    backlog = 0
    await vi.advanceTimersByTimeAsync(50)

    expect(updatedFrames(messages).map((frame) => frame.snapshotVersion)).toEqual([30])
  })

  it('keeps the in-process and legacy path unchanged when no backlog signal exists', async () => {
    const { runtime, publish } = createRuntime([snapshot('wt-a', 1)])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    await dispatcher.dispatchStreaming(
      request('session.tabs.subscribe', { worktree: 'wt-a' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )

    for (let version = 2; version <= 4; version += 1) {
      publish(snapshot('wt-a', version))
    }

    expect(updatedFrames(messages).map((frame) => frame.snapshotVersion)).toEqual([2, 3, 4])
  })
})
