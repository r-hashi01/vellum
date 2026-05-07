import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverFontFaces,
  type FontFaceRule,
  isAllowedFontUrl,
  matchFontFace,
  matchFontFaceRules,
} from './font-discovery'
import type { FontStyle } from './types'

const trackedSheets: HTMLStyleElement[] = []
function injectStyle(css: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  trackedSheets.push(style)
  return style
}
afterEach(() => {
  for (const s of trackedSheets.splice(0)) s.remove()
})

function rule(family: string, weight: number, style: FontStyle, src: string): FontFaceRule {
  return { family, weight, style, src, unicodeRange: null }
}

describe('discoverFontFaces', () => {
  it('parses a single @font-face block', () => {
    injectStyle(`
      @font-face {
        font-family: 'Inter';
        font-weight: 400;
        font-style: normal;
        src: url('https://fonts.gstatic.com/s/inter/v1/Inter-Regular.woff2') format('woff2');
      }
    `)
    const rules = discoverFontFaces(document)
    const inter = rules.filter((r) => r.family === 'inter')
    expect(inter).toHaveLength(1)
    expect(inter[0]).toMatchObject({
      family: 'inter',
      weight: 400,
      style: 'normal',
    })
    expect(inter[0]?.src).toContain('fonts.gstatic.com')
  })

  it('normalizes family names (case + quotes)', () => {
    injectStyle(`
      @font-face {
        font-family: "Source Sans Pro";
        src: url('https://fonts.gstatic.com/x.woff2');
      }
    `)
    const rules = discoverFontFaces(document)
    const found = rules.find((r) => r.family === 'source sans pro')
    expect(found).toBeDefined()
  })

  it('resolves font-weight keywords (bold → 700, normal → 400)', () => {
    injectStyle(`
      @font-face {
        font-family: 'A';
        font-weight: bold;
        src: url('https://fonts.gstatic.com/a.woff2');
      }
      @font-face {
        font-family: 'A';
        src: url('https://fonts.gstatic.com/a-reg.woff2');
      }
    `)
    const rules = discoverFontFaces(document).filter((r) => r.family === 'a')
    const weights = rules.map((r) => r.weight).sort()
    expect(weights).toEqual([400, 700])
  })

  it('picks the first http(s) url() from a multi-src declaration', () => {
    injectStyle(`
      @font-face {
        font-family: 'B';
        src: local('B'),
             url('https://fonts.gstatic.com/b.woff2') format('woff2'),
             url('https://fonts.gstatic.com/b.woff') format('woff');
      }
    `)
    const rules = discoverFontFaces(document).filter((r) => r.family === 'b')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.src).toBe('https://fonts.gstatic.com/b.woff2')
  })

  it('skips @font-face rules with no http(s) src (only local()) so they are not embedded', () => {
    injectStyle(`
      @font-face {
        font-family: 'OnlyLocal';
        src: local('OnlyLocal');
      }
    `)
    const rules = discoverFontFaces(document).filter((r) => r.family === 'onlylocal')
    expect(rules).toHaveLength(0)
  })
})

describe('matchFontFace', () => {
  const rules: FontFaceRule[] = [
    rule('inter', 400, 'normal', 'https://fonts.gstatic.com/inter-r.woff2'),
    rule('inter', 700, 'normal', 'https://fonts.gstatic.com/inter-b.woff2'),
    rule('inter', 400, 'italic', 'https://fonts.gstatic.com/inter-i.woff2'),
    rule('source sans pro', 400, 'normal', 'https://fonts.gstatic.com/ssp.woff2'),
  ]

  it('matches family + weight + style exactly when available', () => {
    const m = matchFontFace(rules, {
      fontFamily: 'Inter, sans-serif',
      fontWeight: 700,
      fontStyle: 'normal',
    })
    expect(m?.src).toContain('inter-b.woff2')
  })

  it('falls back to nearest weight within the same family/style', () => {
    // 600 has no exact match; closest is 700 (distance 100) over 400 (distance 200).
    const m = matchFontFace(rules, {
      fontFamily: 'Inter',
      fontWeight: 600,
      fontStyle: 'normal',
    })
    expect(m?.weight).toBe(700)
  })

  it('walks the family chain left-to-right and stops at the first family that has any rules', () => {
    const m = matchFontFace(rules, {
      fontFamily: '"Missing Font", "Source Sans Pro", sans-serif',
      fontWeight: 400,
      fontStyle: 'normal',
    })
    expect(m?.family).toBe('source sans pro')
  })

  it('returns null when no family in the chain has any @font-face', () => {
    const m = matchFontFace(rules, {
      fontFamily: 'Arial, sans-serif',
      fontWeight: 400,
      fontStyle: 'normal',
    })
    expect(m).toBeNull()
  })

  it('relaxes style match if the requested style is missing for that family', () => {
    // Inter only has italic at 400; an italic 700 request should fall back to
    // 700 normal rather than 400 italic — same-style is a softer constraint
    // than weight here. (Pick: same family, prefer style match if present at
    // any weight, else closest weight.)
    const m = matchFontFace(rules, {
      fontFamily: 'Inter',
      fontWeight: 700,
      fontStyle: 'italic',
    })
    // Both candidates exist:
    //  - inter 400 italic (style match, weight off by 300)
    //  - inter 700 normal (weight match, style off)
    // We rank style-match higher to keep visual feel (italic stays italic).
    expect(m?.style).toBe('italic')
    expect(m?.weight).toBe(400)
  })
})

describe('matchFontFaceRules', () => {
  it('returns every rule sharing the matched family/weight/style triple, regardless of unicode-range', () => {
    // Google Fonts pattern: the same Inter 400 normal split into latin /
    // latin-ext / cyrillic subsets. We must keep all three so per-character
    // selection at draw time can pick the right subset.
    const latin: FontFaceRule = {
      family: 'inter',
      weight: 400,
      style: 'normal',
      src: 'https://fonts.gstatic.com/inter-latin.woff2',
      unicodeRange: [{ start: 0, end: 0x024f }],
    }
    const latinExt: FontFaceRule = {
      family: 'inter',
      weight: 400,
      style: 'normal',
      src: 'https://fonts.gstatic.com/inter-latin-ext.woff2',
      unicodeRange: [{ start: 0x0100, end: 0x024f }],
    }
    const cyr: FontFaceRule = {
      family: 'inter',
      weight: 400,
      style: 'normal',
      src: 'https://fonts.gstatic.com/inter-cyrillic.woff2',
      unicodeRange: [{ start: 0x0400, end: 0x04ff }],
    }
    const otherWeight: FontFaceRule = {
      family: 'inter',
      weight: 700,
      style: 'normal',
      src: 'https://fonts.gstatic.com/inter-700-latin.woff2',
      unicodeRange: [{ start: 0, end: 0x024f }],
    }
    const matched = matchFontFaceRules([latin, latinExt, cyr, otherWeight], {
      fontFamily: 'Inter',
      fontWeight: 400,
      fontStyle: 'normal',
    })
    expect(matched).toEqual([latin, latinExt, cyr])
  })

  it('returns [] when no family in the chain has rules', () => {
    expect(
      matchFontFaceRules([], {
        fontFamily: 'Arial',
        fontWeight: 400,
        fontStyle: 'normal',
      }),
    ).toEqual([])
  })
})

describe('isAllowedFontUrl', () => {
  it('allows fonts.gstatic.com', () => {
    expect(isAllowedFontUrl('https://fonts.gstatic.com/s/inter/v1/foo.woff2')).toBe(true)
  })
  it('allows fonts.googleapis.com', () => {
    expect(isAllowedFontUrl('https://fonts.googleapis.com/css2?family=Inter')).toBe(true)
  })
  it('rejects arbitrary hosts', () => {
    expect(isAllowedFontUrl('https://example.com/font.woff2')).toBe(false)
    expect(isAllowedFontUrl('https://fonts.evil.com/font.woff2')).toBe(false)
  })
  it('rejects http (downgrade)', () => {
    expect(isAllowedFontUrl('http://fonts.gstatic.com/font.woff2')).toBe(false)
  })
  it('returns false for malformed URLs without throwing', () => {
    expect(isAllowedFontUrl('not a url')).toBe(false)
  })
})
