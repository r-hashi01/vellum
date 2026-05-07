import { describe, expect, it } from 'vitest'
import {
  PdfArray,
  PdfBool,
  PdfDict,
  PdfHexString,
  PdfName,
  PdfNumber,
  PdfRef,
  PdfStream,
  PdfString,
} from './object'
import { PdfWriter } from './writer'

// We decode in latin-1 so each byte maps to exactly one JS string code unit.
// This keeps `text.slice(byteOffset, ...)` honest for assertions that probe
// byte offsets (xref) — UTF-8 decode would either drop or replace the binary
// marker bytes (0xE2 0xE3 0xCF 0xD3) and shift everything after.
const dec = new TextDecoder('latin1')
function decode(bytes: Uint8Array): string {
  return dec.decode(bytes)
}

describe('PdfName', () => {
  it('serializes a plain ASCII name with a leading slash', () => {
    expect(decode(new PdfName('Type').serialize())).toBe('/Type')
  })
  it('escapes special characters as #xx', () => {
    expect(decode(new PdfName('Name#With Spaces').serialize())).toBe('/Name#23With#20Spaces')
  })
})

describe('PdfString', () => {
  it('escapes parens and backslashes inside literal strings', () => {
    expect(decode(new PdfString('a(b)c\\d').serialize())).toBe('(a\\(b\\)c\\\\d)')
  })
})

describe('PdfHexString', () => {
  it('serializes bytes as upper-case hex inside angle brackets', () => {
    expect(decode(new PdfHexString(new Uint8Array([0xfe, 0xff, 0x00, 0x41])).serialize())).toBe(
      '<FEFF0041>',
    )
  })
})

describe('PdfArray', () => {
  it('serializes mixed values with single-space separation', () => {
    const a = new PdfArray([new PdfNumber(1), new PdfBool(true), new PdfName('X')])
    expect(decode(a.serialize())).toBe('[1 true /X]')
  })
})

describe('PdfDict', () => {
  it('serializes entries on separate lines with names + values', () => {
    const d = new PdfDict({ Type: new PdfName('Catalog'), Count: new PdfNumber(0) })
    expect(decode(d.serialize())).toBe('<<\n/Type /Catalog\n/Count 0\n>>')
  })
})

describe('PdfStream', () => {
  it('injects /Length matching the data length', () => {
    const data = new Uint8Array([0x42, 0x42, 0x42])
    const out = decode(new PdfStream({ Filter: new PdfName('FlateDecode') }, data).serialize())
    expect(out).toContain('/Length 3')
    expect(out).toContain('/Filter /FlateDecode')
    expect(out).toContain('stream\n')
    expect(out).toContain('\nendstream')
  })
})

describe('PdfWriter', () => {
  it('emits a valid PDF skeleton with a catalog and an empty page tree', () => {
    const w = new PdfWriter()
    const pagesRef = w.alloc()
    const catalogRef = w.add(new PdfDict({ Type: new PdfName('Catalog'), Pages: pagesRef }))
    w.assign(
      pagesRef,
      new PdfDict({ Type: new PdfName('Pages'), Kids: new PdfArray([]), Count: new PdfNumber(0) }),
    )
    const bytes = w.serialize(catalogRef)
    const text = decode(bytes)

    // Header + binary marker.
    expect(text.startsWith('%PDF-1.7\n')).toBe(true)
    // Both objects present.
    expect(text).toMatch(/1 0 obj[\s\S]*?\/Catalog/)
    expect(text).toMatch(/2 0 obj[\s\S]*?\/Pages/)
    // xref + trailer + startxref + EOF in order.
    const xrefIdx = text.indexOf('xref\n')
    const trailerIdx = text.indexOf('trailer')
    const startxrefIdx = text.indexOf('startxref')
    const eofIdx = text.lastIndexOf('%%EOF')
    expect(xrefIdx).toBeGreaterThan(0)
    expect(trailerIdx).toBeGreaterThan(xrefIdx)
    expect(startxrefIdx).toBeGreaterThan(trailerIdx)
    expect(eofIdx).toBeGreaterThan(startxrefIdx)
    // /Root points at the catalog.
    expect(text).toMatch(new RegExp(`/Root ${catalogRef.id} 0 R`))
    // /Size is slot count + 1 (including the dead-head free entry).
    expect(text).toMatch(/\/Size 3\b/)
  })

  it('throws when serialize is called with an unassigned ref', () => {
    const w = new PdfWriter()
    const ref = w.alloc()
    expect(() => w.serialize(ref)).toThrow(/never assigned/)
  })

  it('throws on double-assign of the same ref', () => {
    const w = new PdfWriter()
    const ref = w.alloc()
    w.assign(ref, new PdfNumber(1))
    expect(() => w.assign(ref, new PdfNumber(2))).toThrow(/already assigned/)
  })

  it('serializes byte offsets in the xref that actually point at each `N 0 obj` line', () => {
    // The xref's whole job is to let a reader jump straight to an object.
    // Off-by-one here means the doc opens but objects come out garbled.
    const w = new PdfWriter()
    const pagesRef = w.alloc()
    const catalogRef = w.add(new PdfDict({ Type: new PdfName('Catalog'), Pages: pagesRef }))
    w.assign(
      pagesRef,
      new PdfDict({ Type: new PdfName('Pages'), Kids: new PdfArray([]), Count: new PdfNumber(0) }),
    )
    const bytes = w.serialize(catalogRef)
    const text = decode(bytes)

    // Pull the 10-digit offsets out of the xref table.
    const xrefStart = text.indexOf('xref\n')
    const xrefSection = text.slice(xrefStart)
    const offsetMatches = [...xrefSection.matchAll(/^(\d{10}) \d{5} [fn]/gm)]
    // Object 0 (free head, offset 0) + 2 real objects.
    expect(offsetMatches).toHaveLength(3)
    // Object 1 (catalog) — the offset should land right at "1 0 obj".
    const obj1Offset = Number.parseInt(offsetMatches[1]?.[1] ?? '0', 10)
    expect(text.slice(obj1Offset, obj1Offset + 7)).toBe('1 0 obj')
    const obj2Offset = Number.parseInt(offsetMatches[2]?.[1] ?? '0', 10)
    expect(text.slice(obj2Offset, obj2Offset + 7)).toBe('2 0 obj')
  })
})

describe('PdfRef', () => {
  it('serializes as `id gen R`', () => {
    expect(decode(new PdfRef(7, 0).serialize())).toBe('7 0 R')
  })
})
