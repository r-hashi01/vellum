import { CidFontHandle, type CidFontOptions } from './cid-font'
import { parseJpegInfo } from './jpeg'
import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  type PdfObject,
  type PdfRef,
  PdfStream,
} from './object'
import { encodeWinAnsi } from './winansi'
import { PdfWriter } from './writer'

const enc = new TextEncoder()

/**
 * Handle returned by {@link PdfDoc.embedJpeg}. Carries the indirect ref of
 * the Image XObject + the JPEG's intrinsic dimensions, so callers can size
 * the `cm` matrix correctly when drawing it.
 */
export interface ImageHandle {
  ref: PdfRef
  width: number
  height: number
}

export type StandardFontName =
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
  | 'Symbol'
  | 'ZapfDingbats'

/**
 * Handle returned by {@link PdfDoc.embedStandardFont}. The PDF reader supplies
 * the actual glyphs for the standard 14 fonts — we only need to register a
 * Type 1 font dict referencing the name + WinAnsi encoding.
 */
export interface StandardFontHandle {
  kind: 'standard'
  ref: PdfRef
  name: StandardFontName
  /** True if encoding is the standard 14's WinAnsi bytes (most fonts). */
  winAnsi: boolean
}

/** Discriminated union of every font kind drawText understands. */
export type FontHandle = StandardFontHandle | CidFontHandle

interface PageData {
  pageRef: PdfRef
  width: number
  height: number
  /** Each entry is one content-stream chunk (already PDF-operator encoded). */
  contentOps: Uint8Array[]
  /** image ref → resource-local name (e.g. "Im0"). */
  xobjects: Map<PdfRef, string>
  nextImId: number
  /** font ref → resource-local name (e.g. "F0"). */
  fonts: Map<PdfRef, string>
  nextFontId: number
  /** Shared sink — chars dropped during text encoding land here. */
  unencodable: Set<string>
}

/**
 * A single PDF page. Held by callers between `addPage()` and `save()` so they
 * can stack drawing operations onto it.
 */
export class Page {
  /** @internal */
  constructor(private readonly data: PageData) {}

  get width(): number {
    return this.data.width
  }
  get height(): number {
    return this.data.height
  }

  /**
   * Place an image with its top-left at (x, y) in PDF user space (origin =
   * page bottom-left), scaled to (w, h). The PDF `cm` operator takes a 2D
   * affine matrix `a b c d e f`; for axis-aligned scale + translate we need
   * `[w 0 0 h x y]`. Wrapped in `q ... Q` so each image draw is fully
   * isolated from neighbouring graphics state changes.
   */
  drawImage(image: ImageHandle, x: number, y: number, w: number, h: number): void {
    let name = this.data.xobjects.get(image.ref)
    if (!name) {
      name = `Im${this.data.nextImId++}`
      this.data.xobjects.set(image.ref, name)
    }
    const op = `q\n${formatNumber(w)} 0 0 ${formatNumber(h)} ${formatNumber(x)} ${formatNumber(y)} cm\n/${name} Do\nQ\n`
    this.data.contentOps.push(enc.encode(op))
  }

  /**
   * Draw a single text run. (x, y) is the baseline left in PDF user space
   * (origin = page bottom-left). Unencodable characters are dropped from the
   * stream and reported via {@link PdfDoc.collectWarnings} — the rasterized
   * background still shows them, so the failure is *visible* to a reader who
   * tries to copy/paste, never silently substituted.
   */
  drawText(text: string, font: FontHandle, x: number, y: number, fontSize: number): void {
    let name = this.data.fonts.get(font.ref)
    if (!name) {
      name = `F${this.data.nextFontId++}`
      this.data.fonts.set(font.ref, name)
    }
    let textBytes: Uint8Array
    if (font.kind === 'standard') {
      const r = encodeWinAnsi(text)
      for (const ch of r.unencodable) this.data.unencodable.add(ch)
      textBytes = r.bytes
    } else {
      // CID-keyed: fontkit lays out the run, encode() returns Identity-H gids
      // and tracks them so the font's /W + /ToUnicode reflect actual usage.
      textBytes = font.encode(text).bytes
    }
    if (textBytes.length === 0) return
    const hex = bytesToHex(textBytes)
    const op =
      `BT\n` +
      `/${name} ${formatNumber(fontSize)} Tf\n` +
      `1 0 0 1 ${formatNumber(x)} ${formatNumber(y)} Tm\n` +
      `<${hex}> Tj\n` +
      `ET\n`
    this.data.contentOps.push(enc.encode(op))
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Split an RGBA pixel array into separate RGB and (optional) Alpha planes.
 * `hasAlpha` is true iff at least one pixel is not fully opaque — letting
 * embedPng skip the SMask entirely for opaque inputs.
 */
function splitRgba(rgba: Uint8ClampedArray): {
  rgb: Uint8Array
  alpha: Uint8Array | null
  hasAlpha: boolean
} {
  const px = rgba.length / 4
  const rgb = new Uint8Array(px * 3)
  const alpha = new Uint8Array(px)
  let hasAlpha = false
  for (let i = 0, j = 0, k = 0; i < rgba.length; i += 4, j += 3, k++) {
    rgb[j] = rgba[i] ?? 0
    rgb[j + 1] = rgba[i + 1] ?? 0
    rgb[j + 2] = rgba[i + 2] ?? 0
    const a = rgba[i + 3] ?? 255
    alpha[k] = a
    if (a !== 255) hasAlpha = true
  }
  return { rgb, alpha: hasAlpha ? alpha : null, hasAlpha }
}

/**
 * Deflate raw bytes via the browser's CompressionStream. PDF's FlateDecode
 * filter expects exactly this format (zlib-wrapped DEFLATE). No PNG predictor
 * gymnastics needed — we serialize the raw pixel grid directly, scanline order.
 */
async function deflateBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(input)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export class PdfDoc {
  private readonly writer = new PdfWriter()
  private readonly pagesRef: PdfRef
  private readonly pages: PageData[] = []
  private readonly unencodable = new Set<string>()
  private readonly cidFonts: CidFontHandle[] = []

  constructor() {
    this.pagesRef = this.writer.alloc()
  }

  addPage(width: number, height: number): Page {
    const data: PageData = {
      pageRef: this.writer.alloc(),
      width,
      height,
      contentOps: [],
      xobjects: new Map(),
      nextImId: 0,
      fonts: new Map(),
      nextFontId: 0,
      unencodable: this.unencodable,
    }
    this.pages.push(data)
    return new Page(data)
  }

  /**
   * Embed one of the standard 14 PDF fonts. The reader supplies the actual
   * glyph data; we only emit the Type 1 dict that names the font + the
   * encoding (WinAnsi for the Latin-1ish fonts, default for Symbol /
   * ZapfDingbats which have built-in encodings).
   */
  embedStandardFont(name: StandardFontName): StandardFontHandle {
    const winAnsi = name !== 'Symbol' && name !== 'ZapfDingbats'
    const entries: Record<string, PdfObject> = {
      Type: new PdfName('Font'),
      Subtype: new PdfName('Type1'),
      BaseFont: new PdfName(name),
    }
    if (winAnsi) entries.Encoding = new PdfName('WinAnsiEncoding')
    const ref = this.writer.add(new PdfDict(entries))
    return { kind: 'standard', ref, name, winAnsi }
  }

  /**
   * Embed a CID-keyed (Type 0) font from raw font bytes (TTF / OTF / WOFF /
   * WOFF2 — fontkit handles the unwrapping). Returns a handle that drawText
   * uses to lay out runs; the font's /W array and /ToUnicode CMap are
   * generated at save() based on the glyphs that actually got drawn.
   *
   * `options.onWarning` (if supplied) receives soft-failure messages from
   * encode/finalize — fontkit occasionally chokes on specific subsets and
   * the in-house emitter degrades visibly rather than throwing.
   */
  embedCidFont(bytes: Uint8Array, options?: CidFontOptions): CidFontHandle {
    const handle = new CidFontHandle(this.writer, bytes, options)
    this.cidFonts.push(handle)
    return handle
  }

  /**
   * Snapshot of soft-failures that accumulated during draw calls. Today this
   * is just the set of WinAnsi-unencodable characters; future emit features
   * (subset font misses, image errors) will append here too.
   */
  collectWarnings(): string[] {
    if (this.unencodable.size === 0) return []
    const sample = [...this.unencodable].slice(0, 12).join('')
    return [
      `WinAnsi cannot encode ${this.unencodable.size} character(s); ` +
        `text containing them was dropped from the selectable layer (the raster ` +
        `still shows them). Sample: "${sample}".`,
    ]
  }

  /**
   * Embed a PNG-encoded image as an Image XObject. PNG's IDAT layout (zlib
   * stream wrapping per-row predicted pixel data) doesn't map cleanly to
   * PDF's `/Filter /FlateDecode`-only path without the predictor metadata,
   * so we take a pragmatic route: decode the PNG via the browser's
   * `createImageBitmap` + canvas, read raw RGBA, then re-deflate. If any
   * pixel has alpha < 255, alpha goes into a separate grayscale Image
   * XObject linked via `/SMask`.
   */
  async embedPng(bytes: Uint8Array): Promise<ImageHandle> {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('embedPng: 2d context unavailable')
      ctx.drawImage(bitmap, 0, 0)
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
      const { rgb, alpha, hasAlpha } = splitRgba(img.data)

      const rgbStream = await deflateBytes(rgb)
      const entries: Record<string, PdfObject> = {
        Type: new PdfName('XObject'),
        Subtype: new PdfName('Image'),
        Width: new PdfNumber(bitmap.width),
        Height: new PdfNumber(bitmap.height),
        BitsPerComponent: new PdfNumber(8),
        ColorSpace: new PdfName('DeviceRGB'),
        Filter: new PdfName('FlateDecode'),
      }
      if (hasAlpha && alpha) {
        const alphaStream = await deflateBytes(alpha)
        const smaskRef = this.writer.add(
          new PdfStream(
            {
              Type: new PdfName('XObject'),
              Subtype: new PdfName('Image'),
              Width: new PdfNumber(bitmap.width),
              Height: new PdfNumber(bitmap.height),
              BitsPerComponent: new PdfNumber(8),
              ColorSpace: new PdfName('DeviceGray'),
              Filter: new PdfName('FlateDecode'),
            },
            alphaStream,
          ),
        )
        entries.SMask = smaskRef
      }
      const ref = this.writer.add(new PdfStream(entries, rgbStream))
      return { ref, width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  }

  /**
   * Embed a JPEG-encoded image as an Image XObject. The bytes are copied
   * straight into the PDF stream (DCTDecode = "this is a JPEG, decoder
   * handles it") — no re-encoding, no quality loss.
   */
  embedJpeg(bytes: Uint8Array): ImageHandle {
    const info = parseJpegInfo(bytes)
    const colorSpace =
      info.components === 1
        ? new PdfName('DeviceGray')
        : info.components === 4
          ? new PdfName('DeviceCMYK')
          : new PdfName('DeviceRGB')
    const ref = this.writer.add(
      new PdfStream(
        {
          Type: new PdfName('XObject'),
          Subtype: new PdfName('Image'),
          Width: new PdfNumber(info.width),
          Height: new PdfNumber(info.height),
          BitsPerComponent: new PdfNumber(8),
          ColorSpace: colorSpace,
          Filter: new PdfName('DCTDecode'),
        },
        bytes,
      ),
    )
    return { ref, width: info.width, height: info.height }
  }

  save(): Uint8Array {
    // Finalize every CID font now that all draws are recorded — their /W and
    // /ToUnicode entries reflect exactly the glyphs the document used.
    for (const f of this.cidFonts) f.finalize()

    for (const p of this.pages) {
      const content = mergeBytes(p.contentOps)
      const contentRef = this.writer.add(new PdfStream({}, content))

      const resources: Record<string, PdfObject> = {}
      if (p.xobjects.size > 0) {
        const xobjectEntries: Record<string, PdfObject> = {}
        for (const [ref, name] of p.xobjects) xobjectEntries[name] = ref
        resources.XObject = new PdfDict(xobjectEntries)
      }
      if (p.fonts.size > 0) {
        const fontEntries: Record<string, PdfObject> = {}
        for (const [ref, name] of p.fonts) fontEntries[name] = ref
        resources.Font = new PdfDict(fontEntries)
      }

      this.writer.assign(
        p.pageRef,
        new PdfDict({
          Type: new PdfName('Page'),
          Parent: this.pagesRef,
          MediaBox: new PdfArray([
            new PdfNumber(0),
            new PdfNumber(0),
            new PdfNumber(p.width),
            new PdfNumber(p.height),
          ]),
          Resources: new PdfDict(resources),
          Contents: contentRef,
        }),
      )
    }

    const catalogRef = this.writer.add(
      new PdfDict({ Type: new PdfName('Catalog'), Pages: this.pagesRef }),
    )
    this.writer.assign(
      this.pagesRef,
      new PdfDict({
        Type: new PdfName('Pages'),
        Kids: new PdfArray(this.pages.map((p) => p.pageRef)),
        Count: new PdfNumber(this.pages.length),
      }),
    )
    return this.writer.serialize(catalogRef)
  }
}

function formatNumber(n: number): string {
  // Match PdfNumber's serialization (clamped to 6 decimal places).
  const r = Math.round(n * 1e6) / 1e6
  return Number.isInteger(r) ? `${r}` : `${r}`
}

function mergeBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
