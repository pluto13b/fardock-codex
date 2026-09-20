import { Agent, get } from 'node:https'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { latencyStatistics } from '../tests/helpers/latency-statistics.ts'

type Sample = { ok: boolean; totalMs: number; firstByteMs?: number; tcpMs?: number; tlsMs?: number; reused: boolean; bytes: number }

function measure(origin: string, agent: Agent): Promise<Sample> {
  return new Promise(done => {
    const start = performance.now()
    let settled = false, connectedAt = start
    const sample: Sample = { ok: false, totalMs: 0, reused: false, bytes: 0 }
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sample.totalMs = performance.now() - start
      done(sample)
    }
    const request = get(`${origin}/healthz`, { agent, rejectUnauthorized: true }, response => {
      sample.firstByteMs = performance.now() - start
      let body = ''
      response.on('data', (chunk: Buffer) => {
        sample.bytes += chunk.length
        if (sample.bytes > 4096) { response.destroy(); request.destroy(); finish(); return }
        body += chunk.toString('utf8')
      })
      response.once('end', () => {
        try { sample.ok = response.statusCode === 200 && JSON.parse(body).status === 'ok' } catch { /* fixed failure result */ }
        finish()
      })
      response.once('error', finish)
    })
    const timer = setTimeout(() => { request.destroy(); finish() }, 10_000)
    request.on('socket', socket => {
      sample.reused = request.reusedSocket
      if (socket.connecting) {
        socket.once('connect', () => { connectedAt = performance.now(); sample.tcpMs = connectedAt - start })
        socket.once('secureConnect', () => { sample.tlsMs = performance.now() - connectedAt })
      }
    })
    request.once('error', finish)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const originInput = args[args.indexOf('--origin') + 1]
  const count = args.includes('--samples') ? Number(args[args.indexOf('--samples') + 1]) : 30
  if (!args.includes('--origin') || !originInput || !Number.isSafeInteger(count) || count < 10 || count > 100) {
    throw new Error('Use --origin https://your-gateway.example [--samples 30]')
  }
  const url = new URL(originInput)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('HTTPS origin only; credentials and extra paths are not accepted')
  const results = []
  for (const keepAlive of [false, true]) {
    const agent = new Agent({ keepAlive, maxSockets: 1, maxCachedSessions: 0 })
    try {
      const warmups = keepAlive ? 3 : 0
      for (let index = 0; index < warmups; index++) {
        if (!(await measure(url.origin, agent)).ok) throw new Error('healthz warmup failed')
      }
      const samples: Sample[] = []
      for (let index = 0; index < count; index++) samples.push(await measure(url.origin, agent))
      const succeeded = samples.filter(sample => sample.ok)
      results.push({ mode: keepAlive ? 'reused-TLS-connection' : 'new-TCP-TLS-connection', warmups,
        attempted: count, failures: count - succeeded.length, reusedCount: samples.filter(sample => sample.reused).length,
        successfulFirstByte: latencyStatistics(succeeded.map(sample => sample.firstByteMs!)),
        successfulTotal: latencyStatistics(succeeded.map(sample => sample.totalMs)), samples,
      })
      console.log(JSON.stringify({ mode: keepAlive ? 'warm' : 'new-connection', count, failures: count - succeeded.length }))
    } finally { agent.destroy() }
  }
  const directory = resolve(import.meta.dirname, '..', '..', '..', '.tmp', 'link-benchmark')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'public-health.json'), JSON.stringify({
    timestamp: new Date().toISOString(), origin: url.origin, node: process.versions.node, platform: process.platform,
    method: 'sequential HTTPS GET /healthz, no authentication; system DNS cache is not cleared', results,
  }, null, 2))
  if (results.some(result => result.failures > 0)) process.exitCode = 1
}

void main().catch(() => { console.error('Public health benchmark failed; no credentials or response bodies are printed.'); process.exitCode = 1 })
