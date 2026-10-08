/** Which browser backend orcad may start: `--browser` or `ORCA_BROWSER_PROVIDER`. */
export const ORCAD_BROWSER_MODES = ['none', 'auto', 'electron', 'chromium'] as const

export type OrcadBrowserMode = (typeof ORCAD_BROWSER_MODES)[number]

export const ORCAD_BROWSER_MODE_ENV = 'ORCA_BROWSER_PROVIDER'

function isOrcadBrowserMode(value: string): value is OrcadBrowserMode {
  return ORCAD_BROWSER_MODES.some((mode) => mode === value)
}

export function parseOrcadBrowserMode(value: string, source: string): OrcadBrowserMode {
  const normalized = value.trim().toLowerCase()
  if (!isOrcadBrowserMode(normalized)) {
    throw new Error(`${source} expects one of ${ORCAD_BROWSER_MODES.join('|')}, got '${value}'`)
  }
  return normalized
}

/** The flag wins over the env var; an unset or blank env var means `auto`. */
export function resolveOrcadBrowserMode(
  flag: OrcadBrowserMode | undefined,
  environment: NodeJS.ProcessEnv
): OrcadBrowserMode {
  if (flag) {
    return flag
  }
  const fromEnvironment = environment[ORCAD_BROWSER_MODE_ENV]
  return fromEnvironment?.trim()
    ? parseOrcadBrowserMode(fromEnvironment, ORCAD_BROWSER_MODE_ENV)
    : 'auto'
}
