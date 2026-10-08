import { is } from '@electron-toolkit/utils'
import { APP_DISTRIBUTION } from '../../shared/app-distribution'

/** Why: the packaged desktop gets its own default port so it never races the official Orca's 6768. */
export function desktopRuntimeWsPortOption(isE2E: boolean, isServe: boolean): { wsPort?: number } {
  return is.dev || isE2E || isServe ? {} : { wsPort: APP_DISTRIBUTION.desktopRuntimeWebSocketPort }
}
