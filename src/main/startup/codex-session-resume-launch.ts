import {
  createCodexPinnedLaunchHomePreparation,
  createCodexSessionResumeLaunchPreparation
} from '../codex/codex-session-resume-launch-preparation'
import { mainProcessState as state } from './main-process-state'

const launchPreparationDeps = {
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
}

export const prepareCodexSessionResumeForLaunch =
  createCodexSessionResumeLaunchPreparation(launchPreparationDeps)

export const prepareCodexPinnedLaunchHome =
  createCodexPinnedLaunchHomePreparation(launchPreparationDeps)
