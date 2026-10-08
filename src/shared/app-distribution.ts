// The identity this fork ships under, so it installs and runs beside the official Orca.
// Why a TS mirror of app-distribution.json: electron-builder (CJS) and build scripts read the JSON,
// while the TS builds have no JSON imports. app-distribution-contract.test.ts fails if the two drift.
export const APP_DISTRIBUTION = {
  productName: 'Orca Next',
  // Why: packaged package.json `name` and the userData dir name (`<appData>/<packageName>`).
  packageName: 'orca-next',
  appId: 'com.meapri.orca-next',
  // Why not 'orca': two installed apps claiming one scheme fight over LaunchServices.
  urlScheme: 'orca-next',
  cliCommandName: 'orca-next',
  artifactBaseName: 'orca-next',
  // Why: safeStorage-encrypted secrets cannot be shared with another app's Keychain key.
  homeStateDirName: '.orca-next',
  // Why: the official app defaults to 6768 and dev pins 6769; a shared port makes pairing racy.
  desktopRuntimeWebSocketPort: 6770,
  updateRepository: { owner: 'Meapri', repo: 'orca' },
  // Why: hourly/daily/adhoc feeds publish upstream-identity builds this app must never install.
  devChannelsEnabled: false
} as const

export const APP_DISTRIBUTION_RELEASE_REPO = `${APP_DISTRIBUTION.updateRepository.owner}/${APP_DISTRIBUTION.updateRepository.repo}`

export const APP_DISTRIBUTION_RELEASES_URL = `https://github.com/${APP_DISTRIBUTION_RELEASE_REPO}/releases`

export const APP_DISTRIBUTION_LATEST_DOWNLOAD_URL = `${APP_DISTRIBUTION_RELEASES_URL}/latest/download`
