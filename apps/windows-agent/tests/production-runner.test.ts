import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  fingerprintP256PublicKey,
  generateSigningKeyPair,
  type SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import type { PersistentHostPairingRuntime } from '../src/persistent-pairing-runtime.ts'
import {
  bindProductionTerminalInterrupt,
  classifyProductionSessionHandshakeFailure,
  connectProductionHostWithBootstrapFallback,
  createCurrentAuthorizationAssertion,
  createProductionSupervisorFailureBoundary,
  createProductionTurnOwnership,
  openProductionActionAuthority,
  ProductionRunnerError,
  requestExactProductionPairingDecision,
  runAnchoredRequestBoundary,
  runProductionCompanion,
  syncCurrentActiveAuthorizations,
} from '../src/production-runner.ts'
import type {
  R3RelayHostAuthentication,
  R3RelayHostClient,
} from '../src/relay-host-client.ts'

it('does not open profile or runtime state after the desktop owner already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(runProductionCompanion(undefined as never, { signal: controller.signal, interactive: false })).resolves.toBeUndefined()
})

function fakeAttempt(connect: () => Promise<void>) {
  const close = vi.fn(async () => undefined)
  const client = {
    connect,
    close,
  } as unknown as R3RelayHostClient
  return {
    attempt: {
      client,
      runtime: {} as PersistentHostPairingRuntime,
    },
    close,
  }
}

const bootstrapAuthentication = Object.freeze({
  kind: 'bootstrap' as const,
  bootstrapCredential: 'A'.repeat(43),
  hostSigningKey: Object.freeze({
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: 'B'.repeat(43),
    y: 'C'.repeat(43),
  }),
  hostSigningFingerprint: 'D'.repeat(43),
})

describe('production runner security composition', () => {
  it('reduces session handshake failures to fixed non-sensitive stage codes', () => {
    expect(classifyProductionSessionHandshakeFailure(
      new Error('runtime-stage:validate-session-init'),
    )).toBe('validate-session-init')
    expect(classifyProductionSessionHandshakeFailure(
      new Error('runtime-stage:create-session-accept:protocol-ttl-exceeded'),
    )).toBe('create-session-accept:protocol-ttl-exceeded')
    expect(classifyProductionSessionHandshakeFailure(
      new Error('runtime-stage:create-session-accept:e2ee-authentication-failed'),
    )).toBe('create-session-accept:e2ee-authentication-failed')
    expect(classifyProductionSessionHandshakeFailure(
      new Error('runtime-stage:create-session-accept:untrusted-detail'),
    )).toBe('create-session-accept:unknown')
    expect(classifyProductionSessionHandshakeFailure(
      new Error('runtime-stage:send-session-accept'),
    )).toBe('send-session-accept')
    expect(classifyProductionSessionHandshakeFailure(
      new Error('secret-looking-untrusted-text'),
    )).toBe('unknown')
    expect(classifyProductionSessionHandshakeFailure({ payload: 'not logged' })).toBe('unknown')
  })

  it('maps readline SIGINT to the bounded stop path and unbinds cleanly', () => {
    const terminal = new EventEmitter()
    const stop = vi.fn()
    const unbind = bindProductionTerminalInterrupt(terminal as never, stop)
    terminal.emit('SIGINT')
    terminal.emit('SIGINT')
    expect(stop).toHaveBeenCalledTimes(2)
    unbind()
    unbind()
    terminal.emit('SIGINT')
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('creates only when both action files are absent and opens only a complete pair', async () => {
    const created: Readonly<{ mode: string }> = Object.freeze({ mode: 'created' })
    const opened: Readonly<{ mode: string }> = Object.freeze({ mode: 'opened' })
    const create = vi.fn(async () => created)
    const open = vi.fn(async () => opened)

    await expect(openProductionActionAuthority({
      databasePath: 'action.sqlite',
      anchorPath: 'action.sqlite.anchor.dpapi',
      factory: { inspect: async () => 'missing', create, open },
    })).resolves.toBe(created)
    expect(create).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()

    const inspect = vi.fn(async (path: string) => (
      path.endsWith('.dpapi') ? 'file' as const : 'file' as const
    ))
    await expect(openProductionActionAuthority({
      databasePath: 'action.sqlite',
      anchorPath: 'action.sqlite.anchor.dpapi',
      factory: { inspect, create, open },
    })).resolves.toBe(opened)
    expect(open).toHaveBeenCalledOnce()
  })

  it.each([
    ['file', 'missing'],
    ['missing', 'file'],
    ['other', 'file'],
    ['file', 'other'],
  ] as const)('fails closed for partial or unsafe action state: %s/%s', async (database, anchor) => {
    await expect(openProductionActionAuthority({
      databasePath: 'database',
      anchorPath: 'anchor',
      factory: {
        inspect: async path => path === 'database' ? database : anchor,
        create: async () => 'created',
        open: async () => 'opened',
      },
    })).rejects.toMatchObject({ code: 'action-authority-incomplete' })
  })

  it('syncs the rollback anchor before and after a successful or failed frame boundary', async () => {
    const events: string[] = []
    const authority = {
      syncAfterRequestBoundary: vi.fn(async () => { events.push('sync') }),
    }
    await expect(runAnchoredRequestBoundary(authority, async () => {
      events.push('operation')
      return 7
    })).resolves.toBe(7)
    expect(events).toEqual(['sync', 'operation', 'sync'])

    events.length = 0
    await expect(runAnchoredRequestBoundary(authority, async () => {
      events.push('failed-operation')
      throw new Error('synthetic failure')
    })).rejects.toThrow('synthetic failure')
    expect(events).toEqual(['sync', 'failed-operation', 'sync'])
  })

  it('marks bootstrap registered only after welcome and makes one same-identity resume attempt on ambiguity', async () => {
    const first = fakeAttempt(async () => { throw new Error('ambiguous') })
    const second = fakeAttempt(async () => undefined)
    const modes: R3RelayHostAuthentication['kind'][] = []
    const mark = vi.fn(async () => undefined)

    const result = await connectProductionHostWithBootstrapFallback({
      bootstrapAuthentication,
      createAttempt: async authentication => {
        modes.push(authentication.kind)
        return modes.length === 1 ? first.attempt : second.attempt
      },
      markBootstrapRegistered: mark,
    })
    expect(result).toBe(second.attempt)
    expect(modes).toEqual(['bootstrap', 'resume'])
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(mark).toHaveBeenCalledOnce()
  })

  it('does not clear bootstrap or invent another credential when both authentication outcomes are ambiguous', async () => {
    const attempts = [
      fakeAttempt(async () => { throw new Error('first') }),
      fakeAttempt(async () => { throw new Error('second') }),
    ]
    const authentications: R3RelayHostAuthentication[] = []
    const mark = vi.fn(async () => undefined)
    await expect(connectProductionHostWithBootstrapFallback({
      bootstrapAuthentication,
      createAttempt: async authentication => {
        authentications.push(authentication)
        return attempts[authentications.length - 1]!.attempt
      },
      markBootstrapRegistered: mark,
    })).rejects.toEqual(new ProductionRunnerError('bootstrap-ambiguous'))
    expect(authentications).toEqual([bootstrapAuthentication, { kind: 'resume' }])
    expect(mark).not.toHaveBeenCalled()
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    expect(attempts[1]!.close).toHaveBeenCalledOnce()
  })

  it('fails closed after a welcome if clearing the local bootstrap copy fails', async () => {
    const connected = fakeAttempt(async () => undefined)
    const createAttempt = vi.fn(async () => connected.attempt)
    await expect(connectProductionHostWithBootstrapFallback({
      bootstrapAuthentication,
      createAttempt,
      markBootstrapRegistered: async () => { throw new Error('synthetic storage failure') },
    })).rejects.toThrow('synthetic storage failure')
    expect(createAttempt).toHaveBeenCalledOnce()
    expect(connected.close).toHaveBeenCalledOnce()
  })

  it('requires the exact SAS approval phrase and JSON-escapes untrusted device text', async () => {
    const confirmation = {
      deviceDisplayName: 'phone"\nspoof',
      sas: '123-456',
      clientSigningFingerprint: 'fingerprint.test',
      expiresAt: 42,
    }
    let output = ''
    const approve = await requestExactProductionPairingDecision(confirmation, {
      write: line => { output += line },
      question: async prompt => {
        expect(prompt).toBe('Type exact APPROVE 123-456: ')
        return 'APPROVE 123-456'
      },
    })
    expect(approve).toEqual({ decision: 'approve' })
    expect(output.split('\n')).toHaveLength(2)
    expect(JSON.parse(output)).toMatchObject({
      event: 'production.pairing_confirmation_required',
      deviceDisplayName: confirmation.deviceDisplayName,
      sas: confirmation.sas,
    })

    for (const answer of ['APPROVE', 'APPROVE 123-456 ', 'approve 123-456']) {
      await expect(requestExactProductionPairingDecision(confirmation, {
        write: () => undefined,
        question: async () => answer,
      })).resolves.toEqual({ decision: 'deny' })
    }
  })

  it('caches and compares DPAPI authorization claims independently per browser device', async () => {
    const authority: SessionAuthority = Object.freeze({
      relayOrigin: 'https://codex.example.test',
      hostId: 'host.test',
      hostDeviceId: 'windows.test',
      clientDeviceId: 'client.test',
      authorizationId: 'authorization.test',
      authorizationEpoch: 1,
      handshakeId: 'handshake.test',
      connectionGeneration: 2,
      sessionTranscriptHash: 'A'.repeat(43),
    })
    const otherAuthority: SessionAuthority = Object.freeze({
      ...authority,
      clientDeviceId: 'client.second',
      authorizationId: 'authorization.second',
      handshakeId: 'handshake.second',
      connectionGeneration: 1,
    })
    const loadAuthorization = vi.fn(async (authorizationId: string) => {
      const selected = authorizationId === otherAuthority.authorizationId ? otherAuthority : authority
      return ({
      material: {
        grantClaims: {
          relayOrigin: selected.relayOrigin,
          hostId: selected.hostId,
          hostDeviceId: selected.hostDeviceId,
          clientDeviceId: selected.clientDeviceId,
          authorizationId: selected.authorizationId,
          authorizationEpoch: selected.authorizationEpoch,
        },
      },
      })
    })
    const assertCurrent = createCurrentAuthorizationAssertion(
      { loadAuthorization } as never,
      authority.relayOrigin,
    )
    await assertCurrent(authority)
    await assertCurrent(authority)
    await assertCurrent(otherAuthority)
    await assertCurrent(otherAuthority)
    await assertCurrent(authority)
    expect(loadAuthorization).toHaveBeenCalledTimes(2)
    assertCurrent.invalidate(otherAuthority.authorizationId)
    await assertCurrent(otherAuthority)
    expect(loadAuthorization).toHaveBeenCalledTimes(3)

    await expect(assertCurrent({ ...authority, clientDeviceId: 'client.other' }))
      .rejects.toMatchObject({ code: 'stale-authorization' })
    expect(loadAuthorization).toHaveBeenCalledTimes(3)
  })

  it('replays active public authorizations to Relay in Host revision order', async () => {
    const [firstKey, secondKey] = await Promise.all([
      generateSigningKeyPair(),
      generateSigningKeyPair(),
    ])
    const [firstFingerprint, secondFingerprint] = await Promise.all([
      fingerprintP256PublicKey(firstKey.publicKey),
      fingerprintP256PublicKey(secondKey.publicKey),
    ])
    const values = new Map([
      ['authorization.first', {
        material: {
          grantClaims: {
            hostId: 'host.sync', hostDeviceId: 'windows.sync',
            clientDeviceId: 'client.first', authorizationId: 'authorization.first',
            authorizationEpoch: 1, clientSigningFingerprint: firstFingerprint,
          },
          clientSigningPublicKey: firstKey.publicKey,
        },
        hostAuthorizationRevision: 7,
      }],
      ['authorization.second', {
        material: {
          grantClaims: {
            hostId: 'host.sync', hostDeviceId: 'windows.sync',
            clientDeviceId: 'client.second', authorizationId: 'authorization.second',
            authorizationEpoch: 1, clientSigningFingerprint: secondFingerprint,
          },
          clientSigningPublicKey: secondKey.publicKey,
        },
        hostAuthorizationRevision: 6,
      }],
    ])
    const putAuthorization = vi.fn(async value => ({ ...value, relayType: 'authorization.applied' as const }))
    await expect(syncCurrentActiveAuthorizations({
      activeAuthorizationIds: async () => ['authorization.first', 'authorization.second'],
      loadAuthorization: async id => values.get(id) as never,
    }, { putAuthorization })).resolves.toBe(2)
    expect(putAuthorization.mock.calls.map(([value]) => value.hostAuthorizationRevision)).toEqual([6, 7])
  })

  it('grants live authority only to the exact task/turn proven by an accepted callback', () => {
    const ownership = createProductionTurnOwnership()
    expect(ownership.ownsTask('task.1')).toBe(false)
    expect(ownership.ownsTurn('task.1', 'turn.1')).toBe(false)
    ownership.onAcceptedTextTurn({ taskId: 'task.1', turnId: 'turn.1' })
    expect(ownership.ownsTask('task.1')).toBe(true)
    expect(ownership.ownsTurn('task.1', 'turn.1')).toBe(true)
    expect(ownership.ownsTurn('task.1', 'turn.other')).toBe(false)
    ownership.onAcceptedTextTurn({ taskId: 'task.1', turnId: 'turn.2' })
    expect(ownership.ownsTurn('task.1', 'turn.1')).toBe(false)
    expect(ownership.ownsTurn('task.1', 'turn.2')).toBe(true)
    ownership.clear()
    expect(ownership.ownsTask('task.1')).toBe(false)
  })

  it('stops the runner on an owned app-server failure and emits no child details', () => {
    let output = ''
    const requestStop = vi.fn()
    const boundary = createProductionSupervisorFailureBoundary({
      write: line => { output += line },
      requestStop,
    })
    boundary.logger({
      event: 'lifecycle',
      generation: 1,
      state: 'ready',
      outcome: 'entered',
    })
    expect(boundary.failed()).toBe(false)
    boundary.logger({
      event: 'lifecycle',
      generation: 1,
      state: 'failed',
      outcome: 'failed',
      code: 'protocol-error',
      detail: 'stdout-line-too-large',
      pendingMethod: 'thread/read',
    })
    boundary.logger({
      event: 'lifecycle',
      generation: 1,
      state: 'failed',
      outcome: 'failed',
      code: 'child-exited',
    })
    expect(boundary.failed()).toBe(true)
    expect(requestStop).toHaveBeenCalledOnce()
    expect(output).toBe('{"event":"production.app_server_failed","code":"protocol-error","detail":"stdout-line-too-large","method":"thread/read"}\n')
    expect(output).not.toMatch(/generation|command|path|stderr/i)
  })

  it('exposes only explicit production scripts and no automatic approval flag', async () => {
    const root = resolve(import.meta.dirname, '..', '..', '..')
    const [workspacePackage, agentPackage] = await Promise.all([
      readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
      readFile(resolve(root, 'apps', 'windows-agent', 'package.json'), 'utf8').then(JSON.parse),
    ])
    expect(workspacePackage.scripts['windows-production']).toBe(
      'pnpm --filter @codex-plus/windows-agent production',
    )
    expect(agentPackage.scripts.production).toBe('tsx src/production-runner.ts')
    expect(JSON.stringify({ workspacePackage, agentPackage })).not.toMatch(/production.*auto-approve/i)
  })
})
