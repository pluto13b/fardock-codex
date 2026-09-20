import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  OwnerSessionAuthority,
  type OwnerPasswordVerifier,
} from './owner-auth.ts'
import type { ProductionWebHandler } from './production-web.ts'
import { PairingCodeAuthority } from './pairing-code.ts'

const MAX_LOGIN_BODY_BYTES = 4 * 1_024
const MAX_PAIRING_CODE_BODY_BYTES = 20 * 1_024

export interface OwnerAuthenticatedWeb {
  readonly handler: ProductionWebHandler
  readonly isAuthenticated: (request: IncomingMessage) => boolean
  readonly pairingCodes: Pick<PairingCodeAuthority, 'register' | 'revoke'>
  close(): void
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    ...headers,
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function empty(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...headers,
    'cache-control': 'no-store',
    'content-length': '0',
    'x-content-type-options': 'nosniff',
  })
  response.end()
}

async function jsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return undefined
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += value.byteLength
      if (bytes > maxBytes) return undefined
      chunks.push(value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function createOwnerAuthenticatedWeb(input: Readonly<{
  verifier: OwnerPasswordVerifier
  publicOrigin: string
  staticHandler: ProductionWebHandler
  now?: () => number
  randomBytes?: (length: number) => Buffer
}>): OwnerAuthenticatedWeb {
  const authority = new OwnerSessionAuthority({
    verifier: input.verifier,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomBytes === undefined ? {} : { randomBytes: input.randomBytes }),
  })
  const pairingCodes = new PairingCodeAuthority({
    publicOrigin: input.publicOrigin,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomBytes === undefined ? {} : { randomBytes: input.randomBytes }),
  })
  const isAuthenticated = (request: IncomingMessage): boolean => (
    authority.session(request.headers.cookie) !== undefined
  )

  return Object.freeze({
    isAuthenticated,
    pairingCodes,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      let url: URL
      try {
        url = new URL(request.url ?? '', 'http://gateway.invalid')
      } catch {
        empty(response, 404)
        return
      }
      const isAuthRoute = url.pathname === '/api/auth/session'
        || url.pathname === '/api/auth/login'
        || url.pathname === '/api/auth/logout'
      const isPairingCodeRoute = url.pathname === '/api/pairing-code/register'
        || url.pathname === '/api/pairing-code/redeem'
      if ((!isAuthRoute && !isPairingCodeRoute) || url.search !== '') {
        await input.staticHandler(request, response)
        return
      }

      if (url.pathname === '/api/auth/session') {
        if (request.method !== 'GET') {
          empty(response, 405, { allow: 'GET' })
          return
        }
        const session = authority.session(request.headers.cookie)
        json(response, 200, session ?? { authenticated: false })
        return
      }

      if (request.method !== 'POST') {
        empty(response, 405, { allow: 'POST' })
        return
      }
      if (request.headers.origin !== input.publicOrigin) {
        empty(response, 403)
        return
      }

      if (url.pathname === '/api/auth/logout') {
        empty(response, 204, { 'set-cookie': authority.logout(request.headers.cookie) })
        return
      }

      if (isPairingCodeRoute) {
        if (!isAuthenticated(request)) {
          json(response, 401, { ok: false })
          return
        }
        const body = await jsonBody(request, MAX_PAIRING_CODE_BODY_BYTES)
        if (body === undefined) {
          json(response, 400, { ok: false })
          return
        }
        if (url.pathname === '/api/pairing-code/register') {
          const keys = Object.keys(body).sort()
          if (keys.length !== 2 || keys[0] !== 'expiresAt' || keys[1] !== 'invitationFragment') {
            json(response, 400, { ok: false })
            return
          }
          try {
            json(response, 200, { ok: true, ...pairingCodes.register(body.invitationFragment, body.expiresAt) })
          } catch {
            json(response, 400, { ok: false })
          }
          return
        }
        const keys = Object.keys(body)
        if (keys.length !== 1 || keys[0] !== 'code') {
          json(response, 400, { ok: false })
          return
        }
        const redeemed = pairingCodes.redeem(body.code)
        json(response, redeemed === undefined ? 404 : 200, redeemed === undefined
          ? { ok: false }
          : { ok: true, ...redeemed })
        return
      }

      const body = await jsonBody(request, MAX_LOGIN_BODY_BYTES)
      const keys = body === undefined ? [] : Object.keys(body).sort()
      if (body === undefined || keys.length !== 2 || keys[0] !== 'password' || keys[1] !== 'username') {
        json(response, 400, { authenticated: false })
        return
      }
      const result = await authority.login(body.username, body.password)
      if (result.state === 'rate-limited') {
        json(response, 429, { authenticated: false }, { 'retry-after': '60' })
        return
      }
      if (result.state === 'invalid') {
        json(response, 401, { authenticated: false })
        return
      }
      json(response, 200, {
        authenticated: true,
        username: result.username,
      }, { 'set-cookie': result.setCookie })
    },
    close: () => {
      pairingCodes.close()
      authority.close()
    },
  })
}
