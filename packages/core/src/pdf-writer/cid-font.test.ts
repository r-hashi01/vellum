import { describe, expect, it } from 'vitest'
import { CidFontHandle } from './cid-font'
import { PdfDict, PdfName } from './object'
import { PdfWriter } from './writer'

const INTER_LATIN =
  'https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2'

async function fetchInterBytes(): Promise<Uint8Array> {
  const res = await fetch(INTER_LATIN)
  if (!res.ok) throw new Error(`fetch fixture failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const dec = new TextDecoder('latin1')
function decode(b: Uint8Array): string {
  return dec.decode(b)
}

function dump(writer: PdfWriter, fontRef: ReturnType<() => CidFontHandle>['ref']): string {
  const root = writer.add(new PdfDict({ Type: new PdfName('Catalog'), TestFont: fontRef }))
  return decode(writer.serialize(root))
}

describe('CidFontHandle', () => {
  it('finalize() assigns a Type 0 font dict with Identity-H + CID descendant', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    // Encode something so /W is non-trivial; the structural shape doesn't
    // depend on it but exercising the path catches the obvious regressions.
    handle.encode('A')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/Type\s*\/Font/)
    expect(text).toMatch(/\/Subtype\s*\/Type0/)
    expect(text).toMatch(/\/Encoding\s*\/Identity-H/)
    expect(text).toMatch(/\/Subtype\s*\/CIDFontType[02]/)
  })

  it('declares /CIDSystemInfo and /CIDToGIDMap /Identity on the descendant', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('A')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/CIDSystemInfo/)
    expect(text).toMatch(/\/CIDToGIDMap\s*\/Identity/)
  })

  it('embeds the font bytes as a FontFile2 (TTF) or FontFile3 (CFF) stream', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('A')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/FontFile[23]/)
  })

  it('emits a /ToUnicode CMap that maps each used gid back to its Unicode code point', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('A')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/ToUnicode/)
    expect(text).toMatch(/beginbfchar/)
    expect(text).toMatch(/endbfchar/)
    // 'A' is U+0041; the CMap must contain `<gidHex> <0041>`.
    expect(text).toMatch(/<[0-9A-F]{4}>\s*<0041>/)
  })

  it('emits a /W array entry for every glyph encode() produced', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('AB')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/W\s*\[/)
    // Each `gid [advance]` shows up twice for "AB" — A and B are distinct glyphs.
    const pairs = text.match(/\d+\s+\[\d+\]/g) ?? []
    expect(pairs.length).toBeGreaterThanOrEqual(2)
  })
})
