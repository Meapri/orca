// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalFontFallbackSetting } from './TerminalFontFallbackSetting'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

describe('TerminalFontFallbackSetting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function renderSetting(stack: string | undefined, updateSettings = vi.fn()): void {
    act(() => {
      root.render(
        <TerminalFontFallbackSetting
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component only reads terminalFontFallbackFamily.
          settings={{ terminalFontFallbackFamily: stack } as GlobalSettings}
          updateSettings={updateSettings}
        />
      )
    })
  }

  function getInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input')
    if (!input) {
      throw new Error('fallback input not found')
    }
    return input
  }

  function type(value: string): void {
    const input = getInput()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('does not write settings while the user is still typing', () => {
    const updateSettings = vi.fn()
    renderSetting('', updateSettings)
    type('D2Cod')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('commits a normalized stack on blur', () => {
    const updateSettings = vi.fn()
    renderSetting('', updateSettings)
    type(` "D2Coding" ,, 'Noto Sans CJK KR' `)
    act(() => getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(updateSettings).toHaveBeenCalledWith({
      terminalFontFallbackFamily: 'D2Coding, Noto Sans CJK KR'
    })
  })

  it('commits on Enter', () => {
    const updateSettings = vi.fn()
    renderSetting('', updateSettings)
    type('Sarasa Mono K')
    act(() => {
      getInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ terminalFontFallbackFamily: 'Sarasa Mono K' })
  })

  it('skips the write when the normalized stack is unchanged', () => {
    const updateSettings = vi.fn()
    renderSetting('D2Coding, Noto Sans CJK KR', updateSettings)
    type('D2Coding,Noto Sans CJK KR')
    act(() => getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('follows a stack changed elsewhere', () => {
    renderSetting('D2Coding')
    renderSetting('Malgun Gothic')
    expect(getInput().value).toBe('Malgun Gothic')
  })
})
