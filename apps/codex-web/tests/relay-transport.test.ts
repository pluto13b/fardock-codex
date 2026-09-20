import { describe, expect, it } from 'vitest'

import type {
  ActionReceipt,
  ManagementSnapshot,
  SendTurnInput,
  TaskSnapshot,
  TaskSummary,
  WorkspaceSummary,
} from '@codex-plus/serve-client'
import {
  acceptClientSessionConfirm,
  acceptHostSessionReady,
  approveHostPairing,
  createClientPairJoin,
  createClientSessionConfirm,
  createClientSessionInit,
  createHostPairingInvitation,
  createHostSessionAccept,
  createHostSessionReady,
  deriveClientSessionAfterGenerationCommit,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  getEstablishedSessionChannelInfo,
  openClientPairResult,
  openEstablishedApplication,
  openHostPairJoin,
  sealEstablishedApplication,
  validateSessionAcceptForClient,
  validateSessionInitForHost,
  type EstablishedSessionChannel,
  type OutboundFramePersistenceAdapter,
} from '@codex-plus/e2ee'
import {
  decodeEnvelope,
  PROTOCOL_VERSION,
  type ApplicationRequest,
  type ApplicationResponse,
  type EnvelopeHeader,
  type RelayReceipt,
} from '@codex-plus/protocol'

import {
  RelayCodexServeTransportError,
  createRelayCodexServeTransport,
  type RelayEnvelopeCarrier,
} from '../src/relay-transport.ts'

const NOW = 1_800_000_000_000
const RELAY_ORIGIN = 'https://relay.example.test'

const persistence: OutboundFramePersistenceAdapter = {
  async reserveSequence({ expectedSequence }) {
    return expectedSequence
  },
  async commitFrame() {},
}

async function establishChannels(): Promise<{
  client: EstablishedSessionChannel
  host: EstablishedSessionChannel
}> {
  const [hostAgreement, hostSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const invitation = await createHostPairingInvitation({
    relayOrigin: RELAY_ORIGIN,
    hostId: 'host.web',
    hostDeviceId: 'device.windows',
    hostAgreementPublicKey: hostAgreement.publicKey,
    hostSigningPrivateKey: hostSigning.privateKey,
    hostSigningPublicKey: hostSigning.publicKey,
    now: NOW,
    clock: () => NOW + 200,
  })
  const join = await createClientPairJoin({
    invitationFragment: invitation.invitationFragment,
    expectedRelayOrigin: RELAY_ORIGIN,
    deviceDisplayName: 'Web test client',
    now: NOW + 100,
  })
  const openedJoin = await openHostPairJoin({
    invitation: invitation.handle,
    attemptId: 'attempt.web',
    wireFrame: join.wireText,
    now: NOW + 200,
  })
  if (openedJoin.outcome !== 'pending-confirmation') throw new Error('Pairing failed.')
  const approval = await approveHostPairing({
    confirmation: openedJoin.confirmation,
    persistenceAdapter: {
      async commitAuthorizationAndUpsertRelay() {
        return { relayRevision: 1, nextGeneration: 1 }
      },
    },
    now: NOW + 300,
  })
  const grant = await openClientPairResult(join.handle, approval.wireText, NOW + 301)
  if (grant.outcome !== 'approved') throw new Error('Grant failed.')
  const init = await createClientSessionInit({
    authorization: { status: 'active', ...grant.authorization },
    now: NOW + 400,
    expiresAt: NOW + 20_000,
  })
  const hostValidated = await validateSessionInitForHost({
    authorization: {
      status: 'active',
      grantClaims: approval.authorization.grantClaims,
      grantClaimsHash: approval.authorization.grantClaimsHash,
      hostGrantSignature: approval.authorization.hostGrantSignature,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPublicKey: hostSigning.publicKey,
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostSigningPrivateKey: hostSigning.privateKey,
    },
    frame: init.frame,
    now: NOW + 401,
    reserveGeneration: async () => 1,
  })
  const hostAwaiting = await createHostSessionAccept({
    state: hostValidated,
    now: NOW + 402,
    expiresAt: NOW + 15_000,
  })
  const clientValidated = await validateSessionAcceptForClient({
    state: init,
    frame: hostAwaiting.frame,
    now: NOW + 403,
    installGeneration: async () => 0,
  })
  const clientAwaiting = await deriveClientSessionAfterGenerationCommit({
    state: clientValidated,
  })
  const confirm = await createClientSessionConfirm({
    state: clientAwaiting,
    now: NOW + 404,
    expiresAt: NOW + 10_000,
  })
  const hostConfirmed = await acceptClientSessionConfirm({
    state: hostAwaiting,
    frame: confirm.wireText,
    now: NOW + 405,
  })
  const ready = await createHostSessionReady({
    state: hostConfirmed,
    now: NOW + 406,
    expiresAt: NOW + 10_000,
  })
  return {
    host: ready.channel,
    client: await acceptHostSessionReady({
      state: clientAwaiting,
      frame: ready.ready.wireText,
      now: NOW + 407,
    }),
  }
}

class InMemoryCarrier implements RelayEnvelopeCarrier {
  private listener: ((frame: string | Uint8Array) => void | Promise<void>) | undefined
  private hostTail: Promise<void> = Promise.resolve()
  hostHandler: (frame: string | Uint8Array) => Promise<void> = async () => {}
  readonly receipts: RelayReceipt[] = []

  async sendEnvelope(frame: string | Uint8Array): Promise<RelayReceipt> {
    const envelope = decodeEnvelope(frame, { now: NOW + 500 })
    const receipt: RelayReceipt = {
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: envelope.connectionGeneration,
      requestId: envelope.requestId,
      seq: envelope.seq,
      state: 'relayed',
    }
    this.receipts.push(receipt)
    this.hostTail = this.hostTail.then(() => this.hostHandler(frame))
    return receipt
  }

  subscribe(
    listener: (frame: string | Uint8Array) => void | Promise<void>,
  ): () => void {
    if (this.listener !== undefined) throw new Error('Only one listener is allowed.')
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  async deliverToClient(frame: string | Uint8Array): Promise<void> {
    if (this.listener === undefined) throw new Error('Client is not subscribed.')
    await this.listener(frame)
  }

  async idle(): Promise<void> {
    await this.hostTail
  }
}

function fixtures(generation: number): {
  management: ManagementSnapshot
  workspace: WorkspaceSummary
  task: TaskSummary
  snapshot: TaskSnapshot
} {
  const workspace: WorkspaceSummary = {
    id: 'workspace.web',
    name: 'Web workspace',
    pathLabel: 'Workspace / Web',
    hostId: 'host.web',
    connectionGeneration: generation,
    connection: 'online',
    capabilities: { startTask: false },
  }
  const management: ManagementSnapshot = {
    generatedAt: NOW,
    hostId: workspace.hostId,
    connectionGeneration: generation,
    layers: {
      gateway: 'healthy',
      relaySocket: 'authenticated',
      host: 'online',
      e2ee: 'ready',
      companion: 'online',
      appServer: 'compatible',
    },
    devices: [{
      deviceId: 'client.web',
      displayName: 'Web test client',
      shortId: 'client',
      signingFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      authorizationId: 'authorization.web',
      authorizationEpoch: 1,
      status: 'active',
      presence: 'online',
      pairedAt: NOW - 1_000,
      lastSeenAt: NOW,
      isCurrent: true,
    }],
    events: [{ eventId: 'manage.web', category: 'host', state: 'online', occurredAt: NOW }],
  }
  const task: TaskSummary = {
    id: 'task.web',
    workspaceId: workspace.id,
    title: 'Remote transport',
    status: 'completed',
    updatedAt: new Date(NOW).toISOString(),
    revision: 7,
    completionReason: 'completed',
  }
  const snapshot: TaskSnapshot = {
    authoritative: true,
    host: { hostId: 'host.web', generation, state: 'online' },
    revision: task.revision,
    sequence: 11,
    cursor: 'cursor.web.11',
    capabilities: {
      sendTurn: true,
      steerTurn: false,
      interruptTurn: false,
      resolveApproval: false,
      answerQuestion: false,
    },
    task,
    workspace,
    model: 'gpt-5',
    effort: 'high',
    permission: 'ask',
    messages: [],
    sources: [],
  }
  return { management, workspace, task, snapshot }
}

function responseFor(
  request: ApplicationRequest,
  values: ReturnType<typeof fixtures>,
): ApplicationResponse {
  switch (request.operation) {
    case 'manage.read':
      return { kind: 'response', operation: request.operation, ok: true, result: values.management }
    case 'pairing.create':
      return {
        kind: 'response', operation: request.operation, ok: true,
        result: {
          actionId: request.params.actionId,
          state: 'accepted',
          invitationFragment: 'cGFpcmluZw',
          expiresAt: NOW + 120_000,
        },
      }
    case 'device.rename':
      return { kind: 'response', operation: request.operation, ok: true, result: { actionId: request.params.actionId, state: 'accepted' } }
    case 'device.revoke':
      return { kind: 'response', operation: request.operation, ok: true, result: { actionId: request.params.actionId, state: 'accepted' } }
    case 'workspace.list':
      return { kind: 'response', operation: request.operation, ok: true, result: [values.workspace] }
    case 'task.list':
      return { kind: 'response', operation: request.operation, ok: true, result: { tasks: [values.task] } }
    case 'task.read':
      return {
        kind: 'response',
        operation: request.operation,
        taskId: request.params.taskId,
        ok: true,
        result: values.snapshot,
      }
    case 'turn.send': {
      const result: ActionReceipt = {
        actionId: request.params.input.actionId,
        state: 'accepted',
        revision: values.task.revision + 1,
        sequence: values.snapshot.sequence + 1,
        cursor: 'cursor.web.12',
      }
      return {
        kind: 'response',
        operation: request.operation,
        taskId: request.params.taskId,
        ok: true,
        result,
      }
    }
    case 'turn.interrupt':
      return {
        kind: 'response', operation: request.operation, taskId: request.params.taskId, ok: true,
        result: { actionId: request.params.input.actionId, state: 'accepted', revision: values.task.revision + 1 },
      }
    case 'request.resolve':
      return {
        kind: 'response', operation: request.operation, taskId: request.params.taskId, ok: true,
        result: { actionId: request.params.actionId, state: 'accepted' },
      }
    default:
      throw new Error(`Unsupported Host test operation: ${request.operation}`)
  }
}

async function createHarness(options?: {
  beforeResponse?: (request: ApplicationRequest) => Promise<void>
  outboundPersistence?: OutboundFramePersistenceAdapter
  requestTimeoutMs?: number
  response?: (
    request: ApplicationRequest,
    values: ReturnType<typeof fixtures>,
  ) => ApplicationResponse
}) {
  const channels = await establishChannels()
  const hostInfo = getEstablishedSessionChannelInfo(channels.host)
  const values = fixtures(hostInfo.authority.connectionGeneration)
  const carrier = new InMemoryCarrier()
  const requests: ApplicationRequest[] = []
  let querySequence = 0
  const relayReceipts: RelayReceipt[] = []
  const transport = createRelayCodexServeTransport({
    channel: channels.client,
    carrier,
    assertAuthorizationActive: async () => {},
    outboundPersistence: options?.outboundPersistence ?? persistence,
    commitInbound: async () => {},
    now: () => NOW + 500,
    createRequestId: () => `request.web.${++querySequence}`,
    requestTimeoutMs: options?.requestTimeoutMs ?? 2_000,
    onRelayReceipt: receipt => relayReceipts.push(receipt as RelayReceipt),
  })

  carrier.hostHandler = async frame => {
    const opened = await openEstablishedApplication({
      state: channels.host,
      frame,
      now: NOW + 500,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    if (opened.message.kind !== 'request') throw new Error('Expected request.')
    requests.push(opened.message)
    await options?.beforeResponse?.(opened.message)
    const response = options?.response?.(opened.message, values)
      ?? responseFor(opened.message, values)
    const sentAt = NOW + 501
    const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: hostInfo.authority.connectionGeneration,
      fromDeviceId: hostInfo.authority.hostDeviceId,
      toDeviceId: hostInfo.authority.clientDeviceId,
      hostId: hostInfo.authority.hostId,
      keyId: hostInfo.outboundKeyId,
      requestId: opened.envelope.requestId,
      ...(
        response.operation === 'manage.read'
        || response.operation === 'pairing.create'
        || response.operation === 'device.rename'
        || response.operation === 'device.revoke'
        || response.operation === 'workspace.list'
        || response.operation === 'task.list'
        ? {}
        : { taskId: 'taskId' in response ? response.taskId : opened.envelope.taskId }),
      sentAt,
      expiresAt: sentAt + 30_000,
      messageType: 'response',
    }
    const sealed = await sealEstablishedApplication({
      state: channels.host,
      header,
      message: response,
      now: sentAt,
      assertAuthorizationActive: async () => {},
      persistence,
    })
    await carrier.deliverToClient(sealed.wireText)
  }

  return { carrier, relayReceipts, requests, transport, values }
}

describe('RelayCodexServeTransport', () => {
  it('keeps the encrypted generation and advances sequence after replacing an idle carrier', async () => {
    const harness = await createHarness()
    await harness.transport.request({ operation: 'workspace.list' })
    await harness.carrier.idle()
    expect(harness.transport.canResume()).toBe(true)
    const resumedFrames: ReturnType<typeof decodeEnvelope>[] = []
    harness.transport.replaceCarrier({
      subscribe: listener => harness.carrier.subscribe(listener),
      sendEnvelope: frame => {
        resumedFrames.push(decodeEnvelope(frame, { now: NOW + 500 }))
        return harness.carrier.sendEnvelope(frame)
      },
    })
    await harness.transport.request({ operation: 'task.read', taskId: 'task.web' })
    expect(resumedFrames).toHaveLength(1)
    expect(resumedFrames[0]).toMatchObject({ connectionGeneration: 1, seq: 3, ack: 2 })
    expect(harness.requests.map(request => request.operation)).toEqual(['workspace.list', 'task.read'])
    harness.transport.close()
    expect(harness.transport.canResume()).toBe(false)
  })

  it('does not replace a carrier while a dispatched request remains unconfirmed', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const received = new Promise<void>(resolve => { entered = resolve })
    const harness = await createHarness({ beforeResponse: async () => { entered(); await gate } })
    const pending = harness.transport.request({ operation: 'workspace.list' })
    await received
    expect(harness.transport.canResume()).toBe(false)
    expect(() => harness.transport.replaceCarrier(harness.carrier)).toThrow('closed')
    release()
    await pending
    await harness.carrier.idle()
    expect(harness.transport.canResume()).toBe(true)
    harness.transport.close()
  })

  it('blocks hidden page operations before sealing and lets an outstanding reply settle after suspension', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const received = new Promise<void>(resolve => { entered = resolve })
    const harness = await createHarness({ requestTimeoutMs: 100, beforeResponse: async () => { entered(); await gate } })
    const pending = harness.transport.request({ operation: 'workspace.list' })
    await received
    harness.transport.setPageVisible(false)
    await expect(harness.transport.request({ operation: 'task.read', taskId: 'task.web' })).rejects.toMatchObject({ code: 'page-suspended' })
    await new Promise(resolve => setTimeout(resolve, 150))
    release()
    await expect(pending).resolves.toMatchObject({ operation: 'workspace.list' })
    await harness.carrier.idle()
    harness.transport.setPageVisible(true)
    expect(harness.carrier.receipts).toHaveLength(1)
    expect(harness.transport.canResume()).toBe(true)
    harness.transport.close()
  })

  it('serializes concurrent reads and maps the five ready-channel operations', async () => {
    const harness = await createHarness()
    const [management, workspaces, page] = await Promise.all([
      harness.transport.request({ operation: 'manage.read' }),
      harness.transport.request({ operation: 'workspace.list' }),
      harness.transport.request({ operation: 'task.list', cursor: 'cursor.page.1' }),
    ])
    const read = await harness.transport.request({ operation: 'task.read', taskId: 'task.web' })
    const exactText = '  中文第一行\n```ts\nconst emoji = "🙂"\n```\n尾部空格  '
    const input: SendTurnInput = {
      actionId: 'action.web.unicode',
      input: [{ type: 'text', text: exactText }],
      settings: { model: 'gpt-5', effort: 'high', permission: 'ask' },
      expected: { hostId: 'host.web', connectionGeneration: 1, revision: 7 },
    }
    const sent = await harness.transport.request({
      operation: 'turn.send',
      taskId: 'task.web',
      input,
    })

    expect(management).toEqual({ operation: 'manage.read', value: harness.values.management })
    expect(workspaces).toEqual({ operation: 'workspace.list', value: [harness.values.workspace] })
    expect(page).toEqual({ operation: 'task.list', value: { tasks: [harness.values.task] } })
    expect(read).toEqual({ operation: 'task.read', taskId: 'task.web', value: harness.values.snapshot })
    expect(sent).toMatchObject({
      operation: 'turn.send',
      taskId: 'task.web',
      value: { state: 'accepted', actionId: input.actionId },
    })
    expect(harness.requests.map(request => request.operation)).toEqual([
      'manage.read',
      'workspace.list',
      'task.list',
      'task.read',
      'turn.send',
    ])
    const turn = harness.requests[4]
    expect(turn?.operation).toBe('turn.send')
    if (turn?.operation !== 'turn.send') throw new Error('Missing turn request.')
    expect(turn.params.input.input).toEqual([{ type: 'text', text: exactText }])
    expect(harness.relayReceipts).toHaveLength(5)
    harness.transport.close()
  })

  it('maps D5 device, interrupt, and live-request actions without treating Relay receipt as success', async () => {
    const harness = await createHarness()
    const expectedHost = { hostId: 'host.web', connectionGeneration: 1 }
    const pairing = await harness.transport.request({
      operation: 'pairing.create', input: { actionId: 'pairing.web', expected: expectedHost },
    })
    const rename = await harness.transport.request({
      operation: 'device.rename',
      input: {
        actionId: 'rename.web', deviceId: 'client.old', authorizationId: 'authorization.old',
        authorizationEpoch: 1, displayName: '旧手机', expected: expectedHost,
      },
    })
    const revoke = await harness.transport.request({
      operation: 'device.revoke',
      input: {
        actionId: 'revoke.web', deviceId: 'client.old', authorizationId: 'authorization.old',
        authorizationEpoch: 1, expected: expectedHost,
      },
    })
    const expectedTask = { ...expectedHost, revision: 7 }
    const interrupt = await harness.transport.request({
      operation: 'turn.interrupt', taskId: 'task.web',
      input: { actionId: 'interrupt.web', turnId: 'turn.web', expected: expectedTask },
    })
    const resolved = await harness.transport.request({
      operation: 'request.resolve',
      request: {
        type: 'approval', actionId: 'resolve.web', decision: 'deny',
        requestId: 'live.web', requestNonce: 'nonce.web', taskId: 'task.web', turnId: 'turn.web',
        hostId: 'host.web', connectionGeneration: 1,
        issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString(),
        expected: expectedTask,
      },
    })
    expect(pairing).toMatchObject({ operation: 'pairing.create', value: { state: 'accepted' } })
    expect(rename).toMatchObject({ operation: 'device.rename', value: { state: 'accepted' } })
    expect(revoke).toMatchObject({ operation: 'device.revoke', value: { state: 'accepted' } })
    expect(interrupt).toMatchObject({ operation: 'turn.interrupt', taskId: 'task.web', value: { state: 'accepted' } })
    expect(resolved).toMatchObject({ operation: 'request.resolve', taskId: 'task.web', value: { state: 'accepted' } })
    expect(harness.relayReceipts).toHaveLength(5)
    expect(harness.requests.map(request => request.operation)).toEqual([
      'pairing.create', 'device.rename', 'device.revoke', 'turn.interrupt', 'request.resolve',
    ])
    harness.transport.close()
  })

  it('records relayed but waits for an encrypted ApplicationResponse', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const harness = await createHarness({ beforeResponse: async () => await gate })
    const pending = harness.transport.request({ operation: 'workspace.list' })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    for (let attempt = 0; harness.relayReceipts.length === 0 && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(harness.relayReceipts[0]?.state).toBe('relayed')
    expect(settled).toBe(false)
    release()
    await expect(pending).resolves.toMatchObject({ operation: 'workspace.list' })
    harness.transport.close()
  })

  it('fails closed without sending a queued turn when the leading seal times out', async () => {
    let releaseSeal!: () => void
    let markSealEntered!: () => void
    const sealGate = new Promise<void>(resolve => {
      releaseSeal = resolve
    })
    const sealEntered = new Promise<void>(resolve => {
      markSealEntered = resolve
    })
    let reservations = 0
    const outboundPersistence: OutboundFramePersistenceAdapter = {
      async reserveSequence({ expectedSequence }) {
        reservations += 1
        markSealEntered()
        await sealGate
        return expectedSequence
      },
      async commitFrame() {},
    }
    const harness = await createHarness({ outboundPersistence, requestTimeoutMs: 50 })
    const first = harness.transport.request({ operation: 'workspace.list' })
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'request-timeout' })
    await sealEntered
    const queuedTurn = harness.transport.request({
      operation: 'turn.send',
      taskId: 'task.web',
      input: {
        actionId: 'action.web.queued-timeout',
        input: [{ type: 'text', text: 'must not be sent' }],
        settings: { model: 'gpt-5', effort: 'high', permission: 'ask' },
        expected: { hostId: 'host.web', connectionGeneration: 1, revision: 7 },
      },
    })
    const queuedAssertion = expect(queuedTurn).rejects.toMatchObject({ code: 'request-timeout' })

    await Promise.all([firstAssertion, queuedAssertion])
    expect(reservations).toBe(1)
    expect(harness.carrier.receipts).toHaveLength(0)
    releaseSeal()
    await harness.carrier.idle()
    expect(reservations).toBe(1)
    expect(harness.requests).toEqual([])
    expect(harness.carrier.receipts).toHaveLength(0)
  })

  it('fails closed with an unknown outcome when a turn times out after sealing starts', async () => {
    let releaseSeal!: () => void
    let markSealEntered!: () => void
    const sealGate = new Promise<void>(resolve => {
      releaseSeal = resolve
    })
    const sealEntered = new Promise<void>(resolve => {
      markSealEntered = resolve
    })
    const outboundPersistence: OutboundFramePersistenceAdapter = {
      async reserveSequence({ expectedSequence }) {
        markSealEntered()
        await sealGate
        return expectedSequence
      },
      async commitFrame() {},
    }
    const harness = await createHarness({ outboundPersistence, requestTimeoutMs: 50 })
    const failures: Error[] = []
    harness.transport.onUnexpectedDisconnect(error => failures.push(error))
    const turn = harness.transport.request({
      operation: 'turn.send',
      taskId: 'task.web',
      input: {
        actionId: 'action.web.sealing-timeout',
        input: [{ type: 'text', text: 'outcome may be unknown' }],
        settings: { model: 'gpt-5', effort: 'high', permission: 'ask' },
        expected: { hostId: 'host.web', connectionGeneration: 1, revision: 7 },
      },
    })
    const turnAssertion = expect(turn).rejects.toMatchObject({ code: 'outcome-unknown' })
    await sealEntered
    await turnAssertion
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ code: 'outcome-unknown' })
    await expect(harness.transport.request({ operation: 'workspace.list' })).rejects.toMatchObject({
      code: 'closed',
    })
    releaseSeal()
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.carrier.receipts).toHaveLength(0)
  })

  it('bounds pending unary requests at sixteen', async () => {
    let releaseSeal!: () => void
    let markSealEntered!: () => void
    const sealGate = new Promise<void>(resolve => {
      releaseSeal = resolve
    })
    const sealEntered = new Promise<void>(resolve => {
      markSealEntered = resolve
    })
    let reservations = 0
    const outboundPersistence: OutboundFramePersistenceAdapter = {
      async reserveSequence({ expectedSequence }) {
        reservations += 1
        markSealEntered()
        await sealGate
        return expectedSequence
      },
      async commitFrame() {},
    }
    const harness = await createHarness({ outboundPersistence })
    const pending = Array.from({ length: 16 }, () => (
      harness.transport.request({ operation: 'workspace.list' })
    ))
    const settled = Promise.allSettled(pending)
    await sealEntered

    await expect(harness.transport.request({ operation: 'workspace.list' })).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    expect(reservations).toBe(1)
    expect(harness.carrier.receipts).toHaveLength(0)

    harness.transport.close()
    releaseSeal()
    await settled
    expect(harness.carrier.receipts).toHaveLength(0)
  })

  it('fails closed on an authenticated response operation mismatch', async () => {
    const harness = await createHarness({
      response: (_request, values) => ({
        kind: 'response',
        operation: 'task.list',
        ok: true,
        result: { tasks: [values.task] },
      }),
    })

    await expect(harness.transport.request({ operation: 'workspace.list' })).rejects.toMatchObject({
      name: 'RelayCodexServeTransportError',
      code: 'response-mismatch',
    })
    await expect(harness.transport.request({ operation: 'task.list' })).rejects.toEqual(
      new RelayCodexServeTransportError('closed'),
    )
  })

  it('rejects the unsupported stream operation before sending', async () => {
    const harness = await createHarness()
    const stream = harness.transport.stream({ operation: 'task.subscribe', taskId: 'task.web' })
    await expect(stream.next()).rejects.toMatchObject({ code: 'unsupported-operation' })
    expect(harness.carrier.receipts).toHaveLength(0)
    harness.transport.close()
  })
})
