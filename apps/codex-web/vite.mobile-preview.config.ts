import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '../..')
export default defineConfig({
  root: path.join(here, 'mobile-preview'),
  publicDir: path.join(here, 'public'),
  envDir: false,
  plugins: [react()],
  cacheDir: path.join(workspace, '.cache/vite/mobile-ui-preview'),
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: path.join(workspace, '.tmp/mobile-ui-preview'),
    emptyOutDir: true,
    rollupOptions: { input: { index: path.join(here, 'mobile-preview/index.html'), app: path.join(here, 'mobile-preview/app.html') } },
  },
  server: {
    host: '127.0.0.1', port: 5182, strictPort: true,
    fs: {
      strict: true,
      allow: [here, path.join(workspace, 'packages/codex-serve-client'), path.join(workspace, 'vendor/deepseek-harness-ui/official/packages/client')],
      deny: ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '.data/**', '.tmp/**'],
    },
  },
})
