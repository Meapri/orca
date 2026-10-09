// The vocabulary every `orca serve doctor` check reports in.
import type { OrcadServerHealth } from '../../shared/orcad-server-health-contract'

export type OrcadDoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'

export type OrcadDoctorCheck = {
  id: string
  status: OrcadDoctorStatus
  summary: string
  fix?: string
}

export type OrcadDoctorInputs = {
  dataRoot: string
  bindHost: string
  port: number
  /** True when the operator passes `--port`, which orcad refuses to move off. */
  portPinned: boolean
  running: OrcadServerHealth | null
  /** Why `running` is null when a runtime answered or failed: e.g. `method_not_found`. */
  runningError: string | null
  platform?: NodeJS.Platform
}
