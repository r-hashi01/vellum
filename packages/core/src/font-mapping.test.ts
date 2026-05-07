import { describe, expect, it } from 'vitest'
import { classifyFamily, pickStandardFont, type StandardFontKey } from './font-mapping'
import { domPx, type FontStyle, type TextSpan } from './types'

function span(
  fontFamily: string,
  fontWeight = 400,
  fontStyle: FontStyle = 'normal',
): Pick<TextSpan, 'fontFamily' | 'fontWeight' | 'fontStyle'> {
  return { fontFamily, fontWeight, fontStyle }
}

describe('classifyFamily', () => {
  it('maps generic keywords', () => {
    expect(classifyFamily('serif')).toBe('serif')
    expect(classifyFamily('sans-serif')).toBe('sans')
    expect(classifyFamily('monospace')).toBe('mono')
    expect(classifyFamily('ui-monospace')).toBe('mono')
    expect(classifyFamily('system-ui')).toBe('sans')
  })

  it('walks the family chain left-to-right and returns the first matched bucket', () => {
    // Unknown name first, then a generic — the generic decides.
    expect(classifyFamily('"Some Custom Font", serif')).toBe('serif')
    // Quoted name with spaces, recognized.
    expect(classifyFamily('"Times New Roman", Times, serif')).toBe('serif')
    // Mixed case is normalized.
    expect(classifyFamily('Helvetica Neue, Arial, sans-serif')).toBe('sans')
    expect(classifyFamily("'Fira Code', monospace")).toBe('mono')
  })

  it('falls back to sans for entirely unknown chains', () => {
    expect(classifyFamily('Foo, Bar, Baz')).toBe('sans')
  })
})

describe('pickStandardFont', () => {
  it('picks Helvetica family for sans-serif chains', () => {
    expect(pickStandardFont(span('Arial, sans-serif'))).toBe('Helvetica')
    expect(pickStandardFont(span('Arial, sans-serif', 700))).toBe('Helvetica-Bold')
    expect(pickStandardFont(span('Arial, sans-serif', 400, 'italic'))).toBe('Helvetica-Oblique')
    expect(pickStandardFont(span('Arial, sans-serif', 700, 'italic'))).toBe('Helvetica-BoldOblique')
  })

  it('picks Times family for serif chains', () => {
    expect(pickStandardFont(span('Georgia, serif'))).toBe('Times-Roman')
    expect(pickStandardFont(span('Georgia, serif', 800))).toBe('Times-Bold')
    expect(pickStandardFont(span('Georgia, serif', 400, 'italic'))).toBe('Times-Italic')
    expect(pickStandardFont(span('Georgia, serif', 700, 'oblique'))).toBe('Times-BoldItalic')
  })

  it('picks Courier family for monospace chains', () => {
    expect(pickStandardFont(span('Menlo, monospace'))).toBe('Courier')
    expect(pickStandardFont(span('Menlo, monospace', 700))).toBe('Courier-Bold')
    expect(pickStandardFont(span('Menlo, monospace', 400, 'italic'))).toBe('Courier-Oblique')
    expect(pickStandardFont(span('Menlo, monospace', 700, 'italic'))).toBe('Courier-BoldOblique')
  })

  it('treats weight >= 600 as bold (semi-bold edge case)', () => {
    expect(pickStandardFont(span('Arial, sans-serif', 500))).toBe('Helvetica')
    expect(pickStandardFont(span('Arial, sans-serif', 600))).toBe('Helvetica-Bold')
  })

  it('defaults to Helvetica for completely unrecognized families', () => {
    expect(pickStandardFont(span('CompletelyMadeUp'))).toBe('Helvetica')
  })

  it('returns one of the 12 supported StandardFontKey values', () => {
    const valid: StandardFontKey[] = [
      'Helvetica',
      'Helvetica-Bold',
      'Helvetica-Oblique',
      'Helvetica-BoldOblique',
      'Times-Roman',
      'Times-Bold',
      'Times-Italic',
      'Times-BoldItalic',
      'Courier',
      'Courier-Bold',
      'Courier-Oblique',
      'Courier-BoldOblique',
    ]
    const all: StandardFontKey[] = [
      pickStandardFont(span('Arial, sans-serif')),
      pickStandardFont(span('Georgia, serif', 700, 'italic')),
      pickStandardFont(span('Menlo, monospace', 700)),
    ]
    for (const k of all) expect(valid).toContain(k)
  })
})

// Coordinate helper to satisfy the TextSpan brand without ceremony.
void domPx
