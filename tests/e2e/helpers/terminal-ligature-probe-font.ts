/**
 * Builds a tiny monospace font whose `liga` ligatures are solid blocks, so a WebGL pixel probe can
 * tell a ligated run (dense ink across its cells) from the same characters drawn one cell at a time
 * (thin strokes). No system ligature font is assumed: CI images ship none.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

type OpenTypePath = {
  moveTo: (x: number, y: number) => void
  lineTo: (x: number, y: number) => void
  close: () => void
}
type OpenTypeGlyph = object
type OpenTypeModule = {
  Path: new () => OpenTypePath
  Glyph: new (options: {
    name: string
    unicode?: number
    advanceWidth: number
    path: OpenTypePath
  }) => OpenTypeGlyph
  Font: new (options: {
    familyName: string
    styleName: string
    unitsPerEm: number
    ascender: number
    descender: number
    glyphs: OpenTypeGlyph[]
  }) => {
    substitution: {
      addLigature: (
        feature: string,
        ligature: { sub: number[]; by: number },
        script?: string
      ) => void
    }
    toArrayBuffer: () => ArrayBuffer
  }
}

export const LIGATURE_PROBE_FONT_FAMILY = 'Orca Ligature Probe'

const ADVANCE = 600

/** opentype.js ships as @xterm/addon-ligatures' own runtime dependency; resolve it from there. */
function loadOpenType(): OpenTypeModule {
  const requireFromRoot = createRequire(join(process.cwd(), 'package.json'))
  const requireFromAddon = createRequire(requireFromRoot.resolve('@xterm/addon-ligatures'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opentype.js has no types in this tree; OpenTypeModule names only the constructors used here.
  return requireFromAddon('opentype.js') as OpenTypeModule
}

/** Base64 TTF: `=`, `>`, `-`, `!`, `x` as thin strokes and `=>`, `->`, `!==` as solid blocks. */
/** Only `liga` by default: Chromium canvas applies `calt` unasked but `liga` only when the atlas
 *  canvas inherits an explicit `font-feature-settings`, which is what the probe must prove. */
export function buildLigatureProbeFont(features: ('calt' | 'liga')[] = ['liga']): string {
  const opentype = loadOpenType()
  const glyph = (
    name: string,
    unicode: number | undefined,
    cells: number,
    rects: [number, number, number, number][]
  ): OpenTypeGlyph => {
    const path = new opentype.Path()
    for (const [x0, y0, x1, y1] of rects) {
      path.moveTo(x0, y0)
      path.lineTo(x1, y0)
      path.lineTo(x1, y1)
      path.lineTo(x0, y1)
      path.close()
    }
    return new opentype.Glyph({
      name,
      unicode,
      advanceWidth: ADVANCE * cells,
      path
    })
  }
  const block = (cells: number): [number, number, number, number][] => [
    [40, -100, ADVANCE * cells - 40, 700]
  ]
  const glyphs = [
    glyph('.notdef', undefined, 1, []),
    glyph('space', 32, 1, []),
    glyph('exclam', 33, 1, [[270, 0, 330, 700]]),
    glyph('hyphen', 45, 1, [[80, 300, 520, 360]]),
    glyph('equal', 61, 1, [
      [80, 200, 520, 250],
      [80, 420, 520, 470]
    ]),
    glyph('greater', 62, 1, [
      [100, 150, 160, 550],
      [160, 320, 500, 380]
    ]),
    glyph('x', 120, 1, [[270, 0, 330, 500]]),
    glyph('equal_greater.liga', undefined, 2, block(2)),
    glyph('hyphen_greater.liga', undefined, 2, block(2)),
    glyph('exclam_equal_equal.liga', undefined, 3, block(3))
  ]
  const font = new opentype.Font({
    familyName: LIGATURE_PROBE_FONT_FAMILY,
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs
  })
  for (const feature of features) {
    for (const [sub, by] of [
      [[4, 5], 7],
      [[3, 5], 8],
      [[2, 4, 4], 9]
    ] as const) {
      font.substitution.addLigature(feature, { sub: [...sub], by })
    }
  }
  return Buffer.from(font.toArrayBuffer()).toString('base64')
}
