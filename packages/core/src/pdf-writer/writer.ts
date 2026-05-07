import { type PdfObject, PdfRef } from './object'

/**
 * A reference an object will eventually take. Returned by `alloc()` so callers
 * can compose dicts that point at not-yet-finalized objects, then `assign()`
 * the object body once they've built it. This lets us build cycles and
 * forward references the way PDF page trees actually need.
 */
type Slot = {
  id: number
  body: PdfObject | null
}

const enc = new TextEncoder()

function bytes(s: string): Uint8Array {
  return enc.encode(s)
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

/**
 * Builds a PDF byte stream by accumulating indirect objects, then emitting
 * header + bodies + xref + trailer. Object IDs start at 1; object 0 is the
 * conventional dead-head free entry of the xref table.
 */
export class PdfWriter {
  private slots: Slot[] = []

  /** Reserve an object ID without committing a body yet. */
  alloc(): PdfRef {
    const id = this.slots.length + 1
    this.slots.push({ id, body: null })
    return new PdfRef(id, 0)
  }

  /** Reserve and immediately commit a body. Most direct path. */
  add(body: PdfObject): PdfRef {
    const ref = this.alloc()
    this.assign(ref, body)
    return ref
  }

  /** Commit a body to a previously allocated slot. */
  assign(ref: PdfRef, body: PdfObject): void {
    const slot = this.slots[ref.id - 1]
    if (!slot) throw new Error(`PdfWriter.assign: unknown ref ${ref.id}`)
    if (slot.body !== null) throw new Error(`PdfWriter.assign: ref ${ref.id} already assigned`)
    slot.body = body
  }

  /**
   * Emit the final PDF byte stream. `rootRef` is the document catalog (the
   * `/Root` of the trailer). All slots must be assigned by now.
   */
  serialize(rootRef: PdfRef): Uint8Array {
    const parts: Uint8Array[] = []
    // PDF header. The four high bytes (0xE2 0xE3 0xCF 0xD3) are the binary
    // marker comment from the spec (§7.5.2) — file-type sniffers see them and
    // treat the file as binary, so newline normalization in transit doesn't
    // break the byte offsets in the xref. We emit them as raw bytes; encoding
    // them through TextEncoder would expand each 0x80+ byte into 2 UTF-8
    // bytes and silently shift every later offset.
    parts.push(bytes('%PDF-1.7\n'))
    parts.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

    // Track each object's byte offset for the xref.
    const offsets = new Map<number, number>()
    let cursor = totalLen(parts)

    for (const slot of this.slots) {
      if (slot.body === null) {
        throw new Error(`PdfWriter.serialize: ref ${slot.id} was never assigned a body`)
      }
      offsets.set(slot.id, cursor)
      const head = bytes(`${slot.id} 0 obj\n`)
      const body = slot.body.serialize()
      const tail = bytes('\nendobj\n')
      parts.push(head, body, tail)
      cursor += head.length + body.length + tail.length
    }

    const xrefOffset = cursor

    // xref table. Object 0 is the always-present free head.
    let xref = `xref\n0 ${this.slots.length + 1}\n`
    xref += '0000000000 65535 f \n'
    for (let id = 1; id <= this.slots.length; id++) {
      const off = offsets.get(id) ?? 0
      xref += `${off.toString().padStart(10, '0')} 00000 n \n`
    }
    parts.push(bytes(xref))

    // Trailer. `/Size` is one past the highest object id (i.e. slots+1 to
    // include the dead-head free entry).
    const trailer =
      `trailer\n<<\n/Size ${this.slots.length + 1}\n/Root ${rootRef.id} ${rootRef.gen} R\n>>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`
    parts.push(bytes(trailer))

    return concat(parts)
  }
}

function totalLen(parts: readonly Uint8Array[]): number {
  let n = 0
  for (const p of parts) n += p.length
  return n
}
