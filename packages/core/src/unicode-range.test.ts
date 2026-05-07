import { describe, expect, it } from 'vitest'
import { parseUnicodeRange, rangeCoversCodePoint } from './unicode-range'

describe('parseUnicodeRange', () => {
  it('returns null for an empty descriptor (callers treat null as "covers all")', () => {
    expect(parseUnicodeRange('')).toBeNull()
    expect(parseUnicodeRange('   ')).toBeNull()
  })

  it('parses a single code point', () => {
    expect(parseUnicodeRange('U+26')).toEqual([{ start: 0x26, end: 0x26 }])
  })

  it('parses a hex-hex range', () => {
    expect(parseUnicodeRange('U+0-7F')).toEqual([{ start: 0, end: 0x7f }])
    expect(parseUnicodeRange('U+0061-007A')).toEqual([{ start: 0x61, end: 0x7a }])
  })

  it('expands a wildcard `?` (e.g. U+00?? → 0x0000..0x00FF)', () => {
    expect(parseUnicodeRange('U+00??')).toEqual([{ start: 0, end: 0xff }])
    expect(parseUnicodeRange('U+1F4??')).toEqual([{ start: 0x1f400, end: 0x1f4ff }])
  })

  it('parses a comma-separated list', () => {
    expect(parseUnicodeRange('U+0-7F, U+A0-FF')).toEqual([
      { start: 0, end: 0x7f },
      { start: 0xa0, end: 0xff },
    ])
  })

  it('returns null when any segment is malformed (so callers treat it as "no constraint")', () => {
    // Better to be permissive than to drop characters silently.
    expect(parseUnicodeRange('U+ZZ')).toBeNull()
    expect(parseUnicodeRange('not-a-range')).toBeNull()
    expect(parseUnicodeRange('U+0-7F, garbage')).toBeNull()
  })

  it('rejects an inverted range (end < start)', () => {
    expect(parseUnicodeRange('U+7F-00')).toBeNull()
  })
})

describe('rangeCoversCodePoint', () => {
  it('treats null ranges as "covers everything"', () => {
    expect(rangeCoversCodePoint(null, 0x41)).toBe(true)
    expect(rangeCoversCodePoint(null, 0x4e2d)).toBe(true)
  })

  it('returns true when cp is inside any range', () => {
    const r = parseUnicodeRange('U+0-7F, U+A0-FF')
    expect(rangeCoversCodePoint(r, 0x41)).toBe(true)
    expect(rangeCoversCodePoint(r, 0xa5)).toBe(true)
  })

  it('returns false when cp is in none of the ranges', () => {
    const r = parseUnicodeRange('U+0-7F, U+A0-FF')
    expect(rangeCoversCodePoint(r, 0x80)).toBe(false)
    expect(rangeCoversCodePoint(r, 0x100)).toBe(false)
    expect(rangeCoversCodePoint(r, 0x4e2d)).toBe(false)
  })
})
