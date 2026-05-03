import { PDFDocument, type PDFFont, rgb, StandardFonts } from 'pdf-lib'
import type { TextSpan } from './types.js'

export interface EmitOptions {
  pageRasters: Uint8Array[]
  pageSpans: TextSpan[][]
  /** Logical DOM size of every page (assumed identical). */
  source: { width: number; height: number }
  /** PDF page size in points. */
  output: { width: number; height: number }
  rasterFormat: 'jpeg' | 'png'
}

export interface EmitResult {
  bytes: Uint8Array
  warnings: string[]
}

export async function emitPdf(opts: EmitOptions): Promise<EmitResult> {
  const pdf = await PDFDocument.create()
  // Phase 0 fallback: a single standard font for everything. Phase 2 replaces
  // this with @font-face + fontkit subsetting and the encoding limit goes away.
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const encoder = createSafeEncoder(font)

  const scaleX = opts.output.width / opts.source.width
  const scaleY = opts.output.height / opts.source.height

  for (let i = 0; i < opts.pageRasters.length; i++) {
    const rasterBytes = opts.pageRasters[i]
    if (!rasterBytes) continue
    const page = pdf.addPage([opts.output.width, opts.output.height])
    const img =
      opts.rasterFormat === 'jpeg'
        ? await pdf.embedJpg(rasterBytes)
        : await pdf.embedPng(rasterBytes)
    page.drawImage(img, {
      x: 0,
      y: 0,
      width: opts.output.width,
      height: opts.output.height,
    })

    const spans = opts.pageSpans[i] ?? []
    for (const span of spans) {
      const safeText = encoder.encode(span.text)
      // The whole span is unencodable (CJK page in Phase 0, etc.) — skip
      // entirely so the missing text is *visible* (no selectable layer there)
      // rather than silently substituted.
      if (safeText.length === 0) continue
      drawSpan(page, font, { ...span, text: safeText }, scaleX, scaleY, opts.output.height)
    }
  }

  const bytes = await pdf.save()
  const warnings: string[] = []
  if (encoder.unencodable.size > 0) {
    const sample = [...encoder.unencodable].slice(0, 12).join('')
    warnings.push(
      `Helvetica fallback (Phase 0) cannot encode ${encoder.unencodable.size} character(s); ` +
        `text containing them was dropped from the selectable layer (raster still shows them). ` +
        `Sample: "${sample}". This is fixed in Phase 2 when @font-face fonts are subsetted.`,
    )
  }
  return { bytes, warnings }
}

function drawSpan(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  span: TextSpan,
  scaleX: number,
  scaleY: number,
  outputHeight: number,
): void {
  // CSS rect.y is the top of the line box (axis pointing down).
  // PDF drawText's y is the baseline (axis pointing up).
  // For default line-height the baseline sits ~rect.y + rect.h; small
  // mismatches between the raster's fonts and Helvetica are acceptable in
  // Phase 0 since the user reads the raster, not the vector glyphs.
  const baselineCss = span.y + span.h
  const baselinePdf = outputHeight - baselineCss * scaleY

  page.drawText(span.text, {
    x: span.x * scaleX,
    y: baselinePdf,
    size: span.fontSize * scaleY,
    font,
    color: rgb(span.color.r, span.color.g, span.color.b),
    opacity: span.color.a,
  })
}

interface SafeEncoder {
  encode(text: string): string
  unencodable: Set<string>
}

/**
 * Test each unique grapheme against the font's encoder once and cache the
 * result. Characters the font can't encode are dropped (not substituted) so
 * the failure is visible to a copy-paste check, not silently masked by a `?`.
 */
function createSafeEncoder(font: PDFFont): SafeEncoder {
  const cache = new Map<string, boolean>()
  const unencodable = new Set<string>()
  return {
    encode(text) {
      let out = ''
      for (const ch of text) {
        let ok = cache.get(ch)
        if (ok === undefined) {
          try {
            font.widthOfTextAtSize(ch, 12)
            ok = true
          } catch {
            ok = false
          }
          cache.set(ch, ok)
        }
        if (ok) {
          out += ch
        } else {
          unencodable.add(ch)
        }
      }
      return out
    },
    unencodable,
  }
}
