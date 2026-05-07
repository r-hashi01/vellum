import type { TextSpan } from './types'

export interface LayoutInput {
  span: TextSpan
  /**
   * Width that the actually-drawn PDF glyphs will occupy, expressed in the
   * same DOM-pixel units as `span.x` / `span.w`. Computed by the caller via
   * `font.widthOfTextAtSize(...) / scaleX`.
   */
  drawnWidthDom: number
}

export interface LayoutResult {
  /** Final draw-x in DOM pixels. The caller still scales it to PDF points. */
  drawnX: number
}

/**
 * Compute the final draw-x for each span. Spans that were inline-adjacent on
 * the same line in the DOM (`span.x ≈ previous span's right edge`) are
 * "snapped" to start exactly where the previous span's PDF glyphs ended — so
 * the inevitable metrics drift between the CSS-rendered font and the embedded
 * PDF font does not open a visible gap at every `<b>` / `<code>` / `<i>`
 * boundary. Spans that aren't inline-adjacent (different line, or with a
 * deliberate horizontal gap) keep their original DOM x.
 *
 * Pure function; tested in isolation. The drift is small (a few percent of a
 * character width) but accumulates visibly at every inline boundary if left
 * uncorrected — see progress.md / Phase 2 (b).
 */
export function planInlineLayout(items: readonly LayoutInput[]): LayoutResult[] {
  // Tag each item with its original index so we can return results in input
  // order even though we sort by x within each line group.
  type Tagged = LayoutInput & { i: number }
  const tagged: Tagged[] = items.map((it, i) => ({ ...it, i }))

  const lines: Tagged[][] = []
  for (const it of tagged) {
    const itMid = it.span.y + it.span.h / 2
    const line = lines.find((l) => {
      const head = l[0]
      if (!head) return false
      const headMid = head.span.y + head.span.h / 2
      const tol = Math.min(head.span.h, it.span.h) / 2
      return Math.abs(headMid - itMid) <= tol
    })
    if (line) line.push(it)
    else lines.push([it])
  }

  const out: LayoutResult[] = new Array(items.length)
  for (const line of lines) {
    line.sort((a, b) => a.span.x - b.span.x)
    let prevDomEnd: number | null = null
    let prevDrawnEnd: number | null = null
    for (const it of line) {
      const domStart: number = it.span.x
      const snap: boolean =
        prevDomEnd !== null && prevDrawnEnd !== null && Math.abs(domStart - prevDomEnd) < 1.5
      const drawnX: number = snap && prevDrawnEnd !== null ? prevDrawnEnd : domStart
      out[it.i] = { drawnX }
      prevDomEnd = domStart + it.span.w
      prevDrawnEnd = drawnX + it.drawnWidthDom
    }
  }
  return out
}

// Re-exported for test convenience only.
export type { TextSpan }
