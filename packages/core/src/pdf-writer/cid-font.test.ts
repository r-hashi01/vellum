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

  it('declares /CIDSystemInfo and a /CIDToGIDMap on the descendant', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('A')
    handle.finalize()
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/CIDSystemInfo/)
    // /CIDToGIDMap must be either /Identity (no subsetting) or an indirect
    // stream ref (subsetting renumbered the gids).
    expect(text).toMatch(/\/CIDToGIDMap\s+(\/Identity|\d+\s+\d+\s+R)/)
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

  it('subsets the font so the saved doc never contains the original woff2 magic', async () => {
    const bytes = await fetchInterBytes()
    // Sanity: input really is woff2.
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 4))).toBe('wOF2')
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('Hi')
    handle.finalize()
    const out = dump(writer, handle.ref)
    // Subsetting unwraps to clean TTF/CFF bytes — the woff2 brotli magic must
    // not be present in the embedded FontFile stream.
    expect(out).not.toContain('wOF2')
  })

  it('handles every Inter subset Google Fonts currently ships without throwing (subset OR fallback)', async () => {
    // Tracking issue: fontkit@2.0.4 cannot re-encode every Google Fonts
    // Inter v20 subset (some throw "Offset is outside the bounds of the
    // DataView" in both sparse and full-glyph paths). We don't gate the
    // suite on fontkit shipping a fix — instead we lock the *contract*
    // that finalize() never throws, regardless of which fallback tier it
    // ends up on (sparse → full → original-bytes-verbatim).
    const css = await fetch(
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
      { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' } },
    ).then((r) => r.text())
    const urls = [
      ...new Set(
        [...css.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2/g)].map((m) => m[0]),
      ),
    ]
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
      const writer = new PdfWriter()
      const handle = new CidFontHandle(writer, bytes)
      // No-op; just must not throw.
      handle.encode('Hello world Cześć Привет')
      expect(() => handle.finalize()).not.toThrow()
    }
  })

  it('uses a CIDToGIDMap stream (not /Identity) once a subset remaps gids', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = new CidFontHandle(writer, bytes)
    handle.encode('AB')
    handle.finalize()
    const text = dump(writer, handle.ref)
    // Either /Identity OR an indirect stream ref; for a subsetted font the
    // gids in the stream are renumbered, so the map must be a stream.
    expect(text).toMatch(/\/CIDToGIDMap\s+\d+\s+\d+\s+R/)
  })
})
