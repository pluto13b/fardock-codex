import { describe, expect, it } from 'vitest'

import {
  EnvelopeSequenceGuard,
  decodeEnvelope,
  encodeEnvelope,
  type EnvelopeHeader,
} from '@codex-plus/protocol'

import {
  openApplicationEnvelope,
  sealApplicationEnvelope,
} from '../src/channel.ts'
import { importAes256GcmKey } from '../src/primitives.ts'
import { E2eeError } from '../src/runtime.ts'

const now = 1_800_000_000_000
const prefix = new Uint8Array([1, 2, 3, 4])
const expectation = {
  hostId: 'host-main',
  fromDeviceId: 'client-phone',
  toDeviceId: 'host-device',
  connectionGeneration: 7,
  keyId: 'client-to-host-key',
  authorizationId: 'authorization-1',
  authorizationEpoch: 1,
  sessionTranscriptHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  handshakeId: 'handshake-1',
  fromRole: 'client' as const,
}

function header(overrides: Partial<EnvelopeHeader> = {}): EnvelopeHeader {
  return {
    protocolVersion: 1,
    connectionGeneration: 7,
    fromDeviceId: 'client-phone',
    toDeviceId: 'host-device',
    hostId: 'host-main',
    keyId: 'client-to-host-key',
    requestId: 'action-1',
    taskId: 'task-1',
    seq: 2,
    ack: 1,
    sentAt: now,
    expiresAt: now + 30_000,
    messageType: 'request',
    ...overrides,
  }
}

function message(text = '  中文\n```ts\nconst x = "🙂"\n```  ') {
  return {
    kind: 'request' as const,
    operation: 'turn.send' as const,
    params: {
      taskId: 'task-1',
      input: {
        actionId: 'action-1',
        input: [{ type: 'text' as const, text }],
        settings: { model: 'gpt-5', effort: 'high' as const, permission: 'ask' as const },
        expected: { hostId: 'host-main', connectionGeneration: 7, revision: 4 },
      },
    },
  }
}

async function expectAuthenticationFailure(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
    throw new Error('Expected authentication failure')
  } catch (error) {
    expect(error).toBeInstanceOf(E2eeError)
    expect((error as E2eeError).code).toBe('authentication-failed')
  }
}

describe('application envelope E2EE channel', () => {
  it('round-trips canonical Unicode bytes without committing sequence state', async () => {
    const keyBytes = new Uint8Array(32).fill(9)
    const encryptKey = await importAes256GcmKey(keyBytes, 'encrypt')
    const decryptKey = await importAes256GcmKey(keyBytes, 'decrypt')
    const sealed = await sealApplicationEnvelope(encryptKey, prefix, expectation, header(), message(), now)
    const opened = await openApplicationEnvelope(decryptKey, prefix, expectation, sealed.wireText, now)

    expect(opened.message).toEqual(message())
    expect(new TextDecoder().decode(opened.plaintext)).toContain('  中文\\n')

    const guard = new EnvelopeSequenceGuard({
      hostId: 'host-main',
      localDeviceId: 'host-device',
      remoteDeviceId: 'client-phone',
      connectionGeneration: 7,
      keyId: 'client-to-host-key',
      lastAcceptedSeq: 1,
      lastPeerAck: 0,
      maxSentSeq: 1,
    })
    expect(guard.state().lastAcceptedSeq).toBe(1)
    expect(guard.acceptAuthenticatedEnvelope(opened.envelope, now).lastAcceptedSeq).toBe(2)
  })

  it('authenticates every visible header field through AAD', async () => {
    const keyBytes = new Uint8Array(32).fill(3)
    const encryptKey = await importAes256GcmKey(keyBytes, 'encrypt')
    const decryptKey = await importAes256GcmKey(keyBytes, 'decrypt')
    const sealed = await sealApplicationEnvelope(encryptKey, prefix, expectation, header(), message(), now)
    const tampered = decodeEnvelope(sealed.wireText, { validateTime: false })
    const wire = encodeEnvelope({ ...tampered, ack: 0 })
    await expectAuthenticationFailure(
      () => openApplicationEnvelope(decryptKey, prefix, expectation, wire, now),
    )
  })

  it('rejects wrong keys and route mismatches before state can advance', async () => {
    const keyBytes = new Uint8Array(32).fill(5)
    const key = await importAes256GcmKey(keyBytes, 'encrypt')
    const decryptKey = await importAes256GcmKey(keyBytes, 'decrypt')
    const wrongKey = await importAes256GcmKey(new Uint8Array(32).fill(6), 'decrypt')
    const sealed = await sealApplicationEnvelope(key, prefix, expectation, header(), message(), now)
    await expectAuthenticationFailure(
      () => openApplicationEnvelope(wrongKey, prefix, expectation, sealed.wireText, now),
    )

    await expect(
      openApplicationEnvelope(decryptKey, prefix, { ...expectation, toDeviceId: 'other-host' }, sealed.wireText, now),
    ).rejects.toMatchObject({ code: 'route-mismatch' })
  })

  it('rejects plaintext/header authority mismatches before encryption is returned', async () => {
    const key = await importAes256GcmKey(new Uint8Array(32).fill(7), 'encrypt')
    await expect(
      sealApplicationEnvelope(key, prefix, expectation, header({ taskId: 'task-other' }), message(), now),
    ).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('accepts only the exact seq-1 session control and rejects normal application data at seq 1', async () => {
    const keyBytes = new Uint8Array(32).fill(8)
    const encryptKey = await importAes256GcmKey(keyBytes, 'encrypt')
    const decryptKey = await importAes256GcmKey(keyBytes, 'decrypt')
    const confirmHeader = header({
      requestId: 'handshake-1',
      taskId: undefined,
      seq: 1,
      ack: 0,
      messageType: 'control',
    })
    const confirm = {
      kind: 'control' as const,
      operation: 'session.confirm' as const,
      sessionTranscriptHash: expectation.sessionTranscriptHash,
      authorizationId: expectation.authorizationId,
      authorizationEpoch: expectation.authorizationEpoch,
      connectionGeneration: expectation.connectionGeneration,
      senderRole: 'client' as const,
    }
    const sealed = await sealApplicationEnvelope(
      encryptKey,
      prefix,
      expectation,
      confirmHeader,
      confirm,
      now,
    )
    await expect(openApplicationEnvelope(
      decryptKey,
      prefix,
      expectation,
      sealed.wireText,
      now,
    )).resolves.toMatchObject({ message: confirm })

    await expect(sealApplicationEnvelope(
      encryptKey,
      prefix,
      expectation,
      header({ seq: 1 }),
      message(),
      now,
    )).rejects.toMatchObject({ code: 'stale-authority' })
    await expect(sealApplicationEnvelope(
      encryptKey,
      prefix,
      expectation,
      confirmHeader,
      { ...confirm, authorizationEpoch: 2 },
      now,
    )).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('requires a safe current time and refuses expired headers before encryption', async () => {
    const key = await importAes256GcmKey(new Uint8Array(32).fill(10), 'encrypt')
    await expect(sealApplicationEnvelope(
      key,
      prefix,
      expectation,
      header(),
      message(),
      Number.NaN,
    )).rejects.toMatchObject({ code: 'schema-invalid' })
    await expect(sealApplicationEnvelope(
      key,
      prefix,
      expectation,
      header({ sentAt: now - 1_000, expiresAt: now }),
      message(),
      now,
    )).rejects.toMatchObject({ code: 'expired' })
  })

  it('snapshots header and connection authority before asynchronous crypto', async () => {
    const keyBytes = new Uint8Array(32).fill(11)
    const encryptKey = await importAes256GcmKey(keyBytes, 'encrypt')
    const decryptKey = await importAes256GcmKey(keyBytes, 'decrypt')
    const mutableHeader = header()
    const mutableExpectation = { ...expectation }
    const sealing = sealApplicationEnvelope(
      encryptKey,
      prefix,
      mutableExpectation,
      mutableHeader,
      message(),
      now,
    )
    mutableHeader.ack = 0
    mutableHeader.requestId = 'attacker'
    mutableExpectation.authorizationId = 'mutated-authorization'
    const sealed = await sealing
    expect(sealed.envelope.ack).toBe(1)
    expect(sealed.envelope.requestId).toBe('action-1')

    const openingExpectation = { ...expectation }
    const opening = openApplicationEnvelope(
      decryptKey,
      prefix,
      openingExpectation,
      sealed.wireText,
      now,
    )
    openingExpectation.authorizationId = 'rotated-during-decrypt'
    await expect(opening).resolves.toMatchObject({ message: message() })
  })
})
