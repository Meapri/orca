import {
  createCodexRuntimeHomeLaunchPreparation,
  createCodexStructuredLaunchHomeResolvers
} from '../codex/codex-runtime-home-launch-preparation'
import { mainProcessState as state } from './main-process-state'

export const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

export const codexStructuredLaunchHomeResolvers = createCodexStructuredLaunchHomeResolvers({
  getRuntimeHome: () => state.codexRuntimeHome,
  prepareCodexRuntimeHomeForLaunch
})
