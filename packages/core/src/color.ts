import type { RGB } from './types.js'

const RGB_RE =
  /rgba?\(\s*(-?\d+\.?\d*)\s*[, ]\s*(-?\d+\.?\d*)\s*[, ]\s*(-?\d+\.?\d*)\s*(?:[,/]\s*(-?\d+\.?\d*%?)\s*)?\)/

/**
 * Parse a CSS computed `color` value. Modern browsers return `rgb(r, g, b)` or
 * `rgba(r, g, b, a)` (or the space-separated `rgb(r g b / a)` form). We do not
 * support named colors here because computed style always normalizes them.
 */
export function parseColor(cssColor: string): RGB {
  const m = RGB_RE.exec(cssColor)
  if (!m) return { r: 0, g: 0, b: 0, a: 1 }
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  let a = 1
  if (m[4] !== undefined) {
    a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
  }
  return { r, g, b, a }
}
