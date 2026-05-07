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
})
