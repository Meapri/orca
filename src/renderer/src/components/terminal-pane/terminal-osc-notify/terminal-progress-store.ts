import { useSyncExternalStore } from 'react'
import type { TerminalOscProgress, TerminalProgressState } from './terminal-osc-notification-parse'

export type TerminalPaneProgress = {
  tabId: string
  state: TerminalProgressState
  percent: number | null
}

// Why: a program that dies mid-task never sends 9;4;0; expire like Ghostty so a bar can't stick forever.
export const TERMINAL_PROGRESS_STALE_MS = 15_000

const progressByPaneKey = new Map<string, TerminalPaneProgress>()
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearTerminalPaneProgress(paneKey: string): void {
  const timer = staleTimers.get(paneKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    staleTimers.delete(paneKey)
  }
  if (progressByPaneKey.delete(paneKey)) {
    emit()
  }
}

export function applyTerminalPaneProgress(
  paneKey: string,
  tabId: string,
  progress: TerminalOscProgress
): void {
  if (progress.kind === 'clear') {
    clearTerminalPaneProgress(paneKey)
    return
  }
  const previous = progressByPaneKey.get(paneKey)
  // Why: ConEmu lets error/paused omit the percent, meaning "keep the current value".
  const percent =
    progress.percent === null && progress.state !== 'normal' && progress.state !== 'indeterminate'
      ? (previous?.percent ?? null)
      : progress.percent
  const next: TerminalPaneProgress = { tabId, state: progress.state, percent }
  const existingTimer = staleTimers.get(paneKey)
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer)
  }
  staleTimers.set(
    paneKey,
    setTimeout(() => clearTerminalPaneProgress(paneKey), TERMINAL_PROGRESS_STALE_MS)
  )
  if (
    previous?.tabId === next.tabId &&
    previous.state === next.state &&
    previous.percent === next.percent
  ) {
    return
  }
  progressByPaneKey.set(paneKey, next)
  emit()
}

const STATE_PRIORITY: Record<TerminalProgressState, number> = {
  error: 3,
  paused: 2,
  indeterminate: 1,
  normal: 0
}

/** One summary per tab: the most urgent pane state, and the least-complete percent within it. */
export function getTerminalTabProgress(tabId: string): TerminalPaneProgress | null {
  let summary: TerminalPaneProgress | null = null
  for (const progress of progressByPaneKey.values()) {
    if (progress.tabId !== tabId) {
      continue
    }
    if (!summary || STATE_PRIORITY[progress.state] > STATE_PRIORITY[summary.state]) {
      summary = progress
    } else if (
      progress.state === summary.state &&
      progress.percent !== null &&
      (summary.percent === null || progress.percent < summary.percent)
    ) {
      summary = progress
    }
  }
  return summary
}

export function getTerminalPaneProgress(paneKey: string): TerminalPaneProgress | null {
  return progressByPaneKey.get(paneKey) ?? null
}

export function subscribeTerminalProgress(listener: () => void): () => void {
  return subscribe(listener)
}

/** Snapshot is a stored entry, so its identity only changes when that pane's progress does. */
export function useTerminalTabProgress(tabId: string): TerminalPaneProgress | null {
  const read = (): TerminalPaneProgress | null => getTerminalTabProgress(tabId)
  return useSyncExternalStore(subscribe, read, read)
}
