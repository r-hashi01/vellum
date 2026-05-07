import { describe, expect, it, vi } from 'vitest'
import type { FontFaceRule } from './font-discovery'
import { resolveWebFonts } from './font-resolver'
import { domPx, type FontStyle, type TextSpan } from './types'

function span(
  fontFamily: string,
  fontWeight = 400,
  fontStyle: FontStyle = 'normal',
  text = 'x',
): TextSpan {
  return {
    text,
    x: domPx(0),
    y: domPx(0),
    w: domPx(0),
    h: domPx(0),
    fontFamily,
    fontSize: domPx(16),
    fontWeight,
    fontStyle,
    color: { r: 0, g: 0, b: 0, a: 1 },
    letterSpacing: domPx(0),
  }
}

const interBytes = new Uint8Array([0x00, 0x01, 0x00, 0x00]) // arbitrary stub payload
const interBoldBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

function makeFetch(map: Record<string, Uint8Array>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const bytes = map[url]
    if (!bytes) {
      return new Response(null, { status: 404 })
    }
    return new Response(bytes.slice().buffer, { status: 200 })
  })
}

describe('resolveWebFonts', () => {
  const interRule: FontFaceRule = {
    family: 'inter',
    weight: 400,
    style: 'normal',
    src: 'https://fonts.gstatic.com/s/inter/inter-regular.woff2',
  }
  const interBoldRule: FontFaceRule = {
    family: 'inter',
    weight: 700,
    style: 'normal',
    src: 'https://fonts.gstatic.com/s/inter/inter-bold.woff2',
  }

  it('fetches one set of bytes per unique (family, weight, style) used by spans', async () => {
    const fetchFn = makeFetch({
      [interRule.src]: interBytes,
      [interBoldRule.src]: interBoldBytes,
    })
    const candidates = await resolveWebFonts({
      pageSpans: [
        [span('Inter, sans-serif', 400)],
        [span('Inter, sans-serif', 400, 'normal', 'more text')], // dup → same fetch
        [span('Inter, sans-serif', 700)],
      ],
      rules: [interRule, interBoldRule],
      fetch: fetchFn,
    })
    expect(candidates).toHaveLength(2)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const families = candidates.map((c) => `${c.family}-${c.weight}`).sort()
    expect(families).toEqual(['inter-400', 'inter-700'])
  })

  it('skips spans with no @font-face match (silently — the standard-font fallback handles them)', async () => {
    const fetchFn = makeFetch({})
    const candidates = await resolveWebFonts({
      pageSpans: [[span('Arial, sans-serif')]], // no rule for arial
      rules: [interRule],
      fetch: fetchFn,
    })
    expect(candidates).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('skips rules whose src is not on the Google Fonts allowlist and emits a warning', async () => {
    const evilRule: FontFaceRule = {
      family: 'evil',
      weight: 400,
      style: 'normal',
      src: 'https://attacker.example/font.woff2',
    }
    const fetchFn = makeFetch({})
    const result = await resolveWebFonts({
      pageSpans: [[span('Evil, sans-serif')]],
      rules: [evilRule],
      fetch: fetchFn,
      onWarning: vi.fn(),
    })
    expect(result).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('treats a fetch failure as a soft fallback (no throw, warning emitted, std font used downstream)', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 503 }))
    const onWarning = vi.fn()
    const result = await resolveWebFonts({
      pageSpans: [[span('Inter, sans-serif')]],
      rules: [interRule],
      fetch: fetchFn,
      onWarning,
    })
    expect(result).toEqual([])
    expect(onWarning).toHaveBeenCalledOnce()
    expect(onWarning.mock.calls[0]?.[0]).toMatch(/inter/i)
  })
})
