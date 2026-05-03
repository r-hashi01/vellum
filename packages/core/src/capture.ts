import { toJpeg, toPng } from 'html-to-image'

/**
 * The transparency trick: while a single style element is in the document,
 * every element inside `.__vellum-capture` reports `color: transparent` and
 * has its text-shadow / -webkit-text-stroke neutralized. html-to-image inlines
 * computed styles when it serializes the DOM, so the rasterized JPEG/PNG ends
 * up with everything *except* the text glyphs (backgrounds, images, SVG, decorations).
 */
const CAPTURE_CLASS = '__vellum-capture'
const STYLE_ID = '__vellum-capture-style'

const TRANSPARENT_TEXT_CSS = `
.${CAPTURE_CLASS}, .${CAPTURE_CLASS} *,
.${CAPTURE_CLASS}::before, .${CAPTURE_CLASS}::after,
.${CAPTURE_CLASS} *::before, .${CAPTURE_CLASS} *::after {
  color: transparent !important;
  -webkit-text-stroke-color: transparent !important;
  text-shadow: none !important;
}
`

export interface CaptureOptions {
  format: 'jpeg' | 'png'
  quality: number
  width: number
  height: number
}

export async function captureRaster(page: HTMLElement, opts: CaptureOptions): Promise<Uint8Array> {
  const styleEl = ensureStyle()
  page.classList.add(CAPTURE_CLASS)
  try {
    await document.fonts.ready
    await nextFrame()
    await nextFrame()

    const dataUrl =
      opts.format === 'jpeg'
        ? await toJpeg(page, { quality: opts.quality, width: opts.width, height: opts.height })
        : await toPng(page, { width: opts.width, height: opts.height })

    const buf = await (await fetch(dataUrl)).arrayBuffer()
    return new Uint8Array(buf)
  } finally {
    page.classList.remove(CAPTURE_CLASS)
    // Leave the <style> in the document for subsequent pages; we remove it
    // only when no element still carries the class.
    if (!document.querySelector(`.${CAPTURE_CLASS}`)) {
      styleEl.remove()
    }
  }
}

function ensureStyle(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID)
  if (existing instanceof HTMLStyleElement) return existing
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = TRANSPARENT_TEXT_CSS
  document.head.appendChild(el)
  return el
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}
