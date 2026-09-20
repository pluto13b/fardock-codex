import { describe, expect, it } from 'vitest'

import {
  decodeApplicationMessage,
  encodeApplicationMessage,
  ProtocolViolation,
  validateEnvelopeApplicationBinding,
  type ApplicationMessage,
} from '../src/index.ts'
import type { ManagementSnapshot, TaskSnapshot } from '@codex-plus/serve-client'
import { envelope, fixedNow } from './helpers.ts'

const timestamp = '2027-01-15T08:00:00.000Z'

function snapshot(): TaskSnapshot {
  return {
    authoritative: true,
    host: { hostId: 'host-main', generation: 7, state: 'online' },
    revision: 3,
    sequence: 9,
    cursor: 'cursor:task-1:9',
    capabilities: {
      sendTurn: true,
      steerTurn: false,
      interruptTurn: false,
      resolveApproval: false,
      answerQuestion: false,
    },
    task: {
      id: 'task-1',
      workspaceId: 'workspace-1',
      title: 'Protocol test',
      status: 'completed',
      updatedAt: timestamp,
      revision: 3,
      completionReason: 'completed',
    },
    workspace: {
      id: 'workspace-1',
      name: 'codex-plus',
      pathLabel: 'Authorized workspace',
      hostId: 'host-main',
      connectionGeneration: 7,
      connection: 'online',
      capabilities: { startTask: true },
    },
    model: 'gpt-5.6-sol',
    effort: 'high',
    permission: 'ask',
    messages: [
      {
        id: 'message-1',
        kind: 'user',
        createdAt: timestamp,
        turnId: 'turn-1',
        text: '  中文\r\n```ts\nconst quote = "🙂"\n```  ',
      },
    ],
    sources: [],
  }
}

function managementSnapshot(): ManagementSnapshot {
  return {
    generatedAt: fixedNow,
    hostId: 'host-main',
    connectionGeneration: 7,
    layers: {
      gateway: 'healthy',
      relaySocket: 'authenticated',
      host: 'online',
      e2ee: 'ready',
      companion: 'online',
      appServer: 'compatible',
    },
    devices: [{
      deviceId: 'client-current',
      displayName: 'Current browser',
      shortId: 'current',
      signingFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      authorizationId: 'authorization-1',
      authorizationEpoch: 2,
      status: 'active',
      presence: 'online',
      pairedAt: fixedNow - 1_000,
      lastSeenAt: fixedNow,
      isCurrent: true,
    }],
    events: [
      { eventId: 'manage-host', category: 'host', state: 'online', occurredAt: fixedNow },
      { eventId: 'manage-app', category: 'app-server', state: 'compatible', occurredAt: fixedNow },
    ],
  }
}

function sendRequest(): ApplicationMessage {
  return {
    kind: 'request',
    operation: 'turn.send',
    params: {
      taskId: 'task-1',
      input: {
        actionId: 'action-send-1',
        input: [{ type: 'text', text: '  中文\r\n```ts\nconst quote = "🙂"\n```  ' }],
        settings: { model: 'gpt-5.6-sol', effort: 'high', permission: 'ask' },
        expected: { hostId: 'host-main', connectionGeneration: 7, revision: 3 },
      },
    },
  }
}

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

describe('application message protocol', () => {
  it('round-trips a bounded management snapshot and binds it to Host authority', () => {
    const request: ApplicationMessage = { kind: 'request', operation: 'manage.read', params: {} }
    const response: ApplicationMessage = {
      kind: 'response',
      operation: 'manage.read',
      ok: true,
      result: managementSnapshot(),
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(request), 'request')).toEqual(request)
    expect(decodeApplicationMessage(encodeApplicationMessage(response), 'response')).toEqual(response)
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'response', requestId: 'manage-read-1', taskId: undefined }),
      response,
    )).not.toThrow()
    expectCode(
      () => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'response', requestId: 'manage-read-1', hostId: 'host-other', taskId: undefined }),
        response,
      ),
      'stale-authority',
    )
    expectCode(() => encodeApplicationMessage({
      ...response,
      result: { ...managementSnapshot(), devices: [{ ...managementSnapshot().devices[0], signingFingerprint: 'not-a-fingerprint' }] },
    }), 'schema-invalid')
    expect(() => encodeApplicationMessage({
      ...response,
      result: {
        ...managementSnapshot(),
        devices: [
          ...managementSnapshot().devices,
          {
            ...managementSnapshot().devices[0],
            deviceId: 'client-phone',
            displayName: 'Phone browser',
            shortId: 'phone',
            authorizationId: 'authorization-phone',
            presence: 'online',
            isCurrent: false,
          },
        ],
      },
    })).not.toThrow()
  })

  it('binds D5 management actions and invitation receipts to Host authority', () => {
    const expected = { hostId: 'host-main', connectionGeneration: 7 }
    const requests: ApplicationMessage[] = [
      { kind: 'request', operation: 'pairing.create', params: { actionId: 'pairing-create-1', expected } },
      {
        kind: 'request',
        operation: 'device.rename',
        params: {
          actionId: 'device-rename-1',
          deviceId: 'client-old',
          authorizationId: 'authorization-old',
          authorizationEpoch: 2,
          displayName: '旧手机',
          expected,
        },
      },
      {
        kind: 'request',
        operation: 'device.revoke',
        params: {
          actionId: 'device-revoke-1',
          deviceId: 'client-old',
          authorizationId: 'authorization-old',
          authorizationEpoch: 2,
          expected,
        },
      },
    ]
    for (const request of requests) {
      expect(decodeApplicationMessage(encodeApplicationMessage(request), 'request')).toEqual(request)
      if (request.kind !== 'request') throw new Error('Unexpected message.')
      const requestActionId = (request.params as { actionId: string }).actionId
      expect(() => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'request', requestId: requestActionId, taskId: undefined }),
        request,
      )).not.toThrow()
      expectCode(() => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'request', requestId: 'wrong-action', taskId: undefined }),
        request,
      ), 'stale-authority')
    }

    const response: ApplicationMessage = {
      kind: 'response',
      operation: 'pairing.create',
      ok: true,
      result: {
        actionId: 'pairing-create-1',
        state: 'accepted',
        invitationFragment: 'cGFpcmluZy1pbnZpdGF0aW9u',
        expiresAt: fixedNow + 120_000,
      },
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(response), 'response')).toEqual(response)
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'response', requestId: 'pairing-create-1', taskId: undefined }),
      response,
    )).not.toThrow()
    expectCode(() => encodeApplicationMessage({
      ...requests[1],
      params: { ...(requests[1] as Extract<ApplicationMessage, { kind: 'request' }>).params, displayName: ' bad ' },
    }), 'schema-invalid')
  })

  it('round-trips exact user text and rejects non-canonical/unknown fields', () => {
    const request = sendRequest()
    const encoded = encodeApplicationMessage(request)
    const decoded = decodeApplicationMessage(encoded, 'request')
    expect(decoded).toEqual(request)
    if (decoded.kind !== 'request' || decoded.operation !== 'turn.send') throw new Error('unexpected request')
    expect(decoded.params.input.input[0]).toEqual({
      type: 'text',
      text: '  中文\r\n```ts\nconst quote = "🙂"\n```  ',
    })
    expectCode(() => decodeApplicationMessage(` ${encoded}`, 'request'), 'schema-invalid')
    expectCode(() => decodeApplicationMessage(encoded.replace('{', '{"__proto__":{},'), 'request'), 'schema-invalid')
  })

  it('round-trips bounded attachment sidecars and rejects broken bindings', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const request = sendRequest()
    if (request.kind !== 'request' || request.operation !== 'turn.send') throw new Error('unexpected request')
    request.params.input.input.push({ type: 'localImage', attachmentId: 'attachment-1', name: 'shot.png' })
    request.params.input.attachments = [{
      attachmentId: 'attachment-1',
      name: 'shot.png',
      mediaType: 'image/png',
      byteLength: bytes.byteLength,
      contentBase64Url: bytes.toString('base64url'),
    }]
    expect(decodeApplicationMessage(encodeApplicationMessage(request), 'request')).toEqual(request)

    const badLength = structuredClone(request)
    if (badLength.kind !== 'request' || badLength.operation !== 'turn.send' || !badLength.params.input.attachments) throw new Error('unexpected request')
    badLength.params.input.attachments[0]!.byteLength += 1
    expectCode(() => encodeApplicationMessage(badLength), 'schema-invalid')

    const orphan = structuredClone(request)
    if (orphan.kind !== 'request' || orphan.operation !== 'turn.send') throw new Error('unexpected request')
    orphan.params.input.input = orphan.params.input.input.filter(input => input.type === 'text')
    expectCode(() => encodeApplicationMessage(orphan), 'schema-invalid')
  })

  it('rejects missing action authority and carrier/body mismatches', () => {
    const request = sendRequest()
    const malformed = structuredClone(request) as Record<string, unknown>
    const params = malformed.params as { input: Record<string, unknown> }
    delete params.input.expected
    expectCode(() => encodeApplicationMessage(malformed), 'schema-invalid')

    expectCode(() => decodeApplicationMessage(encodeApplicationMessage(request), 'response'), 'schema-invalid')
    expectCode(
      () => validateEnvelopeApplicationBinding(envelope({ requestId: 'wrong-action' }), request),
      'stale-authority',
    )
    expectCode(
      () => validateEnvelopeApplicationBinding(envelope({ requestId: 'action-send-1', taskId: 'task-2' }), request),
      'stale-authority',
    )
    expectCode(
      () => validateEnvelopeApplicationBinding(envelope({
        requestId: 'action-send-1',
        hostId: 'host-other',
      }), request),
      'stale-authority',
    )
    expectCode(
      () => validateEnvelopeApplicationBinding(envelope({
        requestId: 'action-send-1',
        connectionGeneration: 8,
      }), request),
      'stale-authority',
    )
  })

  it('validates internally consistent authoritative snapshots and events', () => {
    const message: ApplicationMessage = { kind: 'snapshot', snapshot: snapshot() }
    const encoded = encodeApplicationMessage(message)
    const decoded = decodeApplicationMessage(encoded, 'snapshot')
    expect(decoded).toEqual(message)
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'snapshot', requestId: 'snapshot-1', taskId: 'task-1' }),
      message,
    )).not.toThrow()

    const inconsistent = snapshot()
    inconsistent.task.revision = 2
    expectCode(() => encodeApplicationMessage({ kind: 'snapshot', snapshot: inconsistent }), 'schema-invalid')

    const staleInteractive = snapshot()
    staleInteractive.messages.push({
      id: 'approval-1',
      kind: 'approval',
      createdAt: timestamp,
      title: 'Approve command',
      detail: 'Review locally',
      requestId: 'approval-request-1',
      taskId: 'task-other',
      turnId: 'turn-1',
      hostId: 'host-main',
      connectionGeneration: 7,
      requestNonce: 'nonce-1',
      issuedAt: timestamp,
      expiresAt: '2027-01-15T08:01:00.000Z',
      state: 'pending',
    })
    expectCode(
      () => encodeApplicationMessage({ kind: 'snapshot', snapshot: staleInteractive }),
      'schema-invalid',
    )
    expectCode(
      () => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'snapshot', requestId: 'snapshot-2' }),
        { kind: 'snapshot', snapshot: staleInteractive } as ApplicationMessage,
      ),
      'stale-authority',
    )

    for (const status of ['syncing', 'failed', 'unknown'] as const) {
      const honest = snapshot()
      honest.task.status = status
      delete honest.task.completionReason
      honest.messages[0]!.createdAt = null
      expect(decodeApplicationMessage(encodeApplicationMessage({
        kind: 'snapshot',
        snapshot: honest,
      }), 'snapshot')).toMatchObject({ snapshot: { task: { status }, messages: [{ createdAt: null }] } })
    }
  })

  it('keeps Relay transport acknowledgement distinct from Codex acceptance', () => {
    const queuedResponse: ApplicationMessage = {
      kind: 'response',
      operation: 'turn.send',
      taskId: 'task-1',
      ok: true,
      result: { actionId: 'action-send-1', state: 'queued' },
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(queuedResponse), 'response')).toEqual(queuedResponse)
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'response', requestId: 'action-send-1' }),
      queuedResponse,
    )).not.toThrow()
    expectCode(
      () => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'response', requestId: 'different-action' }),
        queuedResponse,
      ),
      'stale-authority',
    )
    expect(JSON.stringify(queuedResponse)).not.toContain('relayed')
    expect(fixedNow).toBeGreaterThan(0)
  })

  it('enforces strict receipt state unions without ambiguous commit authority', () => {
    const accepted: ApplicationMessage = {
      kind: 'response',
      operation: 'turn.send',
      taskId: 'task-1',
      ok: true,
      result: {
        actionId: 'action-send-1',
        state: 'accepted',
        revision: 4,
        sequence: 10,
        cursor: 'cursor:task-1:10',
      },
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(accepted), 'response')).toEqual(accepted)

    const startAccepted: ApplicationMessage = {
      kind: 'response',
      operation: 'task.start',
      ok: true,
      result: {
        actionId: 'action-start-1',
        state: 'accepted',
        revision: 3,
        sequence: 9,
        cursor: 'cursor:task-1:9',
        task: snapshot().task,
      },
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(startAccepted), 'response')).toEqual(startAccepted)

    const invalidReceipts: unknown[] = [
      { actionId: 'action-1', state: 'queued', revision: 1 },
      { actionId: 'action-1', state: 'queued', rejection: { code: 'offline', message: 'offline' } },
      { actionId: 'action-1', state: 'accepted', rejection: { code: 'offline', message: 'offline' } },
      { actionId: 'action-1', state: 'rejected' },
      {
        actionId: 'action-1',
        state: 'rejected',
        rejection: { code: 'offline', message: 'offline' },
        sequence: 1,
      },
    ]
    for (const result of invalidReceipts) {
      expectCode(() => encodeApplicationMessage({
        kind: 'response',
        operation: 'turn.send',
        taskId: 'task-1',
        ok: true,
        result,
      }), 'schema-invalid')
    }

    for (const result of [
      { actionId: 'action-start-1', state: 'queued', task: snapshot().task },
      {
        actionId: 'action-start-1',
        state: 'rejected',
        rejection: { code: 'offline', message: 'offline' },
        task: snapshot().task,
      },
    ]) {
      expectCode(() => encodeApplicationMessage({
        kind: 'response',
        operation: 'task.start',
        ok: true,
        result,
      }), 'schema-invalid')
    }
  })

  it('requires and carrier-binds taskId on every task-scoped success and failure response', () => {
    const successCases: Array<{ message: ApplicationMessage; requestId: string }> = [
      {
        requestId: 'read-1',
        message: { kind: 'response', operation: 'task.read', taskId: 'task-1', ok: true, result: snapshot() },
      },
      {
        requestId: 'subscribe-1',
        message: {
          kind: 'response',
          operation: 'task.subscribe',
          taskId: 'task-1',
          ok: true,
          result: { mode: 'snapshot' },
        },
      },
      {
        requestId: 'unsubscribe-1',
        message: {
          kind: 'response',
          operation: 'task.unsubscribe',
          taskId: 'task-1',
          ok: true,
          result: { unsubscribed: true },
        },
      },
      ...(['turn.send', 'turn.steer', 'turn.interrupt', 'request.resolve'] as const).map(operation => {
        const requestId = `action-${operation}`
        return {
          requestId,
          message: {
            kind: 'response' as const,
            operation,
            taskId: 'task-1',
            ok: true as const,
            result: { actionId: requestId, state: 'queued' as const },
          },
        }
      }),
    ]

    const failureCases: Array<{ message: ApplicationMessage; requestId: string }> = (
      ['task.read', 'task.subscribe', 'task.unsubscribe', 'turn.send', 'turn.steer', 'turn.interrupt', 'request.resolve'] as const
    ).map(operation => ({
      requestId: `failure-${operation}`,
      message: {
        kind: 'response' as const,
        operation,
        taskId: 'task-1',
        ok: false as const,
        error: { code: 'internal' as const, message: 'Request failed.' },
      },
    }))

    for (const { message, requestId } of [...successCases, ...failureCases]) {
      expect(decodeApplicationMessage(encodeApplicationMessage(message), 'response')).toEqual(message)
      expect(() => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'response', requestId, taskId: 'task-1' }),
        message,
      )).not.toThrow()
      expectCode(
        () => validateEnvelopeApplicationBinding(
          envelope({ messageType: 'response', requestId, taskId: 'task-other' }),
          message,
        ),
        'stale-authority',
      )
      expectCode(
        () => validateEnvelopeApplicationBinding(
          envelope({ messageType: 'response', requestId, taskId: undefined }),
          message,
        ),
        'stale-authority',
      )

      const missingTaskId = structuredClone(message) as Record<string, unknown>
      delete missingTaskId.taskId
      expectCode(() => encodeApplicationMessage(missingTaskId), 'schema-invalid')
    }

    const mismatchedRead = structuredClone(successCases[0]?.message) as Record<string, unknown>
    mismatchedRead.taskId = 'task-other'
    expectCode(() => encodeApplicationMessage(mismatchedRead), 'schema-invalid')

    expectCode(() => encodeApplicationMessage({
      kind: 'response',
      operation: 'workspace.list',
      taskId: 'task-1',
      ok: false,
      error: { code: 'internal', message: 'Request failed.' },
    }), 'schema-invalid')
  })

  it('binds event correlation and session control generation to the carrier', () => {
    const event: ApplicationMessage = {
      kind: 'event',
      eventId: 'event-1',
      event: {
        type: 'connection',
        taskId: 'task-1',
        hostId: 'host-main',
        connectionGeneration: 7,
        revision: 3,
        sequence: 10,
        cursor: 'cursor:task-1:10',
        createdAt: timestamp,
        connection: { hostId: 'host-main', generation: 7, state: 'online' },
      },
    }
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'event', requestId: 'event-1' }),
      event,
    )).not.toThrow()
    expectCode(
      () => validateEnvelopeApplicationBinding(
        envelope({ messageType: 'event', requestId: 'event-2' }),
        event,
      ),
      'stale-authority',
    )

    const confirm: ApplicationMessage = {
      kind: 'control',
      operation: 'session.confirm',
      sessionTranscriptHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      authorizationId: 'authorization-1',
      authorizationEpoch: 1,
      connectionGeneration: 7,
      senderRole: 'client',
    }
    expect(() => validateEnvelopeApplicationBinding(
      envelope({ messageType: 'control', requestId: 'handshake-1', taskId: undefined }),
      confirm,
    )).not.toThrow()
    expectCode(
      () => validateEnvelopeApplicationBinding(
        envelope({
          messageType: 'control',
          requestId: 'handshake-1',
          taskId: undefined,
          connectionGeneration: 8,
        }),
        confirm,
      ),
      'stale-authority',
    )
  })
})
