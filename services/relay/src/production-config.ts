import { lstat, readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { Secret32Schema } from '@codex-plus/protocol'
import { parseOwnerPasswordVerifier, type OwnerPasswordVerifier } from './owner-auth.ts'

export type ProductionGatewayBind = '127.0.0.1' | '0.0.0.0'
export type ProductionGatewayLogLevel = 'info' | 'warn' | 'error'

export interface ProductionGatewayConfig {
  mode: 'production'
  bind: ProductionGatewayBind
  port: number
  publicOrigin: string
  trustedProxyIps: readonly string[]
  stateFile: string
  webRoot: string
  bootstrapCredential?: string
  bootstrapCredentialFile?: string
  ownerVerifier: OwnerPasswordVerifier
  ownerVerifierFile: string
  logLevel: ProductionGatewayLogLevel
}

export interface ProductionGatewayEnvironment {
  CODEX_PLUS_MODE?: string
  CODEX_PLUS_BIND?: string
  CODEX_PLUS_PORT?: string
  CODEX_PLUS_PUBLIC_ORIGIN?: string
  CODEX_PLUS_TRUSTED_PROXY_IPS?: string
  CODEX_PLUS_STATE_FILE?: string
  CODEX_PLUS_WEB_ROOT?: string
  CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE?: string
  CODEX_PLUS_OWNER_VERIFIER_FILE?: string
  CODEX_PLUS_LOG_LEVEL?: string
}

export type ProductionGatewayConfigErrorCode =
  | 'invalid-mode'
  | 'invalid-bind'
  | 'invalid-port'
  | 'invalid-public-origin'
  | 'invalid-trusted-proxy-ips'
  | 'invalid-state-file'
  | 'invalid-web-root'
  | 'invalid-bootstrap-file'
  | 'invalid-owner-verifier-file'
  | 'invalid-log-level'

export class ProductionGatewayConfigError extends Error {
  constructor(readonly code: ProductionGatewayConfigErrorCode) {
    super(code)
    this.name = 'ProductionGatewayConfigError'
  }
}

function fail(code: ProductionGatewayConfigErrorCode): never {
  throw new ProductionGatewayConfigError(code)
}

function exactHttpsOrigin(value: string | undefined): string {
  if (value === undefined) fail('invalid-public-origin')
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
    ) fail('invalid-public-origin')
    return value
  } catch (error) {
    if (error instanceof ProductionGatewayConfigError) throw error
    return fail('invalid-public-origin')
  }
}

function absolutePath(value: string | undefined, code: 'invalid-state-file' | 'invalid-web-root'): string {
  if (value === undefined || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    fail(code)
  }
  return value
}

export function normalizeIpLiteral(value: string): string | undefined {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)?.[1]
  if (mapped !== undefined && isIP(mapped) === 4) return mapped
  const version = isIP(value)
  if (version === 4) return value
  if (version !== 6) return undefined
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    return hostname.slice(1, -1).toLowerCase()
  } catch {
    return undefined
  }
}

function trustedProxyIps(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0 || value.includes(' ')) {
    fail('invalid-trusted-proxy-ips')
  }
  const values = value.split(',')
  if (values.length < 1 || values.length > 8) fail('invalid-trusted-proxy-ips')
  const normalized = values.map(normalizeIpLiteral)
  if (normalized.some(candidate => candidate === undefined)) fail('invalid-trusted-proxy-ips')
  const ips = normalized as string[]
  if (new Set(ips).size !== ips.length) fail('invalid-trusted-proxy-ips')
  return Object.freeze(ips)
}

function normalized(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function within(root: string, candidate: string): boolean {
  const path = relative(normalized(root), normalized(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function resolveExistingOrParent(
  target: string,
  code: 'invalid-state-file' | 'invalid-bootstrap-file',
): Promise<string> {
  let cursor = target
  while (true) {
    try {
      const resolvedCursor = await realpath(cursor)
      const suffix = relative(cursor, target)
      return suffix === '' ? resolvedCursor : resolve(resolvedCursor, suffix)
    } catch (error) {
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR') fail(code)
      const parent = dirname(cursor)
      if (parent === cursor) fail(code)
      cursor = parent
    }
  }
}

export async function assertProductionGatewayPathSeparation(input: Readonly<{
  webRoot: string
  stateFile: string
  bootstrapCredentialFile?: string
  ownerVerifierFile?: string
}>): Promise<void> {
  if (within(input.webRoot, input.stateFile)) fail('invalid-state-file')
  if (
    input.bootstrapCredentialFile !== undefined
    && within(input.webRoot, input.bootstrapCredentialFile)
  ) fail('invalid-bootstrap-file')
  if (input.ownerVerifierFile !== undefined && within(input.webRoot, input.ownerVerifierFile)) {
    fail('invalid-owner-verifier-file')
  }

  let resolvedWebRoot: string
  try {
    const metadata = await lstat(input.webRoot)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('invalid-web-root')
    resolvedWebRoot = await realpath(input.webRoot)
    if (normalized(resolvedWebRoot) !== normalized(input.webRoot)) fail('invalid-web-root')
  } catch (error) {
    if (error instanceof ProductionGatewayConfigError) throw error
    return fail('invalid-web-root')
  }

  const resolvedStateFile = await resolveExistingOrParent(input.stateFile, 'invalid-state-file')
  if (within(resolvedWebRoot, resolvedStateFile)) fail('invalid-state-file')
  if (input.bootstrapCredentialFile !== undefined) {
    try {
      const metadata = await lstat(input.bootstrapCredentialFile)
      if (metadata.isSymbolicLink() || !metadata.isFile()) fail('invalid-bootstrap-file')
    } catch (error) {
      if (error instanceof ProductionGatewayConfigError) throw error
      return fail('invalid-bootstrap-file')
    }
    const resolvedBootstrapFile = await resolveExistingOrParent(
      input.bootstrapCredentialFile,
      'invalid-bootstrap-file',
    )
    if (within(resolvedWebRoot, resolvedBootstrapFile)) fail('invalid-bootstrap-file')
  }
  if (input.ownerVerifierFile !== undefined) {
    try {
      const metadata = await lstat(input.ownerVerifierFile)
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.size < 1
        || metadata.size > 2_048
      ) fail('invalid-owner-verifier-file')
    } catch (error) {
      if (error instanceof ProductionGatewayConfigError) throw error
      return fail('invalid-owner-verifier-file')
    }
    const resolvedOwnerVerifier = await resolveExistingOrParent(
      input.ownerVerifierFile,
      'invalid-bootstrap-file',
    ).catch(() => fail('invalid-owner-verifier-file'))
    if (within(resolvedWebRoot, resolvedOwnerVerifier)) fail('invalid-owner-verifier-file')
  }
}

async function readBootstrapCredential(file: string): Promise<string> {
  if (file.length === 0 || file.includes('\0') || !isAbsolute(file)) {
    fail('invalid-bootstrap-file')
  }
  try {
    const metadata = await lstat(file)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > 128) {
      fail('invalid-bootstrap-file')
    }
    const credential = await readFile(file, 'utf8')
    if (!Secret32Schema.safeParse(credential).success) fail('invalid-bootstrap-file')
    return credential
  } catch (error) {
    if (error instanceof ProductionGatewayConfigError) throw error
    return fail('invalid-bootstrap-file')
  }
}

async function readOwnerVerifier(file: string | undefined): Promise<OwnerPasswordVerifier> {
  if (file === undefined || file.length === 0 || file.includes('\0') || !isAbsolute(file)) {
    fail('invalid-owner-verifier-file')
  }
  try {
    const metadata = await lstat(file)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > 2_048) {
      fail('invalid-owner-verifier-file')
    }
    return parseOwnerPasswordVerifier(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error instanceof ProductionGatewayConfigError) throw error
    return fail('invalid-owner-verifier-file')
  }
}

export async function loadProductionGatewayConfig(
  environment: ProductionGatewayEnvironment,
): Promise<ProductionGatewayConfig> {
  if (environment.CODEX_PLUS_MODE !== 'production') fail('invalid-mode')

  const bind = environment.CODEX_PLUS_BIND
  if (bind !== '127.0.0.1' && bind !== '0.0.0.0') fail('invalid-bind')

  const rawPort = environment.CODEX_PLUS_PORT
  if (rawPort === undefined || !/^[1-9][0-9]{0,4}$/.test(rawPort)) fail('invalid-port')
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail('invalid-port')

  const logLevel = environment.CODEX_PLUS_LOG_LEVEL
  if (logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
    fail('invalid-log-level')
  }

  const bootstrapFile = environment.CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE
  const bootstrapCredential = bootstrapFile === undefined
    ? undefined
    : await readBootstrapCredential(bootstrapFile)
  const ownerVerifierFile = environment.CODEX_PLUS_OWNER_VERIFIER_FILE
  if (ownerVerifierFile === undefined) fail('invalid-owner-verifier-file')
  const ownerVerifier = await readOwnerVerifier(ownerVerifierFile)
  const publicOrigin = exactHttpsOrigin(environment.CODEX_PLUS_PUBLIC_ORIGIN)
  const proxyIps = trustedProxyIps(environment.CODEX_PLUS_TRUSTED_PROXY_IPS)
  const stateFile = absolutePath(environment.CODEX_PLUS_STATE_FILE, 'invalid-state-file')
  const webRoot = absolutePath(environment.CODEX_PLUS_WEB_ROOT, 'invalid-web-root')
  await assertProductionGatewayPathSeparation({
    webRoot,
    stateFile,
    ...(bootstrapFile === undefined ? {} : { bootstrapCredentialFile: bootstrapFile }),
    ownerVerifierFile,
  })

  return Object.freeze({
    mode: 'production',
    bind,
    port,
    publicOrigin,
    trustedProxyIps: proxyIps,
    stateFile,
    webRoot,
    ...(bootstrapCredential === undefined
      ? {}
      : { bootstrapCredential, bootstrapCredentialFile: bootstrapFile }),
    ownerVerifier,
    ownerVerifierFile,
    logLevel,
  })
}
