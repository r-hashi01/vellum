import * as fontkit from 'fontkit'
import { PDFDocument, type PDFFont, rgb } from 'pdf-lib'
import { pickStandardFont, type StandardFontKey } from './font-mapping'
import { findCandidate, type WebFontCandidate } from './font-resolver'
import { planInlineLayout } from './layout'
import type { TextSpan } from './types'

export interface EmitOptions {
  pageRasters: Uint8Array[]
  pageSpans: TextSpan[][]
  /**
   * @font-face fonts already fetched from allowed origins. Each becomes a
   * subsetted PDF font; spans whose font-family chain matches a candidate
   * use it instead of the standard PDF font fallback.
   */
  webFonts: WebFontCandidate[]
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
  // pdf-lib refuses to embed non-standard fonts unless fontkit is registered.
  // Done unconditionally — registration is cheap and the standard-only path
  // is unaffected.
  pdf.registerFontkit(fontkit as unknown as Parameters<typeof pdf.registerFontkit>[0])

  const warnings: string[] = []

  // Subset and embed every web font candidate up front. If embedding fails
  // (corrupt bytes, unsupported format), we record a warning and let the
  // affected spans fall back to the standard PDF font path — failures stay
  // visible (degraded), never silent.
  const webFonts = new Map<WebFontCandidate, FontEntry>()
  for (const wf of opts.webFonts) {
    try {
      const font = await pdf.embedFont(wf.bytes, { subset: true })
      webFonts.set(wf, { font, encoder: createSafeEncoder(font) })
    } catch (err) {
      warnings.push(
        `Embedding @font-face "${wf.family}" failed: ${(err as Error).message}. ` +
          `Falling back to the standard PDF font for that span.`,
      )
    }
  }

  // Lazily embed only the standard fonts that actually appear in the deck.
  const standardFonts = new Map<StandardFontKey, FontEntry>()
  const getStandardFont = async (key: StandardFontKey): Promise<FontEntry> => {
    let entry = standardFonts.get(key)
    if (!entry) {
      const font = await pdf.embedFont(key)
      entry = { font, encoder: createSafeEncoder(font) }
      standardFonts.set(key, entry)
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
    // Pass 1: encode + measure each span so we can plan inline-boundary
    // snapping with knowledge of how wide the PDF glyphs actually are.
    interface Drawable {
      span: TextSpan
      safeText: string
      font: PDFFont
      drawnWidthDom: number
    }
    const drawables: Drawable[] = []
    for (const span of spans) {
      const wf = findCandidate(opts.webFonts, span)
      const entry = wf ? webFonts.get(wf) : undefined
      const { font, encoder } = entry ?? (await getStandardFont(pickStandardFont(span)))
      const safeText = encoder.encode(span.text)
      // The whole span is unencodable — skip entirely so the missing text is
      // *visible* (no selectable layer there) rather than silently substituted.
      if (safeText.length === 0) continue
      const drawnWidthPt = font.widthOfTextAtSize(safeText, span.fontSize * scaleY)
      drawables.push({ span, safeText, font, drawnWidthDom: drawnWidthPt / scaleX })
    }
    const layout = planInlineLayout(
      drawables.map((d) => ({ span: d.span, drawnWidthDom: d.drawnWidthDom })),
    )
    // Pass 2: draw with snapped x where appropriate.
    for (let j = 0; j < drawables.length; j++) {
      const d = drawables[j]
      const plan = layout[j]
      if (!d || !plan) continue
      drawSpan(
        page,
        d.font,
        { ...d.span, text: d.safeText, x: plan.drawnX as TextSpan['x'] },
        scaleX,
        scaleY,
        opts.output.height,
      )
    }
  }

  const bytes = await pdf.save()
  warnings.push(...collectFallbackWarnings(standardFonts))
  return { bytes, warnings }
}

function collectFallbackWarnings(fonts: Map<StandardFontKey, FontEntry>): string[] {
  // Union the unencodable sets from every embedded standard font: a character
  // missing from one variant (e.g. Helvetica-Bold) is also missing from the
  // others, so this is effectively the deck-wide set of characters that the
  // standard PDF fonts can't represent (CJK, emoji, …) and that no @font-face
  // covered either.
  const all = new Set<string>()
  for (const { encoder } of fonts.values()) {
    for (const ch of encoder.unencodable) all.add(ch)
  }
  if (all.size === 0) return []
  const sample = [...all].slice(0, 12).join('')
  return [
    `Standard PDF fonts cannot encode ${all.size} character(s); ` +
      `text containing them was dropped from the selectable layer (raster still shows them). ` +
      `Sample: "${sample}". Add an @font-face that covers these characters to fix.`,
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
