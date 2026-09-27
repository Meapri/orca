import { createCodexSessionResumeLaunchPreparation } from '../codex/codex-session-resume-launch-preparation'
import { mainProcessState as state } from './main-process-state'

export const prepareCodexSessionResumeForLaunch = createCodexSessionResumeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})
