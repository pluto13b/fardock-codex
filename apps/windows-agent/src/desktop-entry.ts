import { stat, mkdir } from 'node:fs/promises'
import { runProductionCompanion } from './production-runner.ts'
import { parseProductionRunnerOptions } from './production-runner-options.ts'
import { runDesktopControl } from './desktop-control.ts'
import { protectForCurrentWindowsUser, unprotectForCurrentWindowsUser } from './windows-dpapi.ts'
import { DatabaseSync } from 'node:sqlite'

async function main() {
  const check = process.argv[2] === '--check'
  const options = parseProductionRunnerOptions(process.argv.slice(check ? 3 : 2), process.cwd())
  if (process.platform !== 'win32' || !/^26\./u.test(process.versions.node)) throw new Error('runtime')
  if (!(await stat(options.codexExecutable)).isFile()) throw new Error('runtime')
  if (check) {
    const probe = Buffer.from('codex-plus-release-check')
    const protectedProbe = await protectForCurrentWindowsUser(probe)
    const opened = await unprotectForCurrentWindowsUser(protectedProbe)
    try {
      if (!opened.equals(probe)) throw new Error('dpapi')
      const database = new DatabaseSync(':memory:')
      try { database.prepare('SELECT 1').get() } finally { database.close() }
    } finally { probe.fill(0); protectedProbe.fill(0); opened.fill(0) }
    process.stdout.write('{"event":"desktop.package_ready"}\n')
    return
  }
  process.stdout.write('{"event":"desktop.ready"}\n')
  let createPairing: (() => Promise<Readonly<{ code: string; expiresAt: number }>>) | undefined
  let pairingEpoch = 0
  // This is a private reply to the owning GUI, consumed separately from logs.
  const pairingReply = (value: object) => process.stdout.write(`${JSON.stringify({ desktopMessage: 'pairing', ...value })}\n`)
  await runDesktopControl(process.stdin, async signal => {
    await mkdir(options.temporaryDirectory, { recursive: true })
    process.env.TEMP = options.temporaryDirectory
    process.env.TMP = options.temporaryDirectory
    await runProductionCompanion(options, {
      signal, interactive: false,
      onLocalPairingReady: create => {
        createPairing = create
        pairingEpoch++
        if (create === undefined) pairingReply({ state: 'unavailable' })
      },
      onPairingCompleted: () => { pairingEpoch++; pairingReply({ state: 'paired' }) },
    })
  }, async () => {
    const create = createPairing
    const epoch = pairingEpoch
    try {
      if (create === undefined) throw new Error('unavailable')
      const result = await create()
      if (epoch === pairingEpoch) pairingReply({ state: 'code', ...result })
    } catch {
      if (epoch === pairingEpoch) pairingReply({ state: 'failed' })
    }
  })
  process.stdout.write('{"event":"desktop.stopped"}\n')
}

void main().catch(() => {
  process.stderr.write('{"event":"desktop.failed_closed"}\n')
  process.exitCode = 1
})
