// Branded numeric types so coordinate-system mistakes (DOM px vs PDF pt) become
// compile-time errors. There is exactly one place that converts between them
// (the `emit` stage); everywhere else, the brand is preserved.

export type DomPx = number & { readonly __brand: 'DomPx' }
export type PdfPt = number & { readonly __brand: 'PdfPt' }

export const domPx = (n: number): DomPx => n as DomPx
export const pdfPt = (n: number): PdfPt => n as PdfPt

export interface RGB {
  /** 0-1 */ r: number
  /** 0-1 */ g: number
  /** 0-1 */ b: number
  /** 0-1 */ a: number
}

export type FontStyle = 'normal' | 'italic' | 'oblique'

export interface TextSpan {
  text: string
  /** Position relative to the page element's top-left, in DOM pixels. */
  x: DomPx
  y: DomPx
  /** Line-box width and height in DOM pixels. */
  w: DomPx
  h: DomPx
  fontFamily: string
  fontSize: DomPx
  /** CSS font-weight as a number (100-900). */
  fontWeight: number
  fontStyle: FontStyle
  color: RGB
  letterSpacing: DomPx
}

export interface DomToPdfOptions {
  /** The page elements to render. Each becomes one PDF page. */
  pages: ArrayLike<HTMLElement>
  /** Logical DOM dimensions of each page (must match the element's rendered size). */
  source: { width: number; height: number }
  /** Output PDF page dimensions in PDF points. */
  output: { width: number; height: number; unit: 'pt' }
  /** Default: 'jpeg'. */
  rasterFormat?: 'jpeg' | 'png'
  /** Default: 0.85. Only used when rasterFormat === 'jpeg'. */
  jpegQuality?: number
  /** Called as `(pageIndex, totalPages)` before each page is processed. */
  onProgress?: (pageIndex: number, totalPages: number) => void
  /** Called once per stage with timing data. */
  onTiming?: (event: TimingEvent) => void
}

export type TimingEvent =
  | { stage: 'walk'; page: number; durationMs: number }
  | { stage: 'capture'; page: number; durationMs: number }
  | { stage: 'fonts'; durationMs: number }
  | { stage: 'emit'; durationMs: number }

export interface DomToPdfResult {
  blob: Blob
  warnings: string[]
}
