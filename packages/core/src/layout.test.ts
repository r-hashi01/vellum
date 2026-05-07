import { describe, expect, it } from 'vitest'
import { type LayoutInput, planInlineLayout } from './layout'
import { domPx, type TextSpan } from './types'

function span(x: number, y: number, w: number, h = 16): TextSpan {
  return {
    text: 'x',
    x: domPx(x),
    y: domPx(y),
    w: domPx(w),
    h: domPx(h),
    fontFamily: 'sans-serif',
    fontSize: domPx(h),
    fontWeight: 400,
    fontStyle: 'normal',
    color: { r: 0, g: 0, b: 0, a: 1 },
    letterSpacing: domPx(0),
  }
}
function input(s: TextSpan, drawnWidthDom: number): LayoutInput {
  return { span: s, drawnWidthDom }
}

describe('planInlineLayout', () => {
  it('keeps a single span at its own DOM x', () => {
    const r = planInlineLayout([input(span(50, 100, 80), 75)])
    expect(r[0]?.drawnX).toBe(50)
  })

  it("snaps an inline-adjacent next span to the previous span's drawn end", () => {
    // Spans A (DOM 0..100, drawn 90) and B (DOM 100..150) sit on the same
    // line and are touching in the DOM. With snap, B starts at 90 (where A's
    // PDF glyphs ended), eliminating the visible gap from font-metrics drift.
    const r = planInlineLayout([input(span(0, 100, 100), 90), input(span(100, 100, 50), 45)])
    expect(r[0]?.drawnX).toBe(0)
    expect(r[1]?.drawnX).toBe(90)
  })

  it('compounds snapping across three or more inline-adjacent spans', () => {
    const r = planInlineLayout([
      input(span(0, 100, 100), 90),
      input(span(100, 100, 50), 45),
      input(span(150, 100, 30), 27),
    ])
    expect(r[0]?.drawnX).toBe(0)
    expect(r[1]?.drawnX).toBe(90)
    expect(r[2]?.drawnX).toBe(135)
  })

  it('does not snap when there is a deliberate horizontal gap', () => {
    // Justified text or an inline-block with margin would put a real gap
    // between spans; we must not collapse it.
    const r = planInlineLayout([input(span(0, 100, 100), 90), input(span(150, 100, 50), 45)])
    expect(r[1]?.drawnX).toBe(150)
  })

  it('does not snap across line breaks (different y)', () => {
    const r = planInlineLayout([input(span(0, 100, 100), 90), input(span(0, 120, 100), 90)])
    expect(r[1]?.drawnX).toBe(0)
  })

  it('returns results in input order even when spans are not in left-to-right order', () => {
    const r = planInlineLayout([input(span(100, 100, 50), 45), input(span(0, 100, 100), 90)])
    // Span 1 (DOM x=0) is first on the line → its own x. Span 0 snaps to 90.
    expect(r[1]?.drawnX).toBe(0)
    expect(r[0]?.drawnX).toBe(90)
  })

  it('groups by baseline tolerance proportional to span height (subpixel y differences)', () => {
    // Two spans on the same visual line whose rects differ by 0.4 px in y
    // (common with mixed font sizes) must still group as one line.
    const r = planInlineLayout([
      input(span(0, 100, 100, 16), 90),
      input(span(100, 100.4, 50, 16), 45),
    ])
    expect(r[1]?.drawnX).toBe(90)
  })
})
