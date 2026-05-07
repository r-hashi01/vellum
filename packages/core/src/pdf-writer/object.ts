/**
 * Minimal PDF object model + serializer. Every value that can appear inside a
 * dict / array implements `serialize(): Uint8Array` (which returns the value's
 * direct bytes — `<<...>>`, `/Name`, `(string)`, etc.). Indirect objects are
 * the writer's job (writer.ts), not ours.
 *
 * Why classes rather than tagged unions / plain objects: the writer needs to
 * tell `PdfDict` from `PdfStream` *before* it serializes (streams can only be
 * indirect objects in PDF), and `instanceof` is the cleanest way without
 * sprinkling discriminators everywhere.
 */

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

export interface PdfObject {
  serialize(): Uint8Array
}

export class PdfNumber implements PdfObject {
  constructor(public readonly n: number) {}
  serialize(): Uint8Array {
    // PDF allows integer / real; clamp tiny FP noise so we don't emit
    // 1e-17 silliness.
    const r = Math.round(this.n * 1e6) / 1e6
    return bytes(Number.isInteger(r) ? `${r}` : `${r}`)
  }
}

export class PdfBool implements PdfObject {
  constructor(public readonly b: boolean) {}
  serialize(): Uint8Array {
    return bytes(this.b ? 'true' : 'false')
  }
}

export class PdfNull implements PdfObject {
  serialize(): Uint8Array {
    return bytes('null')
  }
}

export class PdfName implements PdfObject {
  /** The name without the leading slash. ASCII only, special chars escaped. */
  constructor(public readonly name: string) {}
  serialize(): Uint8Array {
    let out = '/'
    for (const ch of this.name) {
      const code = ch.charCodeAt(0)
      // Per PDF spec, names use #xx for chars outside printable ASCII or
      // any of the special delimiters / whitespace.
      if (
        code < 0x21 ||
        code > 0x7e ||
        ch === '#' ||
        ch === '/' ||
        ch === '(' ||
        ch === ')' ||
        ch === '<' ||
        ch === '>' ||
        ch === '[' ||
        ch === ']' ||
        ch === '{' ||
        ch === '}' ||
        ch === '%'
      ) {
        out += `#${code.toString(16).padStart(2, '0')}`
      } else {
        out += ch
      }
    }
    return bytes(out)
  }
}

/** `(literal string)` form. Escapes `\`, `(`, `)` as required. */
export class PdfString implements PdfObject {
  constructor(public readonly value: string) {}
  serialize(): Uint8Array {
    let out = '('
    for (const ch of this.value) {
      if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`
      else out += ch
    }
    out += ')'
    return bytes(out)
  }
}

/** `<48656C6C6F>` form. Used when the bytes don't fit cleanly in literals. */
export class PdfHexString implements PdfObject {
  constructor(public readonly bytes: Uint8Array) {}
  serialize(): Uint8Array {
    let out = '<'
    for (const b of this.bytes) out += b.toString(16).padStart(2, '0').toUpperCase()
    out += '>'
    return bytes(out)
  }
}

export class PdfArray implements PdfObject {
  constructor(public readonly items: readonly PdfObject[]) {}
  serialize(): Uint8Array {
    const parts: Uint8Array[] = [bytes('[')]
    for (let i = 0; i < this.items.length; i++) {
      if (i > 0) parts.push(bytes(' '))
      const it = this.items[i]
      if (it) parts.push(it.serialize())
    }
    parts.push(bytes(']'))
    return concat(parts)
  }
}

export class PdfDict implements PdfObject {
  constructor(public readonly entries: Readonly<Record<string, PdfObject>>) {}
  serialize(): Uint8Array {
    const parts: Uint8Array[] = [bytes('<<')]
    for (const [key, val] of Object.entries(this.entries)) {
      parts.push(bytes('\n'))
      parts.push(new PdfName(key).serialize())
      parts.push(bytes(' '))
      parts.push(val.serialize())
    }
    parts.push(bytes('\n>>'))
    return concat(parts)
  }
}

/** Indirect-object reference: `N G R`. */
export class PdfRef implements PdfObject {
  constructor(
    public readonly id: number,
    public readonly gen: number = 0,
  ) {}
  serialize(): Uint8Array {
    return bytes(`${this.id} ${this.gen} R`)
  }
}

/**
 * A stream object. Streams are *always* indirect — their dict (which holds at
 * least `/Length`) is written before the `stream\n...\nendstream` body.
 */
export class PdfStream implements PdfObject {
  constructor(
    public readonly dictEntries: Readonly<Record<string, PdfObject>>,
    public readonly data: Uint8Array,
  ) {}
  /**
   * Serializes `<<dict>>\nstream\n<data>\nendstream`. Length is injected here
   * (callers should NOT pre-set `/Length` in dictEntries; we do it).
   */
  serialize(): Uint8Array {
    const merged: Record<string, PdfObject> = {
      ...this.dictEntries,
      Length: new PdfNumber(this.data.length),
    }
    const dict = new PdfDict(merged).serialize()
    return concat([dict, bytes('\nstream\n'), this.data, bytes('\nendstream')])
  }
}
