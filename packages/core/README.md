# @vellum/core

DOM → high-quality PDF in the browser. Hybrid renderer: rasterized background (everything visual) + real PDF text overlay (selectable, searchable, copyable).

> **Status:** `0.1.0` — Phase 1 (MVP). Multi-page, standard-PDF-font auto-mapping, browser-only. Webfont subsetting is Phase 2.

## Why

Existing browser-side options force a tradeoff:

| Approach                    | Text is selectable | Visual fidelity | Server needed |
| --------------------------- | ------------------ | --------------- | ------------- |
| `html2pdf.js` (canvas)      | ❌                 | OK              | No            |
| `jsPDF.html()` (vector)     | ✅ (limited CSS)   | Breaks easily   | No            |
| `puppeteer` (server-side)   | ✅                 | ✅              | **Yes**       |
| **`@vellum/core`** (hybrid) | ✅                 | ✅              | **No**        |

Vellum rasterizes the page (with text invisibly suppressed) for visual fidelity, then overlays real PDF text positioned via the Range API. Failure modes are *visible* (degraded), never silent.

## Install

```sh
pnpm add @vellum/core
# or: npm i @vellum/core / yarn add @vellum/core
```

## Usage

```ts
import { domToPdf } from '@vellum/core'

const result = await domToPdf({
  pages: document.querySelectorAll<HTMLElement>('.slide-page'),
  source: { width: 1920, height: 1080 }, // logical DOM size
  output: { width: 960, height: 540, unit: 'pt' }, // PDF page size
  rasterFormat: 'jpeg', // 'jpeg' | 'png' (default: 'jpeg')
  jpegQuality: 0.85,
  onProgress: (i, total) => console.log(`page ${i}/${total}`),
  onTiming: (e) => console.log(e), // { stage: 'walk'|'capture'|'emit', ... }
})

// result.blob is the PDF (application/pdf)
// result.warnings lists any characters dropped from the selectable layer
const url = URL.createObjectURL(result.blob)
```

### What gets selectable PDF text

Every visible HTML text node, walked via `TreeWalker` and positioned with `Range.getClientRects()`. Each visual line is one PDF text run. The font is mapped to one of the 12 PDF standard fonts based on the CSS `font-family` chain, `font-weight`, and `font-style`:

| CSS family bucket   | PDF font  |
| ------------------- | --------- |
| sans-serif (`Arial`, `Helvetica`, `system-ui`, …) | Helvetica |
| serif (`Times`, `Georgia`, `serif`, …)            | Times-Roman |
| monospace (`Menlo`, `Consolas`, `monospace`, …)   | Courier |

Bold (`weight ≥ 600`) and italic/oblique pick the matching variant.

### What gets rasterized

Backgrounds, gradients, shadows, SVG, `<img>`, transforms, filters — everything visual. The same characters that aren't selectable (e.g. CJK or emoji that the standard PDF fonts can't encode) are still **visible** in the raster, so users notice when copy/paste is missing them.

### Phase 1 limitations (lifted in Phase 2)

- Webfonts are not subsetted yet. CJK / emoji / glyphs outside Latin1 fall through to the raster only — `result.warnings` lists the unencodable characters.
- No `::before` / `::after` text extraction.
- No Shadow DOM / iframe traversal.
- Single-threaded; no Web Worker parallelism.

See [`PLAN.md`](https://github.com/r-hashi01/vellum/blob/main/PLAN.md) for the full roadmap.

## API

```ts
function domToPdf(opts: DomToPdfOptions): Promise<DomToPdfResult>

interface DomToPdfOptions {
  pages: ArrayLike<HTMLElement>
  source: { width: number; height: number }
  output: { width: number; height: number; unit: 'pt' }
  rasterFormat?: 'jpeg' | 'png'
  jpegQuality?: number
  onProgress?: (pageIndex: number, totalPages: number) => void
  onTiming?: (event: TimingEvent) => void
}

interface DomToPdfResult {
  blob: Blob
  warnings: string[]
}
```

Full types are exported from the package entry.

## License

MIT
