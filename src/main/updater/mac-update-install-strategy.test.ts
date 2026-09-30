import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

import {
  classifyCodesignDisplayOutput,
  resolveRunningMacAppBundlePath,
  strategyForSignatureKind
} from './mac-update-install-strategy'

const ADHOC_OUTPUT = [
  'Executable=/Applications/Orca Next.app/Contents/MacOS/Orca Next',
  'Identifier=com.meapri.orca-next',
  'CodeDirectory v=20400 size=512 flags=0x20002(adhoc,linker-signed) hashes=5+7',
  'Signature=adhoc',
  'TeamIdentifier=not set'
].join('\n')

const DEVELOPER_ID_OUTPUT = [
  'Identifier=com.stablyai.orca',
  'Authority=Developer ID Application: Stably AI (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345'
].join('\n')

describe('mac update install strategy', () => {
  let tempRoot: string | null = null

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = null
    }
  })

  it('keeps Squirrel for Developer ID builds so a future signed release just works', () => {
    const kind = classifyCodesignDisplayOutput(DEVELOPER_ID_OUTPUT, 0)
    expect(kind).toBe('developer-id')
    expect(strategyForSignatureKind(kind)).toBe('squirrel')
  })

  it('swaps bundles for ad-hoc and unsigned builds Squirrel.Mac would reject', () => {
    expect(classifyCodesignDisplayOutput(ADHOC_OUTPUT, 0)).toBe('adhoc')
    expect(classifyCodesignDisplayOutput('/x.app: code object is not signed at all\n', 1)).toBe(
      'unsigned'
    )
    expect(strategyForSignatureKind('adhoc')).toBe('bundle-swap')
    expect(strategyForSignatureKind('unsigned')).toBe('bundle-swap')
  })

  it('leaves other signatures (Apple Development) on the upstream path', () => {
    const kind = classifyCodesignDisplayOutput(
      'Authority=Apple Development: someone (XYZ)\nTeamIdentifier=XYZ',
      0
    )
    expect(kind).toBe('other')
    expect(strategyForSignatureKind(kind)).toBe('squirrel')
  })

  it('resolves the bundle only for an executable inside a real .app', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-strategy-'))
    const bundle = join(tempRoot, 'Orca Next.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>')
    expect(resolveRunningMacAppBundlePath(join(bundle, 'Contents', 'MacOS', 'Orca Next'))).toBe(
      bundle
    )
    expect(resolveRunningMacAppBundlePath(join(tempRoot, 'bin', 'node'))).toBeNull()
  })
})
