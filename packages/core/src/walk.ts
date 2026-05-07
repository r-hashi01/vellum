import { parseColor } from './color'
import { type DomPx, domPx, type FontStyle, type TextSpan } from './types'

/**
 * Extract every visible text fragment from `root` as a flat list of
 * line-level spans. Coordinates are returned relative to `root`'s top-left.
 *
 * Phase 0 scope: HTML text only. No SVG `<text>`, no `::before`/`::after`,
 * no Shadow DOM, no iframes.
 */
export function extractSpans(root: HTMLElement): TextSpan[] {
  const rootRect = root.getBoundingClientRect()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const text = node.nodeValue ?? ''
      if (text.trim() === '') return NodeFilter.FILTER_REJECT
      const cs = window.getComputedStyle(parent)
      if (cs.visibility === 'hidden' || cs.display === 'none') {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const spans: TextSpan[] = []
  let node = walker.nextNode() as Text | null
  while (node !== null) {
    const parent = node.parentElement
    if (parent) {
      pushSpansForTextNode(node, parent, rootRect, spans)
    }
    node = walker.nextNode() as Text | null
  }
  return spans
}

function pushSpansForTextNode(
  text: Text,
  parent: HTMLElement,
  rootRect: DOMRect,
  out: TextSpan[],
): void {
  const range = document.createRange()
  range.selectNodeContents(text)
  const lineRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  if (lineRects.length === 0) return

  const cs = window.getComputedStyle(parent)
  const fontFamily = cs.fontFamily
  const fontSize = domPx(Number.parseFloat(cs.fontSize))
  const fontWeight = parseFontWeight(cs.fontWeight)
  const fontStyle = parseFontStyle(cs.fontStyle)
  const color = parseColor(cs.color)
  const letterSpacing = domPx(Number.parseFloat(cs.letterSpacing) || 0)
  const whiteSpace = cs.whiteSpace

  const lines = splitTextByLines(text, lineRects)

  for (const line of lines) {
    const normalized = normalizeLineWhitespace(line.text, whiteSpace)
    if (normalized === '') continue
    out.push({
      text: normalized,
      x: domPx(line.rect.x - rootRect.x),
      y: domPx(line.rect.y - rootRect.y),
      w: domPx(line.rect.width),
      h: domPx(line.rect.height),
      fontFamily,
      fontSize,
      fontWeight,
      fontStyle,
      color,
      letterSpacing,
    })
  }
}

/**
 * Apply CSS `white-space` normalization to a single visual line's slice. The
 * raw text node `.data` includes source-HTML indentation (newlines + spaces)
 * that the browser collapses before laying the text out — so the rect.x we
 * captured corresponds to the trimmed-and-collapsed start, not the raw start.
 * If we hand the raw slice to `drawText` the leading whitespace is rendered
 * literally and pushes the visible text right by the width of the indent.
 *
 * Phase 0 handles only the `normal` family. `pre` / `pre-wrap` preserve
 * whitespace and are deferred.
 */
function normalizeLineWhitespace(s: string, whiteSpace: string): string {
  if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces') {
    return s
  }
  return s.replace(/\s+/g, ' ').trim()
}

interface Line {
  text: string
  rect: DOMRect
}

/**
 * Map characters of a text node onto the line rects it occupies. For wrapped
 * text, `lineRects` has one entry per visual line; we binary-search for each
 * line break by character offset.
 */
function splitTextByLines(text: Text, lineRects: DOMRect[]): Line[] {
  if (lineRects.length === 1) {
    const only = lineRects[0]
    if (!only) return []
    return [{ text: text.data, rect: only }]
  }

  const range = document.createRange()
  const length = text.data.length
  const result: Line[] = []
  let charStart = 0

  for (let i = 0; i < lineRects.length - 1; i++) {
    const currentLine = lineRects[i]
    if (!currentLine) continue
    const lineTop = currentLine.top
    // Find smallest offset > charStart whose character starts on a line below.
    let lo = charStart + 1
    let hi = length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      range.setStart(text, mid)
      range.setEnd(text, Math.min(mid + 1, length))
      const charRect = range.getBoundingClientRect()
      if (charRect.top > lineTop + 0.5) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }
    result.push({ text: text.data.slice(charStart, lo), rect: currentLine })
    charStart = lo
  }
  const last = lineRects[lineRects.length - 1]
  if (last) {
    result.push({ text: text.data.slice(charStart), rect: last })
  }
  return result
}

function parseFontWeight(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isNaN(n)) return n
  if (value === 'bold') return 700
  if (value === 'normal') return 400
  return 400
}

function parseFontStyle(value: string): FontStyle {
  if (value === 'italic' || value === 'oblique') return value
  return 'normal'
}

// Re-export DomPx for tests that want to assert on it
export type { DomPx }
