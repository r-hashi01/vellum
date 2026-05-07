import { captureRaster } from './capture'
import { emitPdf } from './emit'
import { discoverFontFaces } from './font-discovery'
import { resolveWebFonts, type WebFontCandidate } from './font-resolver'
import { measure } from './timing'
import type { DomToPdfOptions, DomToPdfResult, TextSpan } from './types'
import { extractSpans } from './walk'

export async function domToPdf(opts: DomToPdfOptions): Promise<DomToPdfResult> {
  const pages = Array.from(opts.pages)
  if (pages.length === 0) {
    throw new Error('domToPdf: at least one page element is required')
  }

  const rasterFormat = opts.rasterFormat ?? 'jpeg'
  const jpegQuality = opts.jpegQuality ?? 0.85
  const pageRasters: Uint8Array[] = []
  const pageSpans: TextSpan[][] = []
  const resolverWarnings: string[] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (!page) continue
    opts.onProgress?.(i, pages.length)

    const spans = await measure(
      async () => extractSpans(page),
      (durationMs) => opts.onTiming?.({ stage: 'walk', page: i + 1, durationMs }),
    )
    pageSpans.push(spans)

    const raster = await measure(
      async () =>
        captureRaster(page, {
          format: rasterFormat,
          quality: jpegQuality,
          width: opts.source.width,
          height: opts.source.height,
        }),
      (durationMs) => opts.onTiming?.({ stage: 'capture', page: i + 1, durationMs }),
    )
    pageRasters.push(raster)
  }

  // Phase 2: discover document @font-face rules and fetch the bytes for the
  // (family, weight, style) triples spans actually use. Resolution lives
  // outside emit because it needs the live Document, while emit only sees
  // serializable data.
  const webFonts: WebFontCandidate[] = await measure(
    async () =>
      resolveWebFonts({
        pageSpans,
        rules: discoverFontFaces(document),
        onWarning: (msg) => resolverWarnings.push(msg),
      }),
    (durationMs) => opts.onTiming?.({ stage: 'fonts', durationMs }),
  )

  const emitResult = await measure(
    async () =>
      emitPdf({
        pageRasters,
        pageSpans,
        webFonts,
        source: opts.source,
        output: { width: opts.output.width, height: opts.output.height },
        rasterFormat,
      }),
    (durationMs) => opts.onTiming?.({ stage: 'emit', durationMs }),
  )

  opts.onProgress?.(pages.length, pages.length)

  return {
    blob: new Blob([emitResult.bytes as BlobPart], { type: 'application/pdf' }),
    warnings: [...resolverWarnings, ...emitResult.warnings],
  }
}
