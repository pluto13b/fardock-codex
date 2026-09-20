import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createFixtureCodexServeClient } from '@codex-plus/serve-client/preview'
import { App } from '../src/App.tsx'
import { ManagePage } from '../src/ManagePage.tsx'
import { createFrameBatch } from '../src/mobile-motion.ts'
import { MobilePreviewLinkStrip } from './LinkStrip.tsx'
import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/base.css'
import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/design-platform.css'
import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/scrollbar.css'
import '../src/styles.css'
import './motion.css'

const client = createFixtureCodexServeClient({ simulateReplies: true })
const viewport = createFrameBatch(() => {
  document.documentElement.style.setProperty('--cp-mobile-height', `${window.visualViewport?.height ?? window.innerHeight}px`)
})
window.visualViewport?.addEventListener('resize', viewport.request)
window.addEventListener('resize', viewport.request)
viewport.request()
const updateVisibility = () => document.documentElement.toggleAttribute('data-mobile-hidden', document.visibilityState === 'hidden')
document.addEventListener('visibilitychange', updateVisibility)
updateVisibility()
const manage = new URLSearchParams(window.location.search).get('view') === 'manage'
createRoot(document.getElementById('root')!).render(<StrictMode>{manage
  ? <div className="cp-mobile-motion cp-mobile-manage"><ManagePage client={client} preview returnHref="./app.html" /></div>
  : <App client={client} preview mobileMotion fullAccessEnabled renderMobileStatus={(state, running) => <MobilePreviewLinkStrip state={state} running={running} />} />}</StrictMode>)
