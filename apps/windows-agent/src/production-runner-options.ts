import { win32 as windowsPath } from 'node:path'

export interface ProductionRunnerOptions {
  readonly origin: string
  readonly webSocketUrl: string
  readonly codexExecutable: string
  readonly workspaceRoot: string
  readonly stateDirectory: string
  readonly temporaryDirectory: string
  readonly identityFile: string
  readonly actionDatabase: string
  readonly actionAnchor: string
  readonly attachmentDirectory: string
  readonly pairingQrFile: string
  readonly bootstrapExportFile: string
}

export class ProductionRunnerOptionsError extends Error {
  constructor() {
    super('production-runner:invalid-arguments')
    this.name = 'ProductionRunnerOptionsError'
  }
}

function fail(): never {
  throw new ProductionRunnerOptionsError()
}

function localWindowsPath(value: string, extension?: string): string {
  if (
    !windowsPath.isAbsolute(value)
    || value.startsWith('\\\\')
    || value.startsWith('\\\\?\\')
    || value.startsWith('\\\\.\\')
    || value.includes('\0')
  ) fail()
  const normalized = windowsPath.normalize(value)
  const root = windowsPath.parse(normalized).root
  if (!/^[A-Za-z]:\\$/u.test(root)) fail()
  if (extension !== undefined && windowsPath.extname(normalized).toLowerCase() !== extension) fail()
  return normalized.length === root.length ? normalized : normalized.replace(/\\+$/u, '')
}

function exactOrigin(value: string): URL {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.origin !== value
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) fail()
    return url
  } catch (error) {
    if (error instanceof ProductionRunnerOptionsError) throw error
    return fail()
  }
}

export function parseProductionRunnerOptions(
  argv: readonly string[],
  projectRoot: string,
): ProductionRunnerOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (
      (name !== '--origin' && name !== '--codex-executable' && name !== '--workspace')
      || value === undefined
      || value.length === 0
      || values.has(name)
    ) fail()
    values.set(name, value)
  }
  const originValue = values.get('--origin')
  const executableValue = values.get('--codex-executable')
  const workspaceValue = values.get('--workspace')
  if (originValue === undefined || executableValue === undefined || workspaceValue === undefined) fail()

  const origin = exactOrigin(originValue)
  const normalizedProjectRoot = localWindowsPath(projectRoot)
  const requestedWorkspace = localWindowsPath(workspaceValue)
  if (requestedWorkspace.toLowerCase() !== normalizedProjectRoot.toLowerCase()) fail()
  const workspaceRoot = normalizedProjectRoot
  const codexExecutable = localWindowsPath(executableValue, '.exe')
  const stateDirectory = windowsPath.join(normalizedProjectRoot, '.data', 'windows-companion')
  const temporaryDirectory = windowsPath.join(normalizedProjectRoot, '.tmp', 'windows-companion')

  return Object.freeze({
    origin: origin.origin,
    webSocketUrl: `wss://${origin.host}/api/ws`,
    codexExecutable,
    workspaceRoot,
    stateDirectory,
    temporaryDirectory,
    identityFile: windowsPath.join(stateDirectory, 'identity.dpapi'),
    actionDatabase: windowsPath.join(stateDirectory, 'action.sqlite'),
    actionAnchor: windowsPath.join(stateDirectory, 'action.sqlite.anchor.dpapi'),
    attachmentDirectory: windowsPath.join(stateDirectory, 'attachments'),
    pairingQrFile: windowsPath.join(temporaryDirectory, 'pairing.png'),
    bootstrapExportFile: windowsPath.join(temporaryDirectory, 'relay-bootstrap'),
  })
}
