import { resolve } from 'node:path'

import { WindowsAnchoredActionState } from './windows-action-state-store.ts'

export async function releaseProductionIndeterminateBlocks(
  workspaceRoot: string,
): Promise<number> {
  const databasePath = resolve(workspaceRoot, '.data', 'windows-companion', 'action.sqlite')
  const authority = await WindowsAnchoredActionState.openExisting({ workspaceRoot, databasePath })
  try {
    const released = authority.store.releaseIndeterminateTaskBlocksForLocalOperator()
    await authority.syncAfterRequestBoundary()
    return released
  } finally {
    await authority.close().catch(() => undefined)
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const current = resolve(import.meta.filename)
  const requested = resolve(entry)
  return process.platform === 'win32'
    ? current.toLowerCase() === requested.toLowerCase()
    : current === requested
}

if (isDirectExecution()) {
  const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..')
  void releaseProductionIndeterminateBlocks(workspaceRoot).then(
    released => process.stdout.write(`${JSON.stringify({ event: 'operator.recovery_completed', released })}\n`),
    () => {
      process.stderr.write(`${JSON.stringify({ event: 'operator.recovery_failed_closed' })}\n`)
      process.exitCode = 1
    },
  )
}
