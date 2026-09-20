import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const workspaceRoot = path.resolve(import.meta.dirname, '..')
const outputRoot = path.resolve(workspaceRoot, process.argv[2] ?? '.tmp/codex-web')
const mode = process.argv[3] ?? 'production'

if (mode !== 'production' && mode !== 'preview') {
  throw new Error(`DSH UI boundary: mode must be "production" or "preview", received "${mode}"`)
}

function normalized(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(root, candidate) {
  const relative = path.relative(normalized(root), normalized(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

if (!isWithin(workspaceRoot, outputRoot)) {
  throw new Error(`DSH UI boundary: refusing to inspect output outside the workspace: ${outputRoot}`)
}

const webRoot = path.resolve(workspaceRoot, 'apps/codex-web')
const webSourceRoot = path.resolve(webRoot, 'src')
const serveClientRoot = path.resolve(workspaceRoot, 'packages/codex-serve-client')
const serveClientSourceRoot = path.resolve(serveClientRoot, 'src')
const lockfile = path.resolve(workspaceRoot, 'pnpm-lock.yaml')

const manifests = [
  {
    importer: 'apps/codex-web',
    path: path.resolve(webRoot, 'package.json'),
    allowedProductionDependencies: new Set([
      '@codex-plus/e2ee',
      '@codex-plus/protocol',
      '@codex-plus/serve-client',
      'react',
      'react-dom',
    ]),
  },
  {
    importer: 'packages/codex-serve-client',
    path: path.resolve(serveClientRoot, 'package.json'),
    allowedProductionDependencies: new Set(),
  },
]

const noticeCopies = [
  ['vendor/deepseek-harness-ui/official/LICENSE', 'third-party/deepseek-harness-MIT.txt'],
  ['vendor/deepseek-harness-ui/anywhere-labs/LICENSE', 'third-party/anywhere-labs-desktop-MIT.txt'],
  ['vendor/deepseek-harness-ui/anywhere-labs/THIRD_PARTY_NOTICES.md', 'third-party/anywhere-labs-THIRD_PARTY_NOTICES.md'],
  ['vendor/deepseek-harness-ui/UPSTREAM.md', 'third-party/UI-UPSTREAM.md'],
]

const allowedVendorImports = new Set([
  'vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/base.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/design-platform.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-theme/src/styles/scrollbar.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-layout/src/client/AppFrame.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-sidebar/src/client/SidebarRoot.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-workspace/src/client/rows/Rows.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/skeleton/ApprovalPanel.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/MessageItem.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/ReasoningRow.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/GenericCommandCard.module.css',
  'vendor/deepseek-harness-ui/official/packages/client/ui-model-selection/src/client/ModelSelect.module.css',
].map(relative => normalized(path.resolve(workspaceRoot, relative))))

const allowedBareImports = new Set([
  '@codex-plus/e2ee',
  '@codex-plus/protocol',
  '@codex-plus/serve-client',
  'react',
  'react-dom',
])

const forbiddenRuntimePatterns = [
  { label: '@deepseek-ai package', pattern: /@deepseek-ai\//i },
  {
    label: 'DSH executable/runtime package',
    pattern: /\bdsh-(?:agent|app(?:-boot)?|anonymous-user-id|bash|client-(?:connection|runtime)|community-market|credentials|filesystem|fs|host|llm|market(?:place)?|plugin|pwsh|sandbox|session(?:-telemetry(?:-otel)?)?|subprocess|web(?:server)?)\b/i,
  },
  { label: 'DSH marketplace', pattern: /\bdshmarket\b/i },
  { label: 'DSH Desktop update service', pattern: /\bdshdesktop\.cn\b/i },
  { label: 'DeepSeek model endpoint', pattern: /\bapi\.deepseek\.com\b/i },
  { label: 'DeepSeek credential variable', pattern: /\bDEEPSEEK_(?:API_KEY|BASE_URL)\b/ },
  { label: 'DSH runtime environment', pattern: /\bDSH_(?:CONFIG|HOME|PROFILE|TELEMETRY(?:_DISABLED)?)\b/ },
  { label: 'OTel exporter configuration', pattern: /\bOTEL_EXPORTER_OTLP(?:_[A-Z_]+)?\b/ },
  { label: 'DSH renderer bridge', pattern: /__DSH_[A-Z0-9_]+__/ },
  { label: 'DSH layered environment loader', pattern: /\bloadLayeredEnv\b/ },
  { label: 'Cordis boot entry', pattern: /\bbootCordis\b/ },
]

const productionFixturePatterns = [
  { label: 'fixture import or identifier', pattern: /\bfixture(?:Snapshots|Tasks|Workspaces)\b/i },
  { label: 'fixture module', pattern: /(?:from|import\s*\()\s*['"][^'"]*fixture(?:\.[^'"]*)?['"]/i },
  { label: 'fixture marker', pattern: /\bfixture\b/i },
  { label: 'offline demo fixture', pattern: /\boffline-demo\b/i },
]

const productionDemoPatterns = [
  { label: 'local Demo login route', pattern: /\/api\/local-demo-login/i },
  { label: 'local Demo username', pattern: /["']admin["']/ },
  { label: 'local Demo password', pattern: /["']123456["']/ },
  { label: 'local Relay or Vite port', pattern: /\b(?:41744|41745|5173)\b/ },
]

function relativeToWorkspace(file) {
  return path.relative(workspaceRoot, file).replaceAll(path.sep, '/')
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function collectFiles(root, predicate) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`DSH UI boundary: symbolic links are not allowed in scanned trees: ${relativeToWorkspace(absolute)}`)
    }
    if (entry.isDirectory()) files.push(...collectFiles(absolute, predicate))
    else if (predicate(entry.name, absolute)) files.push(absolute)
  }
  return files
}

function productionDependencies(manifest) {
  const names = new Set()
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name)
  }
  for (const name of manifest.bundledDependencies ?? manifest.bundleDependencies ?? []) names.add(name)
  return names
}

function assertAllowedDependencies(manifestEntry) {
  const manifest = JSON.parse(fs.readFileSync(manifestEntry.path, 'utf8'))
  const actual = productionDependencies(manifest)
  for (const dependency of actual) {
    if (!manifestEntry.allowedProductionDependencies.has(dependency)) {
      throw new Error(`DSH UI boundary: production dependency "${dependency}" is not allowlisted in ${relativeToWorkspace(manifestEntry.path)}`)
    }
  }
  return actual
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function lockImporterDependencies(lockText, importerName) {
  const dependencies = new Set()
  let found = false
  let inside = false
  let section = null

  for (const line of lockText.split(/\r?\n/)) {
    const importer = line.match(/^  (\S.*):\s*(?:\{\})?\s*$/)
    if (importer) {
      inside = unquoteYamlScalar(importer[1]) === importerName
      found ||= inside
      section = null
      continue
    }
    if (!inside) continue

    const nextSection = line.match(/^    ([A-Za-z][A-Za-z0-9]*):\s*$/)
    if (nextSection) {
      section = ['dependencies', 'optionalDependencies', 'peerDependencies'].includes(nextSection[1])
        ? nextSection[1]
        : null
      continue
    }

    if (section) {
      const dependency = line.match(/^      (.+):\s*$/)
      if (dependency) dependencies.add(unquoteYamlScalar(dependency[1]))
    }
  }

  if (!found) throw new Error(`DSH UI boundary: pnpm lockfile is missing importer ${importerName}`)
  return dependencies
}

function assertSameSet(expected, actual, label) {
  const missing = [...expected].filter(value => !actual.has(value))
  const unexpected = [...actual].filter(value => !expected.has(value))
  if (missing.length || unexpected.length) {
    throw new Error(
      `DSH UI boundary: ${label} drifted; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    )
  }
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function importSpecifiers(text) {
  const matches = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) matches.push({ specifier: match[1], index: match.index })
  }
  return matches
}

function assertSourceImports(file, text) {
  for (const { specifier, index } of importSpecifiers(text)) {
    const location = `${relativeToWorkspace(file)}:${lineNumberAt(text, index)}`
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      const dependency = packageName(specifier)
      if (!allowedBareImports.has(dependency)) {
        throw new Error(`DSH UI boundary: source import "${specifier}" is not allowlisted at ${location}`)
      }
      continue
    }

    const withoutQuery = specifier.split(/[?#]/, 1)[0]
    const target = path.resolve(path.dirname(file), withoutQuery)
    if (isWithin(webSourceRoot, target) || isWithin(serveClientSourceRoot, target)) continue
    if (allowedVendorImports.has(normalized(target))) continue
    throw new Error(`DSH UI boundary: relative import escapes approved source roots at ${location}: ${specifier}`)
  }
}

function assertNoPatterns(file, text, patterns) {
  for (const { label, pattern } of patterns) {
    const match = pattern.exec(text)
    if (match) {
      throw new Error(
        `DSH UI boundary: forbidden ${label} in ${relativeToWorkspace(file)}:${lineNumberAt(text, match.index)}`,
      )
    }
  }
}

for (const vendorFile of allowedVendorImports) {
  if (!fs.existsSync(vendorFile)) {
    throw new Error(`DSH UI boundary: allowlisted vendor file is missing: ${relativeToWorkspace(vendorFile)}`)
  }
  const css = fs.readFileSync(vendorFile, 'utf8')
  if (/^\s*@import\b/im.test(css)) {
    throw new Error(`DSH UI boundary: allowlisted vendor CSS may not import another stylesheet: ${relativeToWorkspace(vendorFile)}`)
  }
  const remoteUrl = /url\(\s*['"]?(?!data:|#)(https?:|\/\/)/i.exec(css)
  if (remoteUrl) {
    throw new Error(`DSH UI boundary: remote URL in allowlisted vendor CSS: ${relativeToWorkspace(vendorFile)}`)
  }
}

const lockText = fs.readFileSync(lockfile, 'utf8')
for (const manifestEntry of manifests) {
  const manifestDependencies = assertAllowedDependencies(manifestEntry)
  const importerDependencies = lockImporterDependencies(lockText, manifestEntry.importer)
  assertSameSet(manifestDependencies, importerDependencies, `pnpm importer ${manifestEntry.importer}`)
}

const sourceFiles = [
  ...collectFiles(webSourceRoot, name => /\.(?:css|mjs|js|jsx|ts|tsx)$/i.test(name)),
  ...collectFiles(serveClientSourceRoot, name => /\.(?:mjs|js|jsx|ts|tsx)$/i.test(name)),
]

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8')
  assertSourceImports(file, source)
  assertNoPatterns(file, source, forbiddenRuntimePatterns)
  if (mode === 'production' && isWithin(webSourceRoot, file)) {
    assertNoPatterns(file, source, productionFixturePatterns)
  }
}

if (!fs.existsSync(outputRoot) || !fs.statSync(outputRoot).isDirectory()) {
  throw new Error(`DSH UI boundary: build output does not exist: ${outputRoot}`)
}

for (const [sourceRelative, distributedRelative] of noticeCopies) {
  const source = path.resolve(workspaceRoot, sourceRelative)
  const distributed = path.resolve(outputRoot, distributedRelative)
  if (!fs.existsSync(source)) {
    throw new Error(`DSH UI boundary: missing required attribution ${sourceRelative}`)
  }
  if (!fs.existsSync(distributed)) {
    throw new Error(`DSH UI boundary: build omitted third-party notice ${distributedRelative}`)
  }
  if (!fs.readFileSync(source).equals(fs.readFileSync(distributed))) {
    throw new Error(`DSH UI boundary: distributed notice differs from its reviewed source: ${distributedRelative}`)
  }
}

const outputFiles = collectFiles(
  outputRoot,
  (name, absolute) => !isWithin(path.resolve(outputRoot, 'third-party'), absolute)
    && /\.(?:css|html|js|json|map|mjs|svg|webmanifest)$/i.test(name),
)

for (const file of outputFiles) {
  const built = fs.readFileSync(file, 'utf8')
  assertNoPatterns(file, built, forbiddenRuntimePatterns)
  if (mode === 'production') {
    assertNoPatterns(file, built, productionFixturePatterns)
    assertNoPatterns(file, built, productionDemoPatterns)
  }
}

const htmlPath = path.join(outputRoot, 'index.html')
if (!fs.existsSync(htmlPath)) throw new Error('DSH UI boundary: build output omitted index.html')
const html = fs.readFileSync(htmlPath, 'utf8')
if (!html.includes('<title>Codex Plus</title>')) {
  throw new Error('DSH UI boundary: product title is missing or was replaced')
}

console.log(
  `DSH UI boundary verified (${mode}): ${sourceFiles.length} source files, ${outputFiles.length} build files, allowlisted imports and dependencies only.`,
)
