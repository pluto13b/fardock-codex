import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/base.css'
import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/design-platform.css'
import '../../../vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/scrollbar.css'
import './styles.css'

document.body.dataset.dsDarkTheme = ''

const root = document.getElementById('root')
if (!root) throw new Error('Codex Plus Web: missing #root')
const appRoot = root

const previewEnabled = import.meta.env.MODE === 'preview' || import.meta.env.VITE_CODEX_PLUS_PREVIEW === '1'

async function render() {
  if (previewEnabled) {
    const [{ App }, { ManagePage }, { createFixtureCodexServeClient }] = await Promise.all([
      import('./App.tsx'),
      import('./ManagePage.tsx'),
      import('@codex-plus/serve-client/preview'),
    ])
    const client = createFixtureCodexServeClient()
    createRoot(appRoot).render(
      <StrictMode>
        {window.location.pathname === '/manage'
          ? <ManagePage client={client} preview canCreatePairing />
          : <App client={client} preview />}
      </StrictMode>,
    )
    return
  }

  const invitationFragment = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : ''
  if (invitationFragment !== '') {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )
  }
  if (import.meta.env.DEV && invitationFragment === '') {
    const { LocalDemoBootstrap } = await import('./LocalDemoBootstrap.tsx')
    createRoot(appRoot).render(<LocalDemoBootstrap />)
    return
  }
  const { OwnerBootstrap } = await import('./OwnerBootstrap.tsx')
  createRoot(appRoot).render(
    <OwnerBootstrap invitationFragment={invitationFragment} />,
  )
}

void render()
