import { describe, expect, it } from 'vitest'
import { encodeWinAnsi } from './winansi'

describe('encodeWinAnsi', () => {
  it('passes basic ASCII through unchanged (one byte per char)', () => {
    const r = encodeWinAnsi('Hello, world!')
    expect(Array.from(r.bytes)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x21,
    ])
    expect(r.unencodable.size).toBe(0)
  })

  it('passes Latin-1 supplement (0xA0–0xFF) through unchanged — that is the bulk of WinAnsi', () => {
    // é (U+00E9), ü (U+00FC), ñ (U+00F1)
    const r = encodeWinAnsi('café Müller niño')
    expect(Array.from(r.bytes)).toEqual([
      0x63, 0x61, 0x66, 0xe9, 0x20, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0x6e, 0x69, 0xf1,
      0x6f,
    ])
    expect(r.unencodable.size).toBe(0)
  })

  it('maps the WinAnsi exotic block (€ ‘ ’ – — Œ etc) to their 0x80–0x9F bytes', () => {
    expect(encodeWinAnsi('€').bytes[0]).toBe(0x80)
    expect(encodeWinAnsi('‘').bytes[0]).toBe(0x91)
    expect(encodeWinAnsi('’').bytes[0]).toBe(0x92)
    expect(encodeWinAnsi('“').bytes[0]).toBe(0x93)
    expect(encodeWinAnsi('”').bytes[0]).toBe(0x94)
    expect(encodeWinAnsi('–').bytes[0]).toBe(0x96)
    expect(encodeWinAnsi('—').bytes[0]).toBe(0x97)
    expect(encodeWinAnsi('Œ').bytes[0]).toBe(0x8c)
    expect(encodeWinAnsi('œ').bytes[0]).toBe(0x9c)
  })

  it('drops characters outside WinAnsi and reports them in `unencodable`', () => {
    // Both are well-known WinAnsi gaps: U+2192 (→), U+4E2D (中).
    const r = encodeWinAnsi('A→中B')
    expect(Array.from(r.bytes)).toEqual([0x41, 0x42])
    expect(r.unencodable.has('→')).toBe(true)
    expect(r.unencodable.has('中')).toBe(true)
  })

  it('handles non-BMP code points by dropping them (no surrogate halves leak through)', () => {
    // 🙂 = U+1F642
    const r = encodeWinAnsi('Hi 🙂')
    expect(Array.from(r.bytes)).toEqual([0x48, 0x69, 0x20])
    expect(r.unencodable.size).toBe(1)
    expect([...r.unencodable][0]).toBe('🙂')
  })
})
