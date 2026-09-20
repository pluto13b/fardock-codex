import { execFile } from 'node:child_process'
import { createServer, type Server as HttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const certificateGenerator = fileURLToPath(
  new URL('../fixtures/generate-test-certificate.cjs', import.meta.url),
)

export interface TestTlsReverseProxy {
  readonly httpsOrigin: string
  readonly webSocketUrl: string
  readonly certificate: string
  setTargetPort(port: number): void
  close(): Promise<void>
}

async function generateCertificate(): Promise<Readonly<{
  key: string
  certificate: string
}>> {
  const result = await execFileAsync(process.execPath, [certificateGenerator], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024,
    windowsHide: true,
  })
  const parsed: unknown = JSON.parse(result.stdout)
  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as { key?: unknown }).key !== 'string'
    || typeof (parsed as { certificate?: unknown }).certificate !== 'string'
  ) throw new Error('invalid-test-certificate')
  return parsed as { key: string; certificate: string }
}

function forwardedHeaders(
  input: import('node:http').IncomingHttpHeaders,
  publicHost: string,
  upgrade: boolean,
): import('node:http').OutgoingHttpHeaders {
  const headers: import('node:http').OutgoingHttpHeaders = {}
  const skipped = new Set([
    'host',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
  ])
  if (!upgrade) {
    skipped.add('connection')
    skipped.add('upgrade')
  }
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || skipped.has(name)) continue
    headers[name] = value
  }
  headers.host = publicHost
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = publicHost
  return headers
}

function writeUpgradeResponse(
  downstream: Duplex,
  response: import('node:http').IncomingMessage,
): void {
  const status = `HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\n`
  const headers: string[] = []
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
  }
  downstream.write(`${status}${headers.join('\r\n')}\r\n\r\n`)
}

export async function startTestTlsReverseProxy(): Promise<TestTlsReverseProxy> {
  const tls = await generateCertificate()
  let targetPort: number | undefined
  let publicHost = ''
  const sockets = new Set<Socket>()

  const server: HttpsServer = createServer({
    key: tls.key,
    cert: tls.certificate,
    minVersion: 'TLSv1.2',
  }, (request, response) => {
    if (targetPort === undefined || request.headers.host !== publicHost) {
      response.writeHead(421, { connection: 'close', 'content-length': '0' })
      response.end()
      return
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, publicHost, false),
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => {
      if (response.headersSent) response.destroy()
      else {
        response.writeHead(502, { connection: 'close', 'content-length': '0' })
        response.end()
      }
    })
    request.pipe(upstream)
  })

  server.maxHeadersCount = 64
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 2_000
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, downstream, head) => {
    if (targetPort === undefined || request.headers.host !== publicHost) {
      downstream.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, publicHost, true),
    })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      writeUpgradeResponse(downstream, response)
      if (head.byteLength > 0) upstreamSocket.write(head)
      if (upstreamHead.byteLength > 0) downstream.write(upstreamHead)
      upstreamSocket.once('close', () => {
        if (!downstream.destroyed) downstream.destroy()
      })
      downstream.once('close', () => {
        if (!upstreamSocket.destroyed) upstreamSocket.destroy()
      })
      upstreamSocket.pipe(downstream)
      downstream.pipe(upstreamSocket)
    })
    upstream.on('response', response => {
      writeUpgradeResponse(downstream, response)
      response.pipe(downstream)
    })
    upstream.on('error', () => {
      downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    upstream.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing-test-tls-address')
  const port = (address as AddressInfo).port
  publicHost = `127.0.0.1:${port}`

  return {
    httpsOrigin: `https://${publicHost}`,
    webSocketUrl: `wss://${publicHost}/api/ws`,
    certificate: tls.certificate,
    setTargetPort(portValue) {
      if (!Number.isSafeInteger(portValue) || portValue < 1 || portValue > 65_535) {
        throw new Error('invalid-test-target-port')
      }
      targetPort = portValue
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
