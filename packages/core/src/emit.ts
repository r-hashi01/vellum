import { pickStandardFont, type StandardFontKey } from './font-mapping'
import { findCandidatesForSpan, type WebFontCandidate } from './font-resolver'
import { planInlineLayout } from './layout'
import type { CidFontHandle } from './pdf-writer/cid-font'
import { PdfDoc, type StandardFontHandle, type StandardFontName } from './pdf-writer/pdf-doc'
import { measureStandardFont } from './pdf-writer/standard-font-metrics'
import type { TextSpan } from './types'
import { rangeCoversCodePoint } from './unicode-range'

export interface EmitOptions {
  pageRasters: Uint8Array[]
  pageSpans: TextSpan[][]
  /**
   * @font-face fonts already fetched from allowed origins. Each becomes a
   * subsetted CID-keyed PDF font; spans whose font-family chain matches a
   * candidate use it instead of the standard PDF font fallback.
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

type AnyFont = CidFontHandle | StandardFontHandle

export async function emitPdf(opts: EmitOptions): Promise<EmitResult> {
  const doc = new PdfDoc()
  const warnings: string[] = []
  const unencodableStandard = new Set<string>()

  // Pre-walk every page span, identify which @font-face candidates would
  // actually be picked at draw time (per char, by unicode-range), and embed
  // only those. Skipping unused subsets keeps the output minimal and
  // matches the contract finalize() expects (every embedded font has at
  // least one drawn glyph for sane subsetting).
  const usedCandidates = new Set<WebFontCandidate>()
  for (const pageSpansSet of opts.pageSpans) {
    for (const span of pageSpansSet) {
      const candidates = findCandidatesForSpan(opts.webFonts, span)
      if (candidates.length === 0) continue
      for (const ch of span.text) {
        const cp = ch.codePointAt(0) ?? 0
        for (const c of candidates) {
          if (rangeCoversCodePoint(c.unicodeRange, cp)) {
            usedCandidates.add(c)
            break
          }
        }
      }
    }
  }

  const cidFonts = new Map<WebFontCandidate, CidFontHandle>()
  for (const wf of opts.webFonts) {
    if (!usedCandidates.has(wf)) continue
    try {
      cidFonts.set(
        wf,
        doc.embedCidFont(wf.bytes, {
          onWarning: (msg) => warnings.push(`@font-face "${wf.family}": ${msg}`),
        }),
      )
    } catch (err) {
      warnings.push(
        `Embedding @font-face "${wf.family}" failed: ${(err as Error).message}. ` +
          `Falling back to the standard PDF font for that span.`,
      )
    }
  }

  // Lazily embed only the standard fonts that actually appear in the deck.
  const standardFonts = new Map<StandardFontKey, StandardFontHandle>()
  const getStandardFont = (key: StandardFontKey): StandardFontHandle => {
    let h = standardFonts.get(key)
    if (!h) {
      h = doc.embedStandardFont(key as StandardFontName)
      standardFonts.set(key, h)
    }
    return h
  }

  const scaleX = opts.output.width / opts.source.width
  const scaleY = opts.output.height / opts.source.height

  for (let i = 0; i < opts.pageRasters.length; i++) {
    const rasterBytes = opts.pageRasters[i]
    if (!rasterBytes) continue
    const page = doc.addPage(opts.output.width, opts.output.height)
    const img =
      opts.rasterFormat === 'jpeg' ? doc.embedJpeg(rasterBytes) : await doc.embedPng(rasterBytes)
    page.drawImage(img, 0, 0, opts.output.width, opts.output.height)

    const spans = opts.pageSpans[i] ?? []

    interface DrawRun {
      font: AnyFont
      text: string
      widthDom: number
    }
    interface SpanPlan {
      span: TextSpan
      runs: DrawRun[]
      totalWidthDom: number
    }
    const spanPlans: SpanPlan[] = []
    for (const span of spans) {
      const candidates = findCandidatesForSpan(opts.webFonts, span)
      const stdKey = pickStandardFont(span)
      const stdHandle = getStandardFont(stdKey)
      const fontSizePt = span.fontSize * scaleY
      const runs = splitIntoRuns(span.text, candidates, cidFonts, stdHandle)
      const drawRuns: DrawRun[] = []
      for (const r of runs) {
        if (r.font.kind === 'cid') {
          const enc = r.font.encode(r.text)
          if (enc.bytes.length > 0) {
            const widthPt = (enc.widthUnits * fontSizePt) / 1000
            drawRuns.push({ font: r.font, text: r.text, widthDom: widthPt / scaleX })
            continue
          }
          // CID layout failed (encode emitted a warning). Try the span's
          // standard-font fallback so the chars don't silently disappear.
          const fallback = measureStandardFont(stdKey as StandardFontName, r.text, fontSizePt)
          for (const ch of fallback.unencodable) unencodableStandard.add(ch)
          if (fallback.widthPt > 0) {
            drawRuns.push({ font: stdHandle, text: r.text, widthDom: fallback.widthPt / scaleX })
          }
        } else {
          const m = measureStandardFont(stdKey as StandardFontName, r.text, fontSizePt)
          for (const ch of m.unencodable) unencodableStandard.add(ch)
          if (m.widthPt === 0) continue
          drawRuns.push({ font: r.font, text: r.text, widthDom: m.widthPt / scaleX })
        }
      }
      // The whole span is unencodable — skip entirely so the missing text is
      // *visible* (no selectable layer there) rather than silently substituted.
      if (drawRuns.length === 0) continue
      const totalWidthDom = drawRuns.reduce((s, d) => s + d.widthDom, 0)
      spanPlans.push({ span, runs: drawRuns, totalWidthDom })
    }

    const layout = planInlineLayout(
      spanPlans.map((sp) => ({ span: sp.span, drawnWidthDom: sp.totalWidthDom })),
    )

    for (let j = 0; j < spanPlans.length; j++) {
      const sp = spanPlans[j]
      const plan = layout[j]
      if (!sp || !plan) continue
      // CSS rect.y is the top of the line box (axis pointing down).
      // PDF drawText's y is the baseline (axis pointing up from page bottom).
      const baselineCss = sp.span.y + sp.span.h
      const baselinePdf = opts.output.height - baselineCss * scaleY
      let runX = plan.drawnX
      for (const run of sp.runs) {
        page.drawText(run.text, run.font, runX * scaleX, baselinePdf, sp.span.fontSize * scaleY)
        runX += run.widthDom
      }
    }
  }

  if (unencodableStandard.size > 0) {
    const sample = [...unencodableStandard].slice(0, 12).join('')
    warnings.push(
      `Standard PDF fonts cannot encode ${unencodableStandard.size} character(s); ` +
        `text containing them was dropped from the selectable layer (raster still shows them). ` +
        `Sample: "${sample}". Add an @font-face that covers these characters to fix.`,
    )
  }

  return { bytes: doc.save(), warnings }
}

interface RunSlice {
  font: AnyFont
  text: string
}

/**
 * Split a span's text into runs, each mapped to the first font that can
 * actually serve that character — first-match-wins through the matched
 * web-font candidates by unicode-range, falling back to the standard 14
 * font picked for the span.
 *
 * Consecutive characters with the same font collapse into one run, so we
 * only emit one drawText per font-switch and each font's glyph subset stays
 * tight.
 */
function splitIntoRuns(
  text: string,
  candidates: readonly WebFontCandidate[],
  cidFonts: Map<WebFontCandidate, CidFontHandle>,
  fallback: StandardFontHandle,
): RunSlice[] {
  const runs: RunSlice[] = []
  let cur: RunSlice | null = null
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    let chosen: AnyFont = fallback
    for (const c of candidates) {
      if (rangeCoversCodePoint(c.unicodeRange, cp)) {
        const handle = cidFonts.get(c)
        if (handle) {
          chosen = handle
          break
        }
      }
    }
    if (cur && cur.font === chosen) {
      cur.text += ch
    } else {
      cur = { font: chosen, text: ch }
      runs.push(cur)
    }
  }
  return runs
}
