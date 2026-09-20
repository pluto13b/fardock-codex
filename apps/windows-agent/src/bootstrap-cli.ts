import process from 'node:process'

import { WindowsIdentityStore } from './windows-identity-store.ts'

type Command = 'create' | 'export' | 'mark-registered' | 'inspect'

function parseArguments(argv: readonly string[]): Readonly<{
  command: Command
  workspaceRoot: string
  identityFile: string
  exportFile?: string
}> {
  const command = argv[0]
  if (command !== 'create' && command !== 'export' && command !== 'mark-registered' && command !== 'inspect') {
    throw new Error('invalid-command')
  }
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (
      (name !== '--workspace-root' && name !== '--identity-file' && name !== '--export-file')
      || value === undefined
      || values.has(name)
    ) throw new Error('invalid-arguments')
    values.set(name, value)
  }
  const workspaceRoot = values.get('--workspace-root')
  const identityFile = values.get('--identity-file')
  const exportFile = values.get('--export-file')
  if (
    workspaceRoot === undefined
    || identityFile === undefined
    || ((command === 'create' || command === 'export') && exportFile === undefined)
    || ((command === 'mark-registered' || command === 'inspect') && exportFile !== undefined)
  ) throw new Error('invalid-arguments')
  return {
    command,
    workspaceRoot,
    identityFile,
    ...(exportFile === undefined ? {} : { exportFile }),
  }
}

async function run(): Promise<void> {
  const input = parseArguments(process.argv.slice(2))
  const store = await WindowsIdentityStore.open({
    workspaceRoot: input.workspaceRoot,
    identityFile: input.identityFile,
  })
  if (input.command === 'create') {
    const identity = await store.initialize()
    await store.exportBootstrap(input.exportFile!)
    process.stdout.write(`${JSON.stringify({
      event: 'bootstrap.created',
      hostId: identity.hostId,
      hostDeviceId: identity.hostDeviceId,
    })}\n`)
    return
  }
  if (input.command === 'export') {
    await store.exportBootstrap(input.exportFile!)
    process.stdout.write(`${JSON.stringify({ event: 'bootstrap.exported' })}\n`)
    return
  }
  if (input.command === 'mark-registered') {
    await store.markBootstrapRegistered()
    process.stdout.write(`${JSON.stringify({ event: 'bootstrap.registered' })}\n`)
    return
  }
  const identity = await store.loadIdentity()
  process.stdout.write(`${JSON.stringify({
    event: 'bootstrap.identity',
    hostId: identity.hostId,
    hostDeviceId: identity.hostDeviceId,
    bootstrapPresent: identity.bootstrapCredential !== undefined,
  })}\n`)
}

void run().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'bootstrap.failed' })}\n`)
  process.exitCode = 1
})
