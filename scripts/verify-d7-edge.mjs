import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import WebSocket from 'ws'

const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 8_000

function fail(reason) {
  throw new Error(`d7-edge:${reason}`)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || values.has(name)) fail('invalid-arguments')
    values.set(name, value)
  }
  const originText = values.get('--origin')
  if (originText === undefined) fail('missing-origin')
  let origin
  try {
    origin = new URL(originText)
  } catch {
    fail('invalid-origin')
  }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    fail('invalid-origin')
  }
  const allowed = new Set(['--origin', '--public-ip'])
  for (const key of values.keys()) if (!allowed.has(key)) fail('invalid-arguments')
  const publicIp = values.get('--public-ip')
  if (publicIp !== undefined && net.isIP(publicIp) === 0) fail('invalid-public-ip')
  return { origin, publicIp }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const operation = transport.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      rejectUnauthorized: true,
      timeout: REQUEST_TIMEOUT_MS,
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          operation.destroy(new Error('response-too-large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    operation.on('timeout', () => operation.destroy(new Error('request-timeout')))
    operation.on('error', reject)
    operation.end()
  })
}

function inspectTls(origin) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: origin.hostname,
      port: Number(origin.port || 443),
      servername: origin.hostname,
      rejectUnauthorized: true,
      timeout: REQUEST_TIMEOUT_MS,
    })
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      const alternativeNames = certificate.subjectaltname ?? ''
      const result = {
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        exactName: alternativeNames.split(/,\s*/u).includes(`DNS:${origin.hostname}`),
        validTo: certificate.valid_to,
      }
      socket.end()
      resolve(result)
    })
    socket.once('timeout', () => socket.destroy(new Error('tls-timeout')))
    socket.once('error', reject)
  })
}

function webSocketOpen(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, handshakeTimeout: REQUEST_TIMEOUT_MS })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('websocket-timeout'))
    }, REQUEST_TIMEOUT_MS)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      reject(new Error(`websocket-status-${response.statusCode}`))
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function closeWebSocket(socket) {
  return new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      socket.terminate()
      resolve()
    }, 2_000)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.close(1000, 'd7-edge-probe')
  })
}

function rejectedWebSocket(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { ...options, handshakeTimeout: REQUEST_TIMEOUT_MS })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('websocket-rejection-timeout'))
    }, REQUEST_TIMEOUT_MS)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.terminate()
      reject(new Error('websocket-unexpected-open'))
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      socket.terminate()
      if (response.statusCode !== expectedStatus) {
        reject(new Error(`websocket-status-${response.statusCode}`))
        return
      }
      resolve(response.statusCode)
    })
    socket.once('error', () => {
      // ws may emit error after unexpected-response; that response is authoritative.
    })
  })
}

function oversizedUnauthenticatedFrame(url, origin) {
  return new Promise(async (resolve, reject) => {
    let socket
    try {
      socket = await webSocketOpen(url, origin)
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('oversized-close-timeout'))
    }, REQUEST_TIMEOUT_MS)
    socket.once('close', code => {
      clearTimeout(timer)
      if (code === 1000) {
        reject(new Error('oversized-normal-close'))
        return
      }
      resolve(code)
    })
    socket.once('error', () => {
      // The close code is the stable assertion for an unauthenticated oversize.
    })
    socket.send('x'.repeat(17 * 1024))
  })
}

function assertPortNotPublic(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, 3_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error('port-publicly-reachable'))
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve('refused')
    })
  })
}

async function main() {
  const { origin, publicIp } = parseArguments(process.argv.slice(2))
  const urls = ['/', '/pair', '/manage']
  const pages = {}
  for (const path of urls) {
    const response = await request(new URL(path, origin))
    if (response.status !== 200 || !response.body.includes('<title>Codex Plus</title>')) {
      fail(`page-${path}`)
    }
    const csp = response.headers['content-security-policy'] ?? ''
    if (!csp.includes('script-src') || !csp.includes(`wss://${origin.host}`)) fail(`csp-${path}`)
    pages[path] = response.status
  }

  const health = await request(new URL('/healthz', origin))
  if (health.status !== 200 || health.body !== '{"status":"ok"}') fail('health')

  const unknown = await request(new URL('/d7-unknown-route', origin))
  if (unknown.status !== 404 || unknown.body !== '') fail('unknown-route')

  const plainOrigin = new URL(origin)
  plainOrigin.protocol = 'http:'
  plainOrigin.port = ''
  const redirect = await request(plainOrigin)
  if (![301, 308].includes(redirect.status) || redirect.headers.location !== origin.href) fail('redirect')

  const nonUpgrade = await request(new URL('/api/ws', origin))
  if (nonUpgrade.status !== 404) fail('non-upgrade-api')

  const tlsResult = await inspectTls(origin)
  if (!tlsResult.authorized || !tlsResult.exactName || !['TLSv1.2', 'TLSv1.3'].includes(tlsResult.protocol)) {
    fail('tls')
  }

  const webSocketUrl = new URL('/api/ws', origin)
  webSocketUrl.protocol = 'wss:'
  const validSocket = await webSocketOpen(webSocketUrl, origin.origin)
  await closeWebSocket(validSocket)

  const wrongOriginStatus = await rejectedWebSocket(webSocketUrl, { origin: 'https://wrong.invalid' }, 403)
  const missingOriginStatus = await rejectedWebSocket(webSocketUrl, {}, 403)
  const queryUrl = new URL(webSocketUrl)
  queryUrl.searchParams.set('probe', '1')
  const queryStatus = await rejectedWebSocket(queryUrl, { origin: origin.origin }, 404)
  const oversizedClose = await oversizedUnauthenticatedFrame(webSocketUrl, origin.origin)
  const boundedSockets = await Promise.all([
    webSocketOpen(webSocketUrl, origin.origin),
    webSocketOpen(webSocketUrl, origin.origin),
    webSocketOpen(webSocketUrl, origin.origin),
    webSocketOpen(webSocketUrl, origin.origin),
  ])
  const connectionLimitStatus = await rejectedWebSocket(webSocketUrl, { origin: origin.origin }, 503)
  await Promise.all(boundedSockets.map(closeWebSocket))
  const directPort = publicIp === undefined ? 'not-requested' : await assertPortNotPublic(publicIp, 8787)

  process.stdout.write(`${JSON.stringify({
    origin: origin.origin,
    pages,
    health: health.body,
    unknownRoute: unknown.status,
    redirect: redirect.status,
    tls: tlsResult,
    webSocketUpgrade: true,
    wrongOriginStatus,
    missingOriginStatus,
    queryStatus,
    oversizedClose,
    connectionLimitStatus,
    directPort,
  })}\n`)
}

await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'd7-edge:failed'}\n`)
  process.exitCode = 1
})
