import * as fontkit from 'fontkit'
import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  type PdfObject,
  type PdfRef,
  PdfStream,
} from './object'
import type { PdfWriter } from './writer'

/**
 * A Type 0 (CID-keyed) embedded font. The full PDF font tree —
 *
 *   Type0 → DescendantFonts [ CIDFontType2|0 → FontDescriptor → FontFile2|3 ]
 *           + ToUnicode CMap
 *
 * — gets allocated up-front (so the Type 0 ref is stable for resource dicts)
 * but the dict bodies are only assigned at `finalize()` time, after every
 * draw call has registered its glyphs. That lets us emit /W (advance widths)
 * and /ToUnicode (CID → original code points) for *exactly* the glyphs the
 * doc actually uses, instead of pre-walking or shipping placeholders.
 */

interface UsedGlyph {
  gid: number
  /** Advance width in 1000-upem PDF font units. */
  advance: number
  /** Original Unicode code points whose layout produced this glyph. */
  codePoints: number[]
}

interface FontkitGlyphRun {
  glyphs: Array<{ id: number; advanceWidth: number; codePoints: number[] }>
  positions: Array<{ xAdvance: number }>
}

interface FontkitFont {
  cff?: unknown
  postscriptName?: string
  unitsPerEm?: number
  italicAngle?: number
  ascent?: number
  descent?: number
  capHeight?: number
  bbox?: { minX: number; minY: number; maxX: number; maxY: number }
  layout(text: string): FontkitGlyphRun
}

export class CidFontHandle {
  readonly kind = 'cid' as const
  /** Type 0 root ref — what page Resources / Font dicts point at. */
  readonly ref: PdfRef
  private readonly descendantRef: PdfRef
  private readonly descriptorRef: PdfRef
  private readonly fontFileRef: PdfRef
  private readonly fontFileKey: 'FontFile2' | 'FontFile3'
  private readonly font: FontkitFont
  private readonly cff: boolean
  private readonly upem: number
  private readonly bytes: Uint8Array
  /** gid → usage data, populated by encode(); finalize() emits /W + ToUnicode from this. */
  private readonly used = new Map<number, UsedGlyph>()

  constructor(
    private readonly writer: PdfWriter,
    bytes: Uint8Array,
  ) {
    this.bytes = bytes
    const fk = (fontkit as unknown as { create: (b: Uint8Array) => FontkitFont }).create(bytes)
    this.font = fk
    this.cff = fk.cff !== undefined && fk.cff !== null
    this.upem = fk.unitsPerEm ?? 1000
    this.fontFileKey = this.cff ? 'FontFile3' : 'FontFile2'
    // Reserve every ref now so callers can compose page dicts that reference
    // `this.ref` before any text has been drawn.
    this.fontFileRef = writer.alloc()
    this.descriptorRef = writer.alloc()
    this.descendantRef = writer.alloc()
    this.ref = writer.alloc()
  }

  /**
   * Lay out `text` and return the Identity-H byte sequence (16-bit big-endian
   * gids). Updates the per-glyph usage map so finalize() emits exactly the
   * widths and ToUnicode entries we need.
   */
  encode(text: string): { bytes: Uint8Array; widthUnits: number } {
    const run = this.font.layout(text)
    const out = new Uint8Array(run.glyphs.length * 2)
    let widthUnits = 0
    for (let i = 0; i < run.glyphs.length; i++) {
      const g = run.glyphs[i]
      const p = run.positions[i]
      if (!g) continue
      const gid = g.id
      const advanceFu = p?.xAdvance ?? g.advanceWidth
      const advance = Math.round((advanceFu * 1000) / this.upem)
      out[i * 2] = (gid >> 8) & 0xff
      out[i * 2 + 1] = gid & 0xff
      // First-write wins: a glyph drawn twice keeps its first advance/codePoints
      // (advances should match anyway; codePoints might differ for ligatures
      // but that's a richer concern we defer).
      if (!this.used.has(gid)) {
        this.used.set(gid, { gid, advance, codePoints: g.codePoints })
      }
      widthUnits += advance
    }
    return { bytes: out, widthUnits }
  }

  /** @internal — called by PdfDoc.save() once all draws are recorded. */
  finalize(): void {
    const psName = this.font.postscriptName ?? 'EmbeddedFont'
    const upem = this.upem
    const scale = 1000 / upem
    const bbox = this.font.bbox ?? { minX: 0, minY: 0, maxX: upem, maxY: upem }

    const fontFileEntries: Record<string, PdfObject> = {}
    if (this.cff) fontFileEntries.Subtype = new PdfName('OpenType')
    this.writer.assign(this.fontFileRef, new PdfStream(fontFileEntries, this.bytes))

    this.writer.assign(
      this.descriptorRef,
      new PdfDict({
        Type: new PdfName('FontDescriptor'),
        FontName: new PdfName(psName),
        Flags: new PdfNumber(4),
        FontBBox: new PdfArray([
          new PdfNumber(Math.round(bbox.minX * scale)),
          new PdfNumber(Math.round(bbox.minY * scale)),
          new PdfNumber(Math.round(bbox.maxX * scale)),
          new PdfNumber(Math.round(bbox.maxY * scale)),
        ]),
        ItalicAngle: new PdfNumber(this.font.italicAngle ?? 0),
        Ascent: new PdfNumber(Math.round((this.font.ascent ?? upem) * scale)),
        Descent: new PdfNumber(Math.round((this.font.descent ?? 0) * scale)),
        CapHeight: new PdfNumber(
          Math.round((this.font.capHeight ?? this.font.ascent ?? upem) * scale),
        ),
        StemV: new PdfNumber(0),
        [this.fontFileKey]: this.fontFileRef,
      }),
    )

    // /W per-CID width array. Format `cid [w]` for each entry — verbose but
    // simple. The reader uses missing-CID fallback (DW = 0 default) which we
    // override only for glyphs we actually drew.
    const wEntries: PdfObject[] = []
    const sortedGids = [...this.used.keys()].sort((a, b) => a - b)
    for (const gid of sortedGids) {
      const u = this.used.get(gid)
      if (!u) continue
      wEntries.push(new PdfNumber(gid))
      wEntries.push(new PdfArray([new PdfNumber(u.advance)]))
    }

    this.writer.assign(
      this.descendantRef,
      new PdfDict({
        Type: new PdfName('Font'),
        Subtype: new PdfName(this.cff ? 'CIDFontType0' : 'CIDFontType2'),
        BaseFont: new PdfName(psName),
        CIDSystemInfo: new PdfDict({
          Registry: literal('Adobe'),
          Ordering: literal('Identity'),
          Supplement: new PdfNumber(0),
        }),
        FontDescriptor: this.descriptorRef,
        CIDToGIDMap: new PdfName('Identity'),
        W: new PdfArray(wEntries),
      }),
    )

    const cmapBytes = buildToUnicodeCMap(this.used)
    const cmapRef = this.writer.add(new PdfStream({}, cmapBytes))

    this.writer.assign(
      this.ref,
      new PdfDict({
        Type: new PdfName('Font'),
        Subtype: new PdfName('Type0'),
        BaseFont: new PdfName(psName),
        Encoding: new PdfName('Identity-H'),
        DescendantFonts: new PdfArray([this.descendantRef]),
        ToUnicode: cmapRef,
      }),
    )
  }
}

/**
 * Build a /ToUnicode CMap mapping each used CID (= gid under Identity-H) back
 * to its original Unicode code points, so PDF readers can return real text
 * for copy-paste / search via getTextContent.
 */
function buildToUnicodeCMap(used: Map<number, UsedGlyph>): Uint8Array {
  const sortedGids = [...used.keys()].sort((a, b) => a - b)
  let body = ''
  // PDF spec caps `bfchar` group size at 100 entries.
  for (let i = 0; i < sortedGids.length; i += 100) {
    const slice = sortedGids.slice(i, i + 100)
    body += `${slice.length} beginbfchar\n`
    for (const gid of slice) {
      const u = used.get(gid)
      if (!u) continue
      const cp = u.codePoints[0]
      if (cp === undefined) continue
      const gidHex = hex4(gid)
      const uniHex = encodeUtf16BE(cp)
      body += `<${gidHex}> <${uniHex}>\n`
    }
    body += 'endbfchar\n'
  }
  const cmap =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n' +
    '/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
  return new TextEncoder().encode(cmap)
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0').toUpperCase()
}

function encodeUtf16BE(cp: number): string {
  if (cp <= 0xffff) return hex4(cp)
  const x = cp - 0x10000
  return hex4(0xd800 + (x >> 10)) + hex4(0xdc00 + (x & 0x3ff))
}

function literal(s: string): PdfObject {
  return {
    serialize(): Uint8Array {
      let out = '('
      for (const ch of s) {
        if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`
        else out += ch
      }
      out += ')'
      return new TextEncoder().encode(out)
    },
  }
}
