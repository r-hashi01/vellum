import { domToPdf, type TimingEvent } from '../packages/core/src/index'

const button = document.getElementById('generate') as HTMLButtonElement
const status = document.getElementById('status') as HTMLSpanElement
const log = document.getElementById('log') as HTMLPreElement

button.addEventListener('click', async () => {
  button.disabled = true
  status.textContent = 'Working…'
  log.textContent = ''
  const events: TimingEvent[] = []

  try {
    const slides = document.querySelectorAll<HTMLElement>('[data-slide]')
    const result = await domToPdf({
      pages: slides,
      source: { width: 800, height: 600 },
      output: { width: 800, height: 600, unit: 'pt' },
      onTiming: (e) => {
        events.push(e)
        appendTiming(e)
      },
      onProgress: (i, total) => {
        status.textContent = `Page ${i} / ${total}`
      },
    })

    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'vellum-poc.pdf'
    a.click()
    URL.revokeObjectURL(url)

    const total = events.reduce((s, e) => s + e.durationMs, 0)
    status.textContent = `Done — ${result.blob.size.toLocaleString()} bytes, ${total.toFixed(0)} ms total`

    if (result.warnings.length > 0) {
      log.textContent += `\n--- ${result.warnings.length} warning(s) ---\n`
      for (const w of result.warnings) log.textContent += `${w}\n\n`
    } else {
      log.textContent += `\n(no warnings)\n`
    }
  } catch (err) {
    status.textContent = `Error: ${(err as Error).message}`
    console.error(err)
  } finally {
    button.disabled = false
  }
})

function appendTiming(e: TimingEvent): void {
  const line =
    e.stage === 'emit' || e.stage === 'fonts'
      ? `${e.stage.padEnd(10)}        ${e.durationMs.toFixed(1)} ms`
      : `${e.stage.padEnd(10)} page ${e.page}   ${e.durationMs.toFixed(1)} ms`
  log.textContent = `${log.textContent ?? ''}${line}\n`
}
