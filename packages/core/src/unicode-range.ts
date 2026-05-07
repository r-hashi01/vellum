/**
 * Parser + matcher for the CSS `@font-face` `unicode-range` descriptor.
 *
 * Forms supported (per CSS Fonts Module Level 4):
 *   `U+26`            single code point
 *   `U+0-7F`          range
 *   `U+00??`          wildcard (each `?` expands to 0..F at start, F..F at end)
 *   `U+0-7F, U+A0-FF` comma-separated list
 *
 * A rule with no `unicode-range` is treated by callers as "covers everything"
 * (returning `null` from `parseUnicodeRange`). The parser is strict-ish: any
 * malformed segment produces `null` for the whole value, so we degrade to
 * "covers everything" rather than silently dropping characters.
 */

export interface CodePointRange {
  start: number
  end: number
}

export function parseUnicodeRange(raw: string): CodePointRange[] | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const out: CodePointRange[] = []
  for (const segRaw of trimmed.split(',')) {
    const seg = segRaw.trim()
    const range = parseSegment(seg)
    if (!range) return null
    out.push(range)
  }
  return out.length === 0 ? null : out
}

function parseSegment(seg: string): CodePointRange | null {
  // Strip the `U+` (or `u+`) prefix. Without it, we don't recognize the segment.
  const m = /^[Uu]\+(.+)$/.exec(seg)
  if (!m) return null
  const body = m[1] ?? ''
  // Range form: hex-hex
  if (body.includes('-')) {
    const [a, b] = body.split('-')
    const start = parseHex(a ?? '')
    const end = parseHex(b ?? '')
    if (start === null || end === null || end < start) return null
    return { start, end }
  }
  // Wildcard form: any `?` characters
  if (body.includes('?')) {
    const startStr = body.replace(/\?/g, '0')
    const endStr = body.replace(/\?/g, 'F')
    const start = parseHex(startStr)
    const end = parseHex(endStr)
    if (start === null || end === null) return null
    return { start, end }
  }
  // Single code point
  const cp = parseHex(body)
  if (cp === null) return null
  return { start: cp, end: cp }
}

function parseHex(s: string): number | null {
  if (s === '' || !/^[0-9A-Fa-f]+$/.test(s)) return null
  const n = Number.parseInt(s, 16)
  return Number.isFinite(n) ? n : null
}

/**
 * `null` means "no unicode-range constraint" → covers every code point. (This
 * is the CSS default when the descriptor is absent.)
 */
export function rangeCoversCodePoint(ranges: CodePointRange[] | null, cp: number): boolean {
  if (ranges === null) return true
  for (const r of ranges) {
    if (cp >= r.start && cp <= r.end) return true
  }
  return false
}
