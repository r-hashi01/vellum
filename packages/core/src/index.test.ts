import { describe, expect, it } from 'vitest'
import { VERSION } from './index.js'

describe('@vellum/core', () => {
  it('exposes a VERSION string', () => {
    expect(typeof VERSION).toBe('string')
  })

  it('runs in a browser environment with DOM access', () => {
    const div = document.createElement('div')
    div.textContent = 'hello'
    expect(div.textContent).toBe('hello')
  })
})
