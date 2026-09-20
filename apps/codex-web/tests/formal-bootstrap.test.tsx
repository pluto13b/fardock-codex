import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FormalBootstrap } from '../src/FormalBootstrap.tsx'

it('does not ask for a new pairing code before saved device recovery finishes', () => {
  const markup = renderToStaticMarkup(createElement(FormalBootstrap, { invitationFragment: '' }))
  expect(markup).toContain('正在恢复此浏览器保存的设备连接')
  expect(markup).not.toContain('name="pairing-code"')
  expect(markup).not.toContain('清除旧授权')
})
