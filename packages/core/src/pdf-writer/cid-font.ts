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
 * Stub Type 0 (CID-keyed) font embedder. "Stub" because at this layer we lock
 * the *structural* shape of the font tree only — Type 0 root dict + descendant
 * CIDFontType2/3 + FontDescriptor + FontFile{2,3} stream — and we don't yet
 * subset, build a /W array, or emit a ToUnicode CMap. Those land in
 * follow-up steps once drawText needs them.
 *
 * The catalog tree we build is what the PDF spec wants for a single CID-keyed
 * font:
 *
 *   Type0 ──┐
 *           ├ /Encoding /Identity-H        (CID = 16-bit big-endian, no remap)
 *           └ /DescendantFonts [ CIDFontType2|3 ──┐
 *                                                 ├ /CIDSystemInfo
 *                                                 ├ /CIDToGIDMap /Identity
 *                                                 └ /FontDescriptor ──┐
 *                                                                      └ /FontFile2|3 stream
 */

export interface CidFontHandle {
  ref: PdfRef
  /** Whether the embedded font has CFF (PostScript) outlines or TrueType. */
  cff: boolean
  /** The fontkit Font object — handed back so later steps can subset / measure. */
  font: unknown
}

interface FontkitLike {
  create(bytes: Uint8Array): {
    constructor: { name?: string }
    cff?: unknown
    postscriptName?: string
    bbox?: { minX: number; minY: number; maxX: number; maxY: number }
    ascent?: number
    descent?: number
    capHeight?: number
    italicAngle?: number
    unitsPerEm?: number
  }
}

export function embedCidFontStub(writer: PdfWriter, bytes: Uint8Array): CidFontHandle {
  const fk = (fontkit as unknown as FontkitLike).create(bytes)
  const cff = fk.cff !== undefined && fk.cff !== null
  // PDF needs the font program embedded as a stream. /FontFile2 = TrueType
  // glyf-flavoured; /FontFile3 = CFF (also covers OpenType-CFF). For the stub
  // step we ship the *original* bytes (woff2 is fine — but PDF readers need
  // the unwrapped form for FontFile entries). Since we're not subsetting yet,
  // we'll re-extract them at the next step; for now, embed bytes verbatim and
  // rely on the per-format subset.encode() landing in step 7.
  const fontFileKey = cff ? 'FontFile3' : 'FontFile2'
  const fontFileEntries: Record<string, PdfObject> = {}
  if (cff) {
    // CFF subtypes per spec: /Type1C for Type 1 CFF, /CIDFontType0C for CID
    // CFF, /OpenType for OT-CFF wrappers. We pick OpenType (catch-all) for
    // now; subset step refines this when we know the actual outline format.
    fontFileEntries.Subtype = new PdfName('OpenType')
  }
  const fontFileRef = writer.add(new PdfStream(fontFileEntries, bytes))

  const psName = fk.postscriptName ?? 'EmbeddedFont'
  const upem = fk.unitsPerEm ?? 1000
  const bbox = fk.bbox ?? { minX: 0, minY: 0, maxX: upem, maxY: upem }
  // PDF FontDescriptor expects values in glyph space units scaled to 1000 upem.
  const scale = 1000 / upem
  const descriptorRef = writer.add(
    new PdfDict({
      Type: new PdfName('FontDescriptor'),
      FontName: new PdfName(psName),
      // Symbolic flag (bit 3, value 4) — required for CID fonts whose
      // characters aren't drawn from the Latin alphabet. Always set; the
      // Adobe-recommended safest default.
      Flags: new PdfNumber(4),
      FontBBox: new PdfArray([
        new PdfNumber(Math.round(bbox.minX * scale)),
        new PdfNumber(Math.round(bbox.minY * scale)),
        new PdfNumber(Math.round(bbox.maxX * scale)),
        new PdfNumber(Math.round(bbox.maxY * scale)),
      ]),
      ItalicAngle: new PdfNumber(fk.italicAngle ?? 0),
      Ascent: new PdfNumber(Math.round((fk.ascent ?? upem) * scale)),
      Descent: new PdfNumber(Math.round((fk.descent ?? 0) * scale)),
      CapHeight: new PdfNumber(Math.round((fk.capHeight ?? fk.ascent ?? upem) * scale)),
      // StemV is required but readers rarely care; pdf-lib hardcodes 0.
      StemV: new PdfNumber(0),
      [fontFileKey]: fontFileRef,
    }),
  )

  const descendantRef = writer.add(
    new PdfDict({
      Type: new PdfName('Font'),
      Subtype: new PdfName(cff ? 'CIDFontType0' : 'CIDFontType2'),
      BaseFont: new PdfName(psName),
      CIDSystemInfo: new PdfDict({
        Registry: stringLiteral('Adobe'),
        Ordering: stringLiteral('Identity'),
        Supplement: new PdfNumber(0),
      }),
      FontDescriptor: descriptorRef,
      CIDToGIDMap: new PdfName('Identity'),
    }),
  )

  const ref = writer.add(
    new PdfDict({
      Type: new PdfName('Font'),
      Subtype: new PdfName('Type0'),
      BaseFont: new PdfName(psName),
      Encoding: new PdfName('Identity-H'),
      DescendantFonts: new PdfArray([descendantRef]),
    }),
  )
  return { ref, cff, font: fk }
}

// PDF literal-string constructor used inline above. Kept local to keep the
// public surface of object.ts unchanged.
function stringLiteral(s: string): PdfObject {
  return {
    serialize(): Uint8Array {
      const enc = new TextEncoder()
      let out = '('
      for (const ch of s) {
        if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`
        else out += ch
      }
      out += ')'
      return enc.encode(out)
    },
  }
}
