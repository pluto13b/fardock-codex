import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(here, '../..')

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  cacheDir: path.resolve(workspaceRoot, `.cache/vite/codex-web-${mode}`),
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        jsx: 'react-jsx',
        target: 'ES2022',
        useDefineForClassFields: true,
      },
    },
  },
  build: {
    outDir: path.resolve(workspaceRoot, mode === 'preview' ? '.tmp/codex-web-preview' : '.tmp/codex-web'),
    emptyOutDir: true,
  },
  server: {
    ...(mode === 'preview' ? {} : {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/ws': {
          target: 'ws://127.0.0.1:41744',
          ws: true,
        },
        '/api/local-demo-login': {
          target: 'http://127.0.0.1:41745',
        },
      },
    }),
    fs: {
      strict: true,
      allow: [
        here,
        path.resolve(workspaceRoot, 'packages/codex-serve-client'),
        path.resolve(workspaceRoot, 'packages/e2ee'),
        path.resolve(workspaceRoot, 'packages/protocol'),
        path.resolve(workspaceRoot, 'vendor/deepseek-harness-ui/official/packages/client'),
      ],
      deny: ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '.data/**', '.tmp/**'],
    },
  },
}))
