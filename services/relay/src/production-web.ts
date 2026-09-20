import { lstat, readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024
const SPA_ROUTES = new Set(['/', '/pair', '/manage'])
const PUBLIC_ROOT_FILES = new Set(['favicon.svg', 'index.html'])

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

export interface ProductionWebHandlerOptions {
  webRoot: string
  publicOrigin: string
}

export type ProductionWebHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>

export class ProductionWebRootError extends Error {
  constructor() {
    super('invalid-web-root')
    this.name = 'ProductionWebRootError'
  }
}

function normalized(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function within(root: string, candidate: string): boolean {
  const path = relative(normalized(root), normalized(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function fixedHeaders(contentSecurityPolicy: string): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy,
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

function finishEmpty(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
): void {
  response.writeHead(status, { ...headers, 'content-length': '0' })
  response.end()
}

async function readSafeFile(
  webRoot: string,
  candidate: string,
): Promise<Readonly<{ bytes: Buffer; realFile: string }> | undefined> {
  if (!within(webRoot, candidate)) return undefined
  try {
    const [metadata, realFile] = await Promise.all([lstat(candidate), realpath(candidate)])
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size > MAX_STATIC_FILE_BYTES
      || !within(webRoot, realFile)
    ) return undefined
    const bytes = await readFile(realFile)
    if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_STATIC_FILE_BYTES) return undefined
    return { bytes, realFile }
  } catch {
    return undefined
  }
}

export async function createProductionWebHandler(
  options: ProductionWebHandlerOptions,
): Promise<ProductionWebHandler> {
  if (!isAbsolute(options.webRoot)) throw new ProductionWebRootError()
  let webRoot: string
  try {
    const metadata = await lstat(options.webRoot)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ProductionWebRootError()
    webRoot = await realpath(options.webRoot)
    if (normalized(webRoot) !== normalized(options.webRoot)) throw new ProductionWebRootError()
  } catch (error) {
    if (error instanceof ProductionWebRootError) throw error
    throw new ProductionWebRootError()
  }

  const indexFile = resolve(webRoot, 'index.html')
  const initialIndex = await readSafeFile(webRoot, indexFile)
  if (initialIndex === undefined) throw new ProductionWebRootError()
  const indexHtml = initialIndex.bytes.toString('utf8')
  if (
    !indexHtml.includes('<title>Codex Plus</title>')
    || !/\/assets\/[A-Za-z0-9._~-]+\.js/.test(indexHtml)
    || /\/src\/|\/api\/local-demo-login|\b(?:fixture|offline-demo)\b/i.test(indexHtml)
  ) throw new ProductionWebRootError()

  const publicUrl = new URL(options.publicOrigin)
  publicUrl.protocol = 'wss:'
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src 'self' ${publicUrl.origin}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join('; ')
  const securityHeaders = fixedHeaders(contentSecurityPolicy)

  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      finishEmpty(response, 405, { ...securityHeaders, allow: 'GET, HEAD' })
      return
    }

    let pathname: string
    try {
      const parsed = new URL(request.url ?? '', 'http://gateway.invalid')
      pathname = decodeURIComponent(parsed.pathname)
      if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
        finishEmpty(response, 404, securityHeaders)
        return
      }
    } catch {
      finishEmpty(response, 404, securityHeaders)
      return
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      finishEmpty(response, 404, securityHeaders)
      return
    }

    const segments = pathname.split('/').filter(Boolean)
    if (segments.some(segment => segment === '.' || segment === '..')) {
      finishEmpty(response, 404, securityHeaders)
      return
    }

    const publicFile = segments.length === 1
      ? PUBLIC_ROOT_FILES.has(segments[0] ?? '')
      : segments.length > 1
        && (segments[0] === 'assets' || segments[0] === 'third-party')
    let file = segments.length === 0
      ? initialIndex
      : publicFile
        ? await readSafeFile(webRoot, resolve(webRoot, ...segments))
        : undefined
    if (file === undefined && SPA_ROUTES.has(pathname)) {
      file = await readSafeFile(webRoot, indexFile)
    }
    if (file === undefined) {
      finishEmpty(response, 404, securityHeaders)
      return
    }

    const isIndex = normalized(file.realFile) === normalized(indexFile)
    const headers = {
      ...securityHeaders,
      'cache-control': isIndex
        ? 'no-store'
        : pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      'content-length': String(file.bytes.byteLength),
      'content-type': CONTENT_TYPES[extname(file.realFile).toLowerCase()] ?? 'application/octet-stream',
    }
    response.writeHead(200, headers)
    response.end(request.method === 'HEAD' ? undefined : file.bytes)
  }
}
