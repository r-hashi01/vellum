import * as fontkit from 'fontkit'
import { PDFDocument, type PDFFont, rgb } from 'pdf-lib'
import { pickStandardFont, type StandardFontKey } from './font-mapping'
import { findCandidatesForSpan, type WebFontCandidate } from './font-resolver'
import { planInlineLayout } from './layout'
import { domPx, type TextSpan } from './types'
import { rangeCoversCodePoint } from './unicode-range'

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
  // Some webfont woff2 files (notably some unicode-range subsets served by
  // Google Fonts) make pdf-lib's subset path crash at save time with
  // `subset.encodeStream is not a function`. The failure mode is a save-time
  // throw, *after* every embed and drawText has succeeded, so we can't catch
  // it during the normal flow — we have to rebuild the doc without the
  // subset embedder. Subsetting is the small-PDF win we don't want to lose
  // when it works, so we attempt it first and fall back only on demonstrated
  // failure.
  try {
    return await emitPdfOnce(opts, /* useSubset */ true)
  } catch (err) {
    if (!isSubsetEncodeStreamError(err)) throw err
    const result = await emitPdfOnce(opts, /* useSubset */ false)
    result.warnings.unshift(
      `Subsetting failed (${(err as Error).message}); embedded full webfont files instead. ` +
        `PDF size will be larger than ideal.`,
    )
    return result
  }
}

function isSubsetEncodeStreamError(err: unknown): boolean {
  // Root cause: fontkit@2.x's Subset class no longer exposes encodeStream(),
  // which pdf-lib@1.17.1 calls at save time (CustomFontSubsetEmbedder.serializeFont).
  // pdf-lib hasn't released since 2023 and has not adopted the new fontkit API,
  // so any subsetted webfont save will hit this. Tracked for replacement by
  // an in-house emitter; until then we fall back to embedding the full file.
  return err instanceof Error && /subset\.encodeStream is not a function/i.test(err.message)
}

async function emitPdfOnce(opts: EmitOptions, useSubset: boolean): Promise<EmitResult> {
  const pdf = await PDFDocument.create()
  // pdf-lib refuses to embed non-standard fonts unless fontkit is registered.
  // Done unconditionally — registration is cheap and the standard-only path
  // is unaffected.
  pdf.registerFontkit(fontkit as unknown as Parameters<typeof pdf.registerFontkit>[0])

  const warnings: string[] = []

  // Pre-walk every page span, identify which @font-face candidates would
  // actually be picked at draw time (per char, by unicode-range), and embed
  // only those. This matters because pdf-lib's subset path calls
  // `subset.encodeStream()` at save time on every embedded font; an embedded
  // subset that ended up with zero glyphs (e.g. the cyrillic Inter subset on
  // an English-only deck) crashes at save with `encodeStream is not a
  // function`. Skipping the unused subsets avoids that entirely.
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
  const webFonts = new Map<WebFontCandidate, FontEntry>()
  for (const wf of opts.webFonts) {
    if (!usedCandidates.has(wf)) continue
    try {
      const font = await pdf.embedFont(wf.bytes, { subset: useSubset })
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
    // Pass 1: split each span into per-font runs (driven by `unicode-range`
    // on the matched @font-face candidates) and measure each run's drawn
    // width. The layout planner sees span-level totals; within a span we lay
    // runs out cumulatively in pass 2.
    interface DrawRun {
      font: PDFFont
      safeText: string
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
      const stdEntry = await getStandardFont(pickStandardFont(span))
      const runs = splitIntoRuns(span.text, candidates, webFonts, stdEntry)
      const drawRuns: DrawRun[] = []
      for (const r of runs) {
        const safe = r.entry.encoder.encode(r.text)
        if (safe.length === 0) continue
        const widthPt = r.entry.font.widthOfTextAtSize(safe, span.fontSize * scaleY)
        drawRuns.push({ font: r.entry.font, safeText: safe, widthDom: widthPt / scaleX })
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
    // Pass 2: for each span, draw its runs cumulatively starting at the
    // planned x. Inter-span snap is handled by the planner; intra-span run
    // placement uses each run's measured PDF-glyph width directly.
    for (let j = 0; j < spanPlans.length; j++) {
      const sp = spanPlans[j]
      const plan = layout[j]
      if (!sp || !plan) continue
      let runX = plan.drawnX
      for (const run of sp.runs) {
        drawSpan(
          page,
          run.font,
          { ...sp.span, text: run.safeText, x: domPx(runX) },
          scaleX,
          scaleY,
          opts.output.height,
        )
        runX += run.widthDom
      }
    }
  }

  const bytes = await pdf.save()
  warnings.push(...collectFallbackWarnings(standardFonts))
  return { bytes, warnings }
}

interface RunSlice {
  text: string
  entry: FontEntry
}

/**
 * Split a span's text into runs, where each run's characters all map to the
 * same PDF font. Per-character mapping rule:
 *
 *   1. Walk the matched web-font candidates in `findCandidatesForSpan` order
 *      and pick the first whose `unicode-range` covers this code point.
 *   2. Fallback: the standard PDF font selected by font-mapping.
 *
 * Consecutive characters with the same chosen font collapse into one run, so
 * we only call `drawText` once per font-switch — minimizing both PDF text
 * objects and metric drift opportunities.
 */
function splitIntoRuns(
  text: string,
  candidates: readonly WebFontCandidate[],
  webFonts: Map<WebFontCandidate, FontEntry>,
  fallback: FontEntry,
): RunSlice[] {
  const runs: RunSlice[] = []
  let cur: RunSlice | null = null
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    let chosen: FontEntry | null = null
    for (const c of candidates) {
      if (rangeCoversCodePoint(c.unicodeRange, cp)) {
        const e = webFonts.get(c)
        if (e) {
          chosen = e
          break
        }
      }
    }
    if (!chosen) chosen = fallback
    if (cur && cur.entry.font === chosen.font) {
      cur.text += ch
    } else {
      cur = { text: ch, entry: chosen }
      runs.push(cur)
    }
  }
  return runs
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
