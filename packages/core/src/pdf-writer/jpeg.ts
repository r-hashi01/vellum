/**
 * Minimal JPEG header parser. We only need three things:
 *   - image width / height (for the PDF Image XObject's `/Width` `/Height`)
 *   - number of components (1 → DeviceGray, 3 → DeviceRGB, 4 → DeviceCMYK)
 *
 * We pass the JPEG bytes through as the XObject's stream payload (DCTDecode),
 * so we don't need to actually decode the pixels — just sniff the SOFn marker.
 */

export interface JpegInfo {
  width: number
  height: number
  components: 1 | 3 | 4
}

const SOI = 0xd8
const EOI = 0xd9

/**
 * SOFn markers carry frame dimensions. SOF0=baseline, SOF1=extended sequential,
 * SOF2=progressive, etc. We exclude DHT (0xC4), JPG reserved (0xC8), and DAC
 * (0xCC) — those share the 0xC0-0xCF range but aren't frame headers.
 */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
}

/**
 * Standalone markers (no segment payload after the marker byte). RSTn (0xD0–
 * 0xD7), SOI (0xD8), EOI (0xD9), TEM (0x01).
 */
function isStandaloneMarker(m: number): boolean {
  return (m >= 0xd0 && m <= 0xd9) || m === 0x01
}

export function parseJpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    throw new Error('parseJpegInfo: input is not a JPEG (missing SOI)')
  }
  let i = 2
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      throw new Error(`parseJpegInfo: expected 0xFF at byte ${i}, got 0x${bytes[i]?.toString(16)}`)
    }
    // Skip 0xFF fill bytes (some encoders pad markers).
    let m = bytes[i + 1] ?? 0
    while (m === 0xff && i + 1 < bytes.length) {
      i++
      m = bytes[i + 1] ?? 0
    }
    if (m === EOI) break
    if (isStandaloneMarker(m)) {
      i += 2
      continue
    }
    if (isSofMarker(m)) {
      // Segment layout (skipping the 2-byte FF/marker prefix):
      //   2B segment length | 1B precision | 2B height | 2B width | 1B components
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0)
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0)
      const components = bytes[i + 9] ?? 0
      if (components !== 1 && components !== 3 && components !== 4) {
        throw new Error(`parseJpegInfo: unsupported component count ${components}`)
      }
      return { width, height, components }
    }
    // Other segments (APPn, DQT, DHT, COM, …) carry a 2B length field
    // immediately after the marker; the length includes its own 2 bytes.
    const segLen = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
    if (segLen < 2) throw new Error(`parseJpegInfo: invalid segment length ${segLen} at ${i}`)
    i += 2 + segLen
  }
  throw new Error('parseJpegInfo: reached end without finding an SOFn marker')
}
