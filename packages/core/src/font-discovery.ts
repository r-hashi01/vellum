import type { FontStyle } from './types'
import { type CodePointRange, parseUnicodeRange } from './unicode-range'

/**
 * A normalized `@font-face` declaration. Family is lowercased + dequoted so
 * matching is a plain string compare. `weight` is always a single number;
 * keyword forms (`bold`, `normal`) and ranges are resolved at parse time.
 *
 * `unicodeRange === null` means the rule has no constraint and covers every
 * code point (the CSS default when the descriptor is absent or unparsable).
 * When non-null, the rule is only used for code points it explicitly covers,
 * which is how Google Fonts splits a family across Latin / Latin-Ext /
 * Cyrillic / etc. subsets.
 */
export interface FontFaceRule {
  family: string
  weight: number
  style: FontStyle
  /** First http(s) `url()` in the `src:` chain. Local-only rules are dropped. */
  src: string
  unicodeRange: CodePointRange[] | null
}

/**
 * Walk every same-origin stylesheet in `doc` and return the @font-face rules
 * we can actually act on. Cross-origin sheets throw `SecurityError` on
 * `cssRules` access — we swallow that silently because the caller can't fix
 * it from here, and the standard-font fallback already covers the case.
 */
export function discoverFontFaces(doc: Document): FontFaceRule[] {
  const out: FontFaceRule[] = []
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue
      const parsed = parseFontFaceRule(r)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

function parseFontFaceRule(rule: CSSFontFaceRule): FontFaceRule | null {
  const decl = rule.style
  const family = normalizeFamily(decl.getPropertyValue('font-family'))
  if (!family) return null
  const src = pickFirstHttpUrl(decl.getPropertyValue('src'))
  if (!src) return null
  return {
    family,
    weight: parseWeight(decl.getPropertyValue('font-weight')),
    style: parseStyle(decl.getPropertyValue('font-style')),
    src,
    unicodeRange: parseUnicodeRange(decl.getPropertyValue('unicode-range') ?? ''),
  }
}

function normalizeFamily(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()
}

function parseWeight(raw: string): number {
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'normal') return 400
  if (v === 'bold') return 700
  // Range form like `100 900` — pick the low end so we still register a rule;
  // matching will pick the closest weight per request.
  const first = v.split(/\s+/)[0]
  const n = Number.parseInt(first ?? '', 10)
  return Number.isFinite(n) ? n : 400
}

function parseStyle(raw: string): FontStyle {
  const v = raw.trim().toLowerCase()
  if (v === 'italic' || v === 'oblique') return v
  return 'normal'
}

/**
 * Extract the first http(s) URL from a CSS `src:` value. The browser
 * normalizes relative URLs against the stylesheet's URL by the time we read
 * `getPropertyValue('src')`, so the extracted string is already absolute.
 */
function pickFirstHttpUrl(srcValue: string): string | null {
  // `url(...)` may use ', ", or no quotes.
  const re = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/g
  const match = re.exec(srcValue)
  return match?.[2] ?? null
}

/**
 * Pick the @font-face rule that best satisfies the span's CSS font triple.
 * Family chain is walked left-to-right; matching stops at the first family
 * that has any registered rules. Within that family:
 *
 *   1. exact (weight, style) wins
 *   2. otherwise prefer style match (italic stays italic, regular stays regular)
 *      — readers notice italic-vs-regular more than weight nudges
 *   3. otherwise pick the rule with the smallest |weight - request| distance
 *
 * Returns null if no family in the chain has any registered rule. The caller
 * then falls back to the standard PDF font mapping from font-mapping.ts.
 */
export function matchFontFace(
  rules: FontFaceRule[],
  span: { fontFamily: string; fontWeight: number; fontStyle: FontStyle },
): FontFaceRule | null {
  const families = span.fontFamily.split(',').map((s) =>
    s
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase(),
  )
  for (const fam of families) {
    const candidates = rules.filter((r) => r.family === fam)
    if (candidates.length === 0) continue
    return scoreBest(candidates, span)
  }
  return null
}

/**
 * Like `matchFontFace`, but returns *every* rule that shares the matched
 * `(family, weight, style)` triple — typically because the family is split
 * across multiple unicode-range subsets (Google Fonts: latin, latin-ext,
 * cyrillic, …). Callers fetch each subset and select per-character at draw
 * time. Returns `[]` if no family in the chain has any rules.
 */
export function matchFontFaceRules(
  rules: FontFaceRule[],
  span: { fontFamily: string; fontWeight: number; fontStyle: FontStyle },
): FontFaceRule[] {
  const best = matchFontFace(rules, span)
  if (!best) return []
  return rules.filter(
    (r) => r.family === best.family && r.weight === best.weight && r.style === best.style,
  )
}

function scoreBest(
  candidates: FontFaceRule[],
  span: { fontWeight: number; fontStyle: FontStyle },
): FontFaceRule {
  const sameStyle = candidates.filter((c) => c.style === span.fontStyle)
  const pool = sameStyle.length > 0 ? sameStyle : candidates
  let best = pool[0]
  if (!best) {
    // Unreachable: caller guarantees candidates.length > 0, and pool is a
    // superset of candidates. Kept as a non-null assertion site for
    // noUncheckedIndexedAccess.
    throw new Error('scoreBest: empty pool')
  }
  let bestDistance = Math.abs(best.weight - span.fontWeight)
  for (const c of pool) {
    const d = Math.abs(c.weight - span.fontWeight)
    if (d < bestDistance) {
      best = c
      bestDistance = d
    }
  }
  return best
}

const ALLOWED_HOSTS = new Set(['fonts.gstatic.com', 'fonts.googleapis.com'])

/**
 * Phase 2 v1 only embeds fonts served from Google Fonts hostnames. Everything
 * else falls back to the standard PDF font mapping with a warning. The
 * allowlist will become an option (`allowedFontHosts: string[]`) once the
 * Google-only path is proven stable.
 */
export function isAllowedFontUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return ALLOWED_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}
