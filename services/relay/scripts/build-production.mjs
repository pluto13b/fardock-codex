import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(relayRoot, '..', '..', '.tmp', 'gateway-runtime', 'gateway.cjs')

await mkdir(dirname(output), { recursive: true })
await build({
  entryPoints: [resolve(relayRoot, 'src', 'production-cli.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
})
