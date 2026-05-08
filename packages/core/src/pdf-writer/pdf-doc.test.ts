import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { describe, expect, it } from 'vitest'
import { PdfDoc } from './pdf-doc'

// pdfjs-dist 5.x requires its worker. In Vite/vitest browser mode we resolve
// the worker bundle via `?url` and hand the URL to the global config.
GlobalWorkerOptions.workerSrc = workerUrl

async function loadPdf(bytes: Uint8Array) {
  return await getDocument({ data: bytes }).promise
}

describe('PdfDoc', () => {
  it('produces a PDF that pdfjs can parse, with the requested page count', async () => {
    const doc = new PdfDoc()
    doc.addPage(595, 842)
    doc.addPage(595, 842)
    doc.addPage(595, 842)
    const bytes = doc.save()

    const pdf = await loadPdf(bytes)
    try {
      expect(pdf.numPages).toBe(3)
    } finally {
      pdf.destroy()
    }
  })

  it('uses the supplied MediaBox (page size) for each page', async () => {
    const doc = new PdfDoc()
    doc.addPage(400, 300)
    const bytes = doc.save()
    const pdf = await loadPdf(bytes)
    try {
      const page = await pdf.getPage(1)
      // pdfjs's PageViewport at scale 1 has dims = MediaBox size.
      const viewport = page.getViewport({ scale: 1 })
      expect(viewport.width).toBeCloseTo(400, 0)
      expect(viewport.height).toBeCloseTo(300, 0)
    } finally {
      pdf.destroy()
    }
  })

  it('embeds a JPEG image and registers it in the page resources so pdfjs sees the XObject', async () => {
    const canvas = new OffscreenCanvas(40, 30)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.fillStyle = '#3366cc'
    ctx.fillRect(0, 0, 40, 30)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    const jpegBytes = new Uint8Array(await blob.arrayBuffer())

    const doc = new PdfDoc()
    const handle = doc.embedJpeg(jpegBytes)
    expect(handle.width).toBe(40)
    expect(handle.height).toBe(30)
    const page = doc.addPage(400, 300)
    page.drawImage(handle, 0, 0, 400, 300)
    const bytes = doc.save()

    const pdf = await loadPdf(bytes)
    try {
      const pdfPage = await pdf.getPage(1)
      const opList = await pdfPage.getOperatorList()
      // pdfjs surfaces the actual op enums on OPS — the image op is `paintImageXObject`.
      const { OPS } = await import('pdfjs-dist')
      const drewImage = opList.fnArray.includes(OPS.paintImageXObject)
      expect(drewImage).toBe(true)
    } finally {
      pdf.destroy()
    }
  })

  it('embeds a standard font and draws text that pdfjs reads back at the right position', async () => {
    const doc = new PdfDoc()
    const helv = doc.embedStandardFont('Helvetica')
    const page = doc.addPage(400, 200)
    page.drawText('Hello PDF', helv, 50, 100, 24)
    const bytes = doc.save()

    const pdf = await loadPdf(bytes)
    try {
      const pdfPage = await pdf.getPage(1)
      const content = await pdfPage.getTextContent()
      const items = content.items as Array<{ str: string; transform: number[] }>
      const joined = items.map((it) => it.str).join('')
      expect(joined).toContain('Hello PDF')
      // pdfjs's transform = [a b c d e f] — e/f are x,y at the text item's
      // baseline. We placed the text at (50, 100); a small drift is OK.
      const item = items.find((it) => it.str.includes('Hello'))
      expect(item).toBeDefined()
      expect(item?.transform[4]).toBeCloseTo(50, 0)
      expect(item?.transform[5]).toBeCloseTo(100, 0)
    } finally {
      pdf.destroy()
    }
  })

  it('reports characters that fall outside WinAnsi as warnings rather than corrupting the stream', () => {
    const doc = new PdfDoc()
    const helv = doc.embedStandardFont('Helvetica')
    const page = doc.addPage(400, 200)
    page.drawText('A→中B', helv, 0, 100, 12)
    const warnings = doc.collectWarnings()
    expect(warnings.some((w) => /unencodable|cannot encode/i.test(w))).toBe(true)
    expect(warnings.some((w) => w.includes('→'))).toBe(true)
  })

  it('embeds a PNG image (FlateDecode RGB) so pdfjs sees a paintImageXObject', async () => {
    const canvas = new OffscreenCanvas(40, 30)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.fillStyle = '#33aa66'
    ctx.fillRect(0, 0, 40, 30)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const pngBytes = new Uint8Array(await blob.arrayBuffer())

    const doc = new PdfDoc()
    const handle = await doc.embedPng(pngBytes)
    expect(handle.width).toBe(40)
    expect(handle.height).toBe(30)
    const page = doc.addPage(400, 300)
    page.drawImage(handle, 0, 0, 400, 300)
    const bytes = doc.save()

    const pdf = await loadPdf(bytes)
    try {
      const pdfPage = await pdf.getPage(1)
      const opList = await pdfPage.getOperatorList()
      const { OPS } = await import('pdfjs-dist')
      expect(opList.fnArray.includes(OPS.paintImageXObject)).toBe(true)
    } finally {
      pdf.destroy()
    }
  })

  it('embeds an opaque PNG without an SMask, and an RGBA PNG with one', async () => {
    // Opaque PNG
    const opaqueCanvas = new OffscreenCanvas(8, 8)
    const oc = opaqueCanvas.getContext('2d')
    if (!oc) throw new Error('2d context unavailable')
    oc.fillStyle = 'rgba(255,0,0,1)'
    oc.fillRect(0, 0, 8, 8)
    const opaqueBytes = new Uint8Array(
      await (await opaqueCanvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    )

    // RGBA PNG (semi-transparent)
    const alphaCanvas = new OffscreenCanvas(8, 8)
    const ac = alphaCanvas.getContext('2d')
    if (!ac) throw new Error('2d context unavailable')
    ac.fillStyle = 'rgba(0,0,255,0.5)'
    ac.fillRect(0, 0, 8, 8)
    const alphaBytes = new Uint8Array(
      await (await alphaCanvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    )

    const doc = new PdfDoc()
    await doc.embedPng(opaqueBytes)
    await doc.embedPng(alphaBytes)
    doc.addPage(100, 100)
    const bytes = doc.save()
    const text = new TextDecoder('latin1').decode(bytes)
    // Exactly one /SMask reference in the doc — the RGBA image.
    const smaskCount = (text.match(/\/SMask /g) ?? []).length
    expect(smaskCount).toBe(1)
  })

  it('reuses the same Image XObject when drawn twice on the same page', async () => {
    const canvas = new OffscreenCanvas(8, 8)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.fillRect(0, 0, 8, 8)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
    const jpegBytes = new Uint8Array(await blob.arrayBuffer())

    const doc = new PdfDoc()
    const handle = doc.embedJpeg(jpegBytes)
    const page = doc.addPage(100, 100)
    page.drawImage(handle, 0, 0, 50, 50)
    page.drawImage(handle, 50, 50, 50, 50)
    const bytes = doc.save()

    // Decoded as latin-1 the resource name only appears once in the dict —
    // both draw calls share /Im0 rather than allocating /Im0 + /Im1.
    const text = new TextDecoder('latin1').decode(bytes)
    const matches = [...text.matchAll(/\/Im\d+\s+\d+\s+\d+\s+R/g)]
    expect(matches).toHaveLength(1)
  })
})
