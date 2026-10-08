/**
 * `orca serve doctor`: preflight for an orcad host, each finding paired with the command that
 * fixes it. Checks that need the running server read its `server.health`; the rest inspect the
 * host directly, so the doctor still answers when orcad will not start.
 */
import process from 'node:process'
import {
  checkDataRoot,
  checkInstanceLock,
  checkRuntime,
  checkSocketPath
} from './orcad-doctor-local-checks'
import { checkBind, checkDaemonIsolation, checkNodeAbi } from './orcad-doctor-server-checks'
import type { OrcadDoctorCheck, OrcadDoctorInputs } from './orcad-doctor-report'
import {
  checkDaemonScopeSupport,
  checkDiskSpace,
  checkGlibcFloor,
  checkUserLinger
} from './orcad-doctor-host-checks'

export type { OrcadDoctorCheck, OrcadDoctorInputs, OrcadDoctorStatus } from './orcad-doctor-report'

export async function runOrcadDoctor(inputs: OrcadDoctorInputs): Promise<OrcadDoctorCheck[]> {
  const platform = inputs.platform ?? process.platform
  return [
    checkDataRoot(inputs.dataRoot, platform),
    checkSocketPath(inputs.dataRoot, platform),
    checkInstanceLock(inputs.dataRoot, inputs.running),
    checkRuntime(inputs),
    await checkBind(inputs),
    checkDaemonScopeSupport(platform),
    checkUserLinger(platform),
    checkDaemonIsolation(inputs),
    checkGlibcFloor(platform),
    checkNodeAbi(inputs),
    await checkDiskSpace(inputs.dataRoot)
  ]
}
