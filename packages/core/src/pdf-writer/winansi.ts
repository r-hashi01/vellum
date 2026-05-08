/**
 * WinAnsiEncoding lookup. Maps Unicode code points to the byte values that
 * PDF readers expect for the standard 14 fonts under `/Encoding /WinAnsiEncoding`.
 *
 * WinAnsi is a CP-1252 superset of Latin-1: byte ranges 0x00-0x7F and 0xA0-0xFF
 * map identically to Unicode, plus a handful of chars in 0x80-0x9F (€ ‚ ƒ „ … †
 * ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ).
 *
 * Code points outside this set are unrepresentable — callers drop them. That's
 * the same visible-degradation invariant the project follows everywhere else:
 * the raster background still shows the glyph, but the selectable layer skips
 * it (so a copy-paste check makes the gap obvious).
 */

const exotic = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
])

export function encodeWinAnsi(text: string): { bytes: Uint8Array; unencodable: Set<string> } {
  const out: number[] = []
  const unencodable = new Set<string>()
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    let b: number | undefined
    if (cp <= 0x7f || (cp >= 0xa0 && cp <= 0xff)) {
      b = cp
    } else {
      b = exotic.get(cp)
    }
    if (b === undefined) {
      unencodable.add(ch)
    } else {
      out.push(b)
    }
  }
  return { bytes: new Uint8Array(out), unencodable }
}
