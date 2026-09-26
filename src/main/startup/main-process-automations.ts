import { AutomationService } from '../automations/service'
import { createRuntimeHeadlessAutomationDispatcher } from '../automations/runtime-headless-dispatcher'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessAutomations(): AutomationService {
  const store = state.store
  const runtime = state.runtime
  const claudeUsage = state.claudeUsage
  const codexUsage = state.codexUsage
  if (!store || !runtime || !claudeUsage || !codexUsage) {
    throw new Error('Runtime and usage stores must be initialized before automations')
  }
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    // Why: desktop clients mirror remote-host automations, but only a server process should execute remote_host_service-owned schedules.
    allowRemoteHostScheduling: state.isServeMode,
    headlessDispatcher: state.isServeMode
      ? createRuntimeHeadlessAutomationDispatcher(runtime)
      : undefined
  })
  state.automations = service
  runtime.setAutomationService(service)
  return service
}
