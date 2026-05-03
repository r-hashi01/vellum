import { captureRaster } from './capture.js'
import { emitPdf } from './emit.js'
import { measure } from './timing.js'
import type { DomToPdfOptions, DomToPdfResult, TextSpan } from './types.js'
import { extractSpans } from './walk.js'

export async function domToPdf(opts: DomToPdfOptions): Promise<DomToPdfResult> {
  const pages = Array.from(opts.pages)
  if (pages.length === 0) {
    throw new Error('domToPdf: at least one page element is required')
  }

  const rasterFormat = opts.rasterFormat ?? 'jpeg'
  const jpegQuality = opts.jpegQuality ?? 0.85
  const pageRasters: Uint8Array[] = []
  const pageSpans: TextSpan[][] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (!page) continue
    opts.onProgress?.(i, pages.length)

    // Walk first, then capture. They could run in parallel since walk only
    // reads and capture only writes (then restores) styles, but Phase 0 keeps
    // it sequential for diagnosability.
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

  const emitResult = await measure(
    async () =>
      emitPdf({
        pageRasters,
        pageSpans,
        source: opts.source,
        output: { width: opts.output.width, height: opts.output.height },
        rasterFormat,
      }),
    (durationMs) => opts.onTiming?.({ stage: 'emit', durationMs }),
  )

  opts.onProgress?.(pages.length, pages.length)

  return {
    blob: new Blob([emitResult.bytes as BlobPart], { type: 'application/pdf' }),
    warnings: emitResult.warnings,
  }
}
