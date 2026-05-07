import { PDFDocument, type PDFFont, rgb } from 'pdf-lib'
import { pickStandardFont, type StandardFontKey } from './font-mapping.js'
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

interface FontEntry {
  font: PDFFont
  encoder: SafeEncoder
}

export async function emitPdf(opts: EmitOptions): Promise<EmitResult> {
  const pdf = await PDFDocument.create()

  // Lazily embed only the standard fonts that actually appear in the deck.
  // Embedding all 12 up front would bloat tiny PDFs.
  const fonts = new Map<StandardFontKey, FontEntry>()
  const getFont = async (key: StandardFontKey): Promise<FontEntry> => {
    let entry = fonts.get(key)
    if (!entry) {
      const font = await pdf.embedFont(key)
      entry = { font, encoder: createSafeEncoder(font) }
      fonts.set(key, entry)
    }
    return entry
  }

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
      const key = pickStandardFont(span)
      const { font, encoder } = await getFont(key)
      const safeText = encoder.encode(span.text)
      // The whole span is unencodable (CJK page in Phase 1, etc.) — skip
      // entirely so the missing text is *visible* (no selectable layer there)
      // rather than silently substituted.
      if (safeText.length === 0) continue
      drawSpan(page, font, { ...span, text: safeText }, scaleX, scaleY, opts.output.height)
    }
  }

  const bytes = await pdf.save()
  const warnings = collectWarnings(fonts)
  return { bytes, warnings }
}

function collectWarnings(fonts: Map<StandardFontKey, FontEntry>): string[] {
  // Union the unencodable sets from every embedded standard font: a character
  // missing from one variant (e.g. Helvetica-Bold) is also missing from the
  // others, so this is effectively the deck-wide set of characters that the
  // standard PDF fonts can't represent (CJK, emoji, …).
  const all = new Set<string>()
  for (const { encoder } of fonts.values()) {
    for (const ch of encoder.unencodable) all.add(ch)
  }
  if (all.size === 0) return []
  const sample = [...all].slice(0, 12).join('')
  return [
    `Standard PDF fonts cannot encode ${all.size} character(s); ` +
      `text containing them was dropped from the selectable layer (raster still shows them). ` +
      `Sample: "${sample}". Phase 2 will fix this by subsetting @font-face fonts.`,
  ]
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
  // mismatches between the raster's fonts and the standard PDF fonts are
  // acceptable here since the user reads the raster, not the vector glyphs.
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
