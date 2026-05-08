import { describe, expect, it } from 'vitest'
import { measureStandardFont } from './standard-font-metrics'

describe('measureStandardFont', () => {
  it('returns a non-zero width for a basic ASCII string in Helvetica at 12pt', () => {
    const r = measureStandardFont('Helvetica', 'Hello world', 12)
    expect(r.widthPt).toBeGreaterThan(0)
    expect(r.unencodable.size).toBe(0)
  })

  it('scales linearly with font size', () => {
    const a = measureStandardFont('Helvetica', 'Hello', 12)
    const b = measureStandardFont('Helvetica', 'Hello', 24)
    expect(b.widthPt).toBeCloseTo(a.widthPt * 2, 4)
  })

  it('returns 0 width and reports the chars when input is fully unencodable', () => {
    const r = measureStandardFont('Helvetica', '中文', 12)
    expect(r.widthPt).toBe(0)
    expect(r.unencodable.has('中')).toBe(true)
    expect(r.unencodable.has('文')).toBe(true)
  })

  it('omits unencodable chars from the width sum but keeps the encodable ones', () => {
    const r = measureStandardFont('Helvetica', 'A中B', 12)
    const both = measureStandardFont('Helvetica', 'AB', 12)
    expect(r.widthPt).toBeCloseTo(both.widthPt, 4)
    expect(r.unencodable.has('中')).toBe(true)
  })

  it('Courier (monospace) gives every ASCII char the same advance', () => {
    const a = measureStandardFont('Courier', 'A', 10)
    const b = measureStandardFont('Courier', 'M', 10)
    expect(a.widthPt).toBeCloseTo(b.widthPt, 4)
  })
})
