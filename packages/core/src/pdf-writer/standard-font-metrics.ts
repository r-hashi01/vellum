import { Encodings, Font, type Font as StdFont } from '@pdf-lib/standard-fonts'
import type { StandardFontName } from './pdf-doc'

/**
 * Width metrics for the Standard 14 PDF fonts. We pull these from the
 * `@pdf-lib/standard-fonts` package (a metrics-only package — no PDF dep) so
 * the layout planner can snap inline boundaries even when the chosen font is
 * one of the standard 14, where the reader supplies the glyphs and we never
 * see the actual font program.
 *
 * The package returns widths in 1000-upem font units; we scale to PDF points
 * for the caller.
 */

const fontCache = new Map<StandardFontName, StdFont>()

function getFont(name: StandardFontName): StdFont {
  let f = fontCache.get(name)
  if (!f) {
    // The package's union type is the same set of names. Casting is safe
    // because StandardFontName is identical to its IFontNames.
    f = Font.load(name as Parameters<typeof Font.load>[0])
    fontCache.set(name, f)
  }
  return f
}

function pickEncoding(name: StandardFontName) {
  if (name === 'Symbol') return Encodings.Symbol
  if (name === 'ZapfDingbats') return Encodings.ZapfDingbats
  return Encodings.WinAnsi
}

export interface StandardWidthResult {
  widthPt: number
  /** Source-string chars that the encoding can't represent. */
  unencodable: Set<string>
}

export function measureStandardFont(
  name: StandardFontName,
  text: string,
  fontSize: number,
): StandardWidthResult {
  const font = getFont(name)
  const enc = pickEncoding(name)
  let units = 0
  const unencodable = new Set<string>()
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (!enc.canEncodeUnicodeCodePoint(cp)) {
      unencodable.add(ch)
      continue
    }
    const { name: glyphName } = enc.encodeUnicodeCodePoint(cp)
    units += font.getWidthOfGlyph(glyphName) ?? 0
  }
  return { widthPt: (units / 1000) * fontSize, unencodable }
}
