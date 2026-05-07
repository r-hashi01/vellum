import type { TextSpan } from './types.js'

/**
 * One of the 14 PDF standard fonts. The string values match pdf-lib's
 * `StandardFonts` enum so they can be passed directly to `embedFont`.
 *
 * Phase 1 only uses the 12 Latin variants (Helvetica / Times / Courier ×
 * Regular/Bold/Italic/BoldItalic). Symbol and ZapfDingbats are intentionally
 * omitted — neither is a useful target for arbitrary CSS-styled text.
 */
export type StandardFontKey =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique'

type FamilyBucket = 'sans' | 'serif' | 'mono'

const KNOWN_SANS = new Set([
  'arial',
  'helvetica',
  'helvetica neue',
  'verdana',
  'tahoma',
  'trebuchet ms',
  'segoe ui',
  'roboto',
  'open sans',
  'noto sans',
  'noto sans jp',
  'inter',
  'lato',
  'source sans pro',
  'pt sans',
])
const KNOWN_SERIF = new Set([
  'times',
  'times new roman',
  'georgia',
  'palatino',
  'palatino linotype',
  'garamond',
  'cambria',
  'didot',
  'baskerville',
  'noto serif',
  'merriweather',
  'pt serif',
])
const KNOWN_MONO = new Set([
  'courier',
  'courier new',
  'consolas',
  'menlo',
  'monaco',
  'sf mono',
  'fira code',
  'source code pro',
  'jetbrains mono',
  'ubuntu mono',
  'roboto mono',
])

/**
 * Classify a CSS `font-family` value (a comma-separated chain) into one of
 * three buckets. Walks left-to-right and returns the first bucket that any
 * family in the chain matches — generic keywords (`serif`, `monospace`, …)
 * count too. Falls back to `sans` since that is the most common Web default.
 */
export function classifyFamily(fontFamily: string): FamilyBucket {
  const names = fontFamily.split(',').map((s) =>
    s
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase(),
  )
  for (const n of names) {
    if (n === 'monospace' || n === 'ui-monospace') return 'mono'
    if (n === 'serif' || n === 'ui-serif') return 'serif'
    if (
      n === 'sans-serif' ||
      n === 'ui-sans-serif' ||
      n === 'system-ui' ||
      n === '-apple-system' ||
      n === 'blinkmacsystemfont'
    ) {
      return 'sans'
    }
    if (KNOWN_MONO.has(n)) return 'mono'
    if (KNOWN_SERIF.has(n)) return 'serif'
    if (KNOWN_SANS.has(n)) return 'sans'
  }
  return 'sans'
}

/**
 * Pick the closest PDF standard font for a span. Mapping rules:
 * - family bucket from `font-family` (sans → Helvetica, serif → Times, mono → Courier)
 * - `font-weight >= 600` → Bold variant
 * - `font-style: italic | oblique` → Italic/Oblique variant
 *
 * Subsetted webfonts (Phase 2) will replace this for families that have a
 * matching `@font-face` available; for everything else this mapping remains
 * the fallback.
 */
export function pickStandardFont(
  span: Pick<TextSpan, 'fontFamily' | 'fontWeight' | 'fontStyle'>,
): StandardFontKey {
  const bucket = classifyFamily(span.fontFamily)
  const bold = span.fontWeight >= 600
  const italic = span.fontStyle === 'italic' || span.fontStyle === 'oblique'
  if (bucket === 'serif') {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  if (bucket === 'mono') {
    if (bold && italic) return 'Courier-BoldOblique'
    if (bold) return 'Courier-Bold'
    if (italic) return 'Courier-Oblique'
    return 'Courier'
  }
  if (bold && italic) return 'Helvetica-BoldOblique'
  if (bold) return 'Helvetica-Bold'
  if (italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}
