import { describe, expect, it } from 'vitest'
import { embedCidFontStub } from './cid-font'
import { PdfDict, PdfName } from './object'
import { PdfWriter } from './writer'

/**
 * Tests fetch a real woff2 from fonts.gstatic.com. The structural assertions
 * we make here (Type0 / Identity-H / CIDFontType2|0 / FontFile2|3) are
 * format-level, not face-specific, so any well-formed font would do; using
 * the Inter latin subset matches what the rest of the suite already pulls.
 */
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

/** Serialize the writer with `handle.ref` referenced from a tiny stand-in
 * catalog so the tree is rooted and `serialize()` is happy. */
function dump(writer: PdfWriter, fontRef: ReturnType<typeof embedCidFontStub>['ref']): string {
  const root = writer.add(new PdfDict({ Type: new PdfName('Catalog'), TestFont: fontRef }))
  return decode(writer.serialize(root))
}

describe('embedCidFontStub', () => {
  it('emits a Type 0 font dict with Identity-H encoding and a CID-keyed descendant', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = embedCidFontStub(writer, bytes)
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/Type\s*\/Font/)
    expect(text).toMatch(/\/Subtype\s*\/Type0/)
    expect(text).toMatch(/\/Encoding\s*\/Identity-H/)
    expect(text).toMatch(/\/Subtype\s*\/CIDFontType[02]/)
  })

  it('declares /CIDSystemInfo and /CIDToGIDMap /Identity on the descendant font', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = embedCidFontStub(writer, bytes)
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/CIDSystemInfo/)
    expect(text).toMatch(/\/CIDToGIDMap\s*\/Identity/)
  })

  it('embeds the font bytes as a FontFile2 (TTF) or FontFile3 (CFF) stream', async () => {
    const bytes = await fetchInterBytes()
    const writer = new PdfWriter()
    const handle = embedCidFontStub(writer, bytes)
    const text = dump(writer, handle.ref)
    expect(text).toMatch(/\/FontFile[23]/)
  })
})
