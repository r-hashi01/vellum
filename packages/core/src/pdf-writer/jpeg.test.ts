import { describe, expect, it } from 'vitest'
import { parseJpegInfo } from './jpeg'

async function makeJpeg(width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('makeJpeg: 2d context unavailable')
  ctx.fillStyle = '#a0c0ff'
  ctx.fillRect(0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return new Uint8Array(await blob.arrayBuffer())
}

describe('parseJpegInfo', () => {
  it('extracts width/height from a 32x16 RGB JPEG', async () => {
    const bytes = await makeJpeg(32, 16)
    const info = parseJpegInfo(bytes)
    expect(info.width).toBe(32)
    expect(info.height).toBe(16)
    expect(info.components).toBe(3)
  })

  it('extracts dims from a 1x1 JPEG (smallest case the canvas will produce)', async () => {
    const bytes = await makeJpeg(1, 1)
    const info = parseJpegInfo(bytes)
    expect(info.width).toBe(1)
    expect(info.height).toBe(1)
  })

  it('throws on non-JPEG bytes', () => {
    expect(() => parseJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/SOI/)
  })

  it('throws when the input is too short to contain a header', () => {
    expect(() => parseJpegInfo(new Uint8Array([0xff]))).toThrow(/SOI/)
  })
})
