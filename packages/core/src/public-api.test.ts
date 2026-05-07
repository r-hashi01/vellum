import { describe, expect, it } from 'vitest'
import * as api from './index'

describe('public API surface', () => {
  it('exports the documented runtime entry points', () => {
    expect(typeof api.domToPdf).toBe('function')
    expect(typeof api.VERSION).toBe('string')
  })

  it('does not leak internal helpers as runtime exports', () => {
    // Anything we add here in the future must be a deliberate API decision.
    // If a new runtime export shows up unintentionally, this test catches it
    // before publish.
    const runtime = Object.keys(api).filter(
      (k) => typeof (api as Record<string, unknown>)[k] !== 'undefined',
    )
    expect(runtime.sort()).toEqual(['VERSION', 'domToPdf'])
  })

  it('VERSION is a non-empty semver-shaped string', () => {
    expect(api.VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
