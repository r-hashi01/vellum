import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseColor } from './color'
import { domToPdf } from './dom-to-pdf'
import type { TimingEvent } from './types'
import { extractSpans } from './walk'

async function embeddedFontNames(blob: Blob): Promise<Set<string>> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const doc = await PDFDocument.load(bytes)
  const names = new Set<string>()
  for (const page of doc.getPages()) {
    const resources = page.node.Resources()
    const fontDict = resources?.lookup(PDFName.of('Font'), PDFDict)
    if (!fontDict) continue
    for (const key of fontDict.keys()) {
      const font = fontDict.lookup(key, PDFDict)
      const baseFont = font.lookup(PDFName.of('BaseFont'))
      if (baseFont instanceof PDFName) names.add(baseFont.asString().replace(/^\//, ''))
    }
  }
  return names
}

const trackedNodes: HTMLElement[] = []
function makePage(html: string, width = 800, height = 600): HTMLElement {
  const page = document.createElement('div')
  page.style.cssText = [
    `width: ${width}px`,
    `height: ${height}px`,
    'position: relative',
    'background: #f5f5f0',
    'font-family: Arial, sans-serif',
    'box-sizing: border-box',
  ].join(';')
  page.innerHTML = html
  document.body.appendChild(page)
  trackedNodes.push(page)
  return page
}
afterEach(() => {
  for (const n of trackedNodes.splice(0)) n.remove()
})

describe('parseColor', () => {
  it('parses rgb()', () => {
    expect(parseColor('rgb(255, 0, 128)')).toEqual({ r: 1, g: 0, b: 128 / 255, a: 1 })
  })
  it('parses rgba() comma form', () => {
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
  })
  it('parses rgb() space form with /alpha', () => {
    expect(parseColor('rgb(10 20 30 / 0.25)')).toEqual({
      r: 10 / 255,
      g: 20 / 255,
      b: 30 / 255,
      a: 0.25,
    })
  })
  it('falls back to opaque black for unparsable input', () => {
    expect(parseColor('color(display-p3 1 0 0)')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })
})

describe('extractSpans', () => {
  it('extracts a single span from a single line of text', () => {
    const page = makePage(
      '<h1 style="font-size: 32px; color: rgb(34, 34, 34); margin: 20px;">Hello</h1>',
    )
    const spans = extractSpans(page)
    expect(spans).toHaveLength(1)
    const [span] = spans
    expect(span?.text).toBe('Hello')
    expect(span?.fontSize).toBeCloseTo(32, 0)
    // Coordinates are relative to the page top-left, so they must be small
    // positive numbers (the h1's margin pushes it ~20px in).
    expect(span?.x).toBeGreaterThanOrEqual(0)
    expect(span?.x).toBeLessThan(100)
    expect(span?.y).toBeGreaterThanOrEqual(0)
    expect(span?.y).toBeLessThan(100)
    expect(span?.color).toEqual({ r: 34 / 255, g: 34 / 255, b: 34 / 255, a: 1 })
  })

  it('skips hidden text', () => {
    const page = makePage(
      '<p style="visibility: hidden">hidden</p><p style="display: none">gone</p><p>visible</p>',
    )
    const spans = extractSpans(page)
    expect(spans.map((s) => s.text)).toEqual(['visible'])
  })

  it('strips source-HTML indentation so the span text matches the rendered line', () => {
    // The browser collapses leading whitespace in this paragraph; if we hand
    // the raw .data slice to drawText, the rendered PDF text shifts right by
    // the width of the indent. We assert the normalized result here so that
    // regression is impossible.
    const page = makePage(
      [
        '<p style="margin: 0; padding: 0; font-size: 16px; color: black;">',
        '            Hello world.',
        '        </p>',
      ].join('\n'),
    )
    const spans = extractSpans(page)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.text).toBe('Hello world.')
  })

  it('splits a wrapped paragraph into one span per visual line', () => {
    // Force wrapping with a narrow container.
    const page = makePage(
      '<p style="font-size: 16px; width: 80px; line-height: 1.2; margin: 0; color: black;">' +
        'one two three four five six seven eight nine</p>',
    )
    const spans = extractSpans(page)
    expect(spans.length).toBeGreaterThan(1)
    // Each span is already CSS-normalized (no leading/trailing whitespace),
    // so the original text reconstructs by joining with a single space.
    const joined = spans.map((s) => s.text).join(' ')
    expect(joined).toBe('one two three four five six seven eight nine')
    // No span should leak leading/trailing whitespace.
    for (const s of spans) {
      expect(s.text).toBe(s.text.trim())
    }
    // Each subsequent line must have a strictly greater y than the previous.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.y).toBeGreaterThan(spans[i - 1]?.y ?? -Infinity)
    }
  })
})

describe('domToPdf (PoC)', () => {
  it('produces a valid PDF blob from a single simple page', async () => {
    const page = makePage(
      '<h1 style="font-size: 32px; color: rgb(34, 34, 34); margin: 24px;">Title</h1>' +
        '<p style="font-size: 16px; color: rgb(85, 85, 85); margin: 24px;">Body text.</p>',
    )

    const result = await domToPdf({
      pages: [page],
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
    })

    expect(result.blob.type).toBe('application/pdf')
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(1000)
    // %PDF- magic
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-')
  })

  it('emits timing events for capture / walk / emit on each of 3 pages', async () => {
    const pages: HTMLElement[] = []
    for (let i = 0; i < 3; i++) {
      pages.push(
        makePage(
          `<h1 style="font-size: 28px; margin: 24px;">Page ${i + 1}</h1>` +
            '<p style="font-size: 16px; margin: 24px;">Lorem ipsum.</p>',
        ),
      )
    }

    const events: TimingEvent[] = []
    const result = await domToPdf({
      pages,
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
      onTiming: (e) => events.push(e),
    })

    expect(result.blob.type).toBe('application/pdf')

    // 3 walks, 3 captures, 1 emit
    const stages = events.map((e) => e.stage)
    expect(stages.filter((s) => s === 'walk')).toHaveLength(3)
    expect(stages.filter((s) => s === 'capture')).toHaveLength(3)
    expect(stages.filter((s) => s === 'emit')).toHaveLength(1)

    // Every event has a non-negative duration
    for (const e of events) {
      expect(e.durationMs).toBeGreaterThanOrEqual(0)
    }

    // Pages are 1-indexed for stages that have a page field
    const walkPages = events.filter((e) => e.stage === 'walk').map((e) => e.page)
    expect(walkPages.sort()).toEqual([1, 2, 3])
  })

  it('does not throw on characters Helvetica cannot encode, and reports them in warnings', async () => {
    const page = makePage(
      '<p style="font-size: 18px; margin: 24px;">capture → walk → emit (☃ 日本語)</p>',
    )
    const result = await domToPdf({
      pages: [page],
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
    })
    expect(result.blob.type).toBe('application/pdf')
    expect(result.warnings.length).toBeGreaterThan(0)
    const w = result.warnings.join(' ')
    expect(w).toMatch(/cannot encode/i)
    expect(w).toContain('→')
  })

  it('embeds the standard font matching each span (serif → Times, mono → Courier, bold → Bold variant)', async () => {
    // The user reads the raster, but we still want the *vector* layer that
    // search/copy/select uses to roughly match the visible style — bold text
    // copies as bold text, code as monospace, etc. We assert that by looking
    // for the BaseFont names directly in the PDF byte stream.
    const page = makePage(
      [
        '<p style="font-family: Arial, sans-serif; font-size: 16px; margin: 24px;">sans</p>',
        '<p style="font-family: Georgia, serif; font-size: 16px; margin: 24px;">serif</p>',
        '<p style="font-family: Menlo, monospace; font-size: 16px; margin: 24px;">mono</p>',
        '<p style="font-family: Arial, sans-serif; font-weight: 700; font-size: 16px; margin: 24px;">bold</p>',
      ].join(''),
    )
    const result = await domToPdf({
      pages: [page],
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
    })
    const fonts = await embeddedFontNames(result.blob)
    expect(fonts).toContain('Helvetica')
    expect(fonts).toContain('Helvetica-Bold')
    expect(fonts).toContain('Times-Roman')
    expect(fonts).toContain('Courier')
  })

  it('does not embed standard fonts that are not used (Times absent for an all-sans-serif deck)', async () => {
    const page = makePage(
      '<p style="font-family: Arial, sans-serif; font-size: 16px; margin: 24px;">just sans</p>',
    )
    const result = await domToPdf({
      pages: [page],
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
    })
    const fonts = await embeddedFontNames(result.blob)
    expect(fonts).toContain('Helvetica')
    expect(fonts).not.toContain('Times-Roman')
    expect(fonts).not.toContain('Courier')
  })

  it('attempts to fetch @font-face fonts on the Google Fonts allowlist', async () => {
    // Inject a real-looking @font-face so discoverFontFaces picks it up.
    const style = document.createElement('style')
    style.textContent = `
      @font-face {
        font-family: 'TestFont';
        src: url('https://fonts.gstatic.com/s/testfont/v1/test.woff2') format('woff2');
      }
    `
    document.head.appendChild(style)
    // Intercept only the font URL — capture.ts also calls fetch() on data: URLs
    // (its raster pipeline), and we must not break that. Pass-through otherwise.
    const realFetch = globalThis.fetch.bind(globalThis)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('fonts.gstatic.com')) {
          // Fake non-font bytes — pdf-lib's embedFont will reject them. The
          // pipeline must surface a warning rather than throw, and the span
          // must still flow through using the standard font fallback.
          return new Response(new Uint8Array([1, 2, 3, 4]).slice().buffer, { status: 200 })
        }
        return realFetch(input, init)
      })
    try {
      const page = makePage(
        '<p style="font-family: TestFont, sans-serif; font-size: 16px; margin: 24px;">hello</p>',
      )
      const result = await domToPdf({
        pages: [page],
        source: { width: 800, height: 600 },
        output: { width: 400, height: 300, unit: 'pt' },
      })
      expect(fetchSpy).toHaveBeenCalledWith('https://fonts.gstatic.com/s/testfont/v1/test.woff2')
      expect(result.blob.type).toBe('application/pdf')
      // Bad bytes → warning, fallback to Helvetica
      const warn = result.warnings.join(' ')
      expect(warn.toLowerCase()).toContain('testfont')
      const fonts = await embeddedFontNames(result.blob)
      expect(fonts).toContain('Helvetica')
    } finally {
      fetchSpy.mockRestore()
      style.remove()
    }
  })

  it('does not fetch fonts whose @font-face src is not on the Google Fonts allowlist', async () => {
    const style = document.createElement('style')
    style.textContent = `
      @font-face {
        font-family: 'EvilFont';
        src: url('https://attacker.example/evil.woff2');
      }
    `
    document.head.appendChild(style)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const page = makePage(
        '<p style="font-family: EvilFont, sans-serif; font-size: 16px; margin: 24px;">hello</p>',
      )
      const result = await domToPdf({
        pages: [page],
        source: { width: 800, height: 600 },
        output: { width: 400, height: 300, unit: 'pt' },
      })
      expect(fetchSpy).not.toHaveBeenCalledWith('https://attacker.example/evil.woff2')
      expect(result.warnings.join(' ').toLowerCase()).toContain('allowlist')
    } finally {
      fetchSpy.mockRestore()
      style.remove()
    }
  })

  it('calls onProgress', async () => {
    const page = makePage('<p>Hi</p>')
    const onProgress = vi.fn()
    await domToPdf({
      pages: [page],
      source: { width: 800, height: 600 },
      output: { width: 400, height: 300, unit: 'pt' },
      onProgress,
    })
    // At minimum: (0, 1) before processing, (1, 1) after
    expect(onProgress).toHaveBeenCalledWith(0, 1)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })
})
