import { getEstablishedSessionChannelInfo } from '@codex-plus/e2ee'
import { ProtocolViolation } from '@codex-plus/protocol'
import { createTransportCodexServeClient, type CodexServeClient, type PermissionMode } from '@codex-plus/serve-client'
import type {
  CommitInboundFrame,
  OutboundFramePersistenceAdapter,
  SessionAuthority,
  ClientAuthorizationMaterial,
} from '@codex-plus/e2ee'

import {
  createR3LoopbackRelayClientCarrier,
  createR3ProductionRelayClientCarrier,
  type R3RelayClientCarrier,
  type R3RelayClientCarrierError,
} from './relay-carrier.ts'
import {
  establishEphemeralClientSession,
  pairEphemeralClient,
  signEphemeralClientRelayChallenge,
} from './pairing-session-runtime.ts'
import { createRelayCodexServeTransport } from './relay-transport.ts'
import { openBrowserDeviceStore } from './browser-device-store.ts'

export interface EphemeralPairedClient {
  readonly client: CodexServeClient
  readonly permissionModes: readonly PermissionMode[]
  setPageVisible?(visible: boolean): void
  checkConnection?(): Promise<boolean>
  tryResume?(): Promise<boolean>
  onUnexpectedDisconnect(listener: (error: Error) => void): () => void
  close(): Promise<void>
}

function sameAuthority(left: SessionAuthority, right: SessionAuthority): boolean {
  return left.relayOrigin === right.relayOrigin
    && left.hostId === right.hostId
    && left.hostDeviceId === right.hostDeviceId
    && left.clientDeviceId === right.clientDeviceId
    && left.authorizationId === right.authorizationId
    && left.authorizationEpoch === right.authorizationEpoch
    && left.handshakeId === right.handshakeId
    && left.connectionGeneration === right.connectionGeneration
    && left.sessionTranscriptHash === right.sessionTranscriptHash
}

function createEphemeralPersistence(authority: SessionAuthority): Readonly<{
  outbound: OutboundFramePersistenceAdapter
  commitInbound: CommitInboundFrame
  assertActive: (candidate: SessionAuthority) => Promise<void>
  close: () => void
}> {
  let active = true
  let nextOutboundSequence = 2
  let maxSentSequence = 1
  let lastInboundSequence = 1
  let lastPeerAck = 1
  const outboundFrames = new Map<number, string>()
  let outboundFrameBytes = 0

  const requireActive = (candidate: SessionAuthority): void => {
    if (!active || !sameAuthority(candidate, authority)) throw new Error('stale-authority')
  }

  return Object.freeze({
    outbound: {
      async reserveSequence(request) {
        requireActive(request.authority)
        if (request.expectedSequence !== nextOutboundSequence) throw new Error('sequence-gap')
        return nextOutboundSequence++
      },
      async commitFrame(request) {
        requireActive(request.authority)
        if (request.sequence !== maxSentSequence + 1) throw new Error('sequence-gap')
        if (outboundFrames.size >= 16) throw new Error('backpressure')
        const byteLength = new TextEncoder().encode(request.wireText).byteLength
        if (outboundFrameBytes + byteLength > 8 * 1024 * 1024) throw new Error('backpressure')
        outboundFrames.set(request.sequence, request.wireText)
        outboundFrameBytes += byteLength
        maxSentSequence = request.sequence
      },
    },
    async commitInbound(request) {
      requireActive(request.authority)
      if (request.sequence !== lastInboundSequence + 1) throw new Error('sequence-gap')
      if (request.ack < lastPeerAck || request.ack > maxSentSequence) throw new Error('ack-invalid')
      lastInboundSequence = request.sequence
      lastPeerAck = request.ack
      for (const sequence of outboundFrames.keys()) {
        if (sequence <= request.ack) {
          const frame = outboundFrames.get(sequence)
          if (frame !== undefined) outboundFrameBytes -= new TextEncoder().encode(frame).byteLength
          outboundFrames.delete(sequence)
        }
      }
    },
    async assertActive(candidate) {
      requireActive(candidate)
    },
    close() {
      active = false
      outboundFrames.clear()
      outboundFrameBytes = 0
    },
  })
}

function defaultWebSocketUrl(): string {
  const url = new URL('/api/ws', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function deploymentMode(): 'r3-local-test' | 'production' {
  const origin = new URL(window.location.origin)
  if (origin.protocol === 'https:') return 'production'
  if (
    origin.protocol === 'http:'
    && (origin.hostname === '127.0.0.1' || origin.hostname === '[::1]')
    && origin.port !== ''
  ) return 'r3-local-test'
  throw new Error('client-stage:invalid-origin')
}

function pairingStageError(error: unknown): Error {
  if (error instanceof ProtocolViolation) {
    return new Error(`client-stage:${error.code === 'expired' ? 'invitation-expired' : 'invitation-invalid'}`)
  }
  const message = error instanceof Error ? error.message : ''
  if (message === 'pair-expired') return new Error('client-stage:invitation-expired')
  if (message === 'pair-denied') return new Error('client-stage:pairing-denied')
  if (
    message === 'pair-timeout'
    || message === 'pair-connect-failed'
    || message === 'pair-socket-error'
    || message === 'pair-socket-closed'
    || message === 'pair-session-unavailable'
  ) return new Error('client-stage:pairing-unavailable')
  return new Error('client-stage:invitation-invalid')
}

export async function createEphemeralPairedClient(input: Readonly<{
  invitationFragment: string
  onStage?: (stage: 'pairing' | 'authenticating' | 'establishing-session') => void
  onConfirmation?: (confirmation: Readonly<{
    sas: string
    clientSigningFingerprint: string
  }>) => void
}>): Promise<EphemeralPairedClient> {
  const expectedRelayOrigin = window.location.origin
  const mode = deploymentMode()
  let deviceStore: Awaited<ReturnType<typeof openBrowserDeviceStore>> | undefined
  try {
    deviceStore = mode === 'production' ? await openBrowserDeviceStore() : undefined
  } catch {
    throw new Error('client-stage:storage-unavailable')
  }
  let authorization: ClientAuthorizationMaterial
  try {
    if (input.invitationFragment !== '') {
      input.onStage?.('pairing')
      let paired: Awaited<ReturnType<typeof pairEphemeralClient>>
      try {
        paired = await pairEphemeralClient({
          mode,
          invitationFragment: input.invitationFragment,
          expectedRelayOrigin,
          webSocketUrl: defaultWebSocketUrl(),
          deviceDisplayName: 'Codex Plus Web',
          clearInvitationFragment: () => {
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
          },
          ...(input.onConfirmation === undefined ? {} : { onConfirmation: input.onConfirmation }),
        })
      } catch (error) {
        throw pairingStageError(error)
      }
      authorization = paired.authorization
      await deviceStore?.saveAuthorization(expectedRelayOrigin, authorization)
    } else {
      if (deviceStore === undefined) throw new Error('client-stage:unpaired')
      const restored = await deviceStore.loadAuthorization(expectedRelayOrigin)
      if (restored === undefined) throw new Error('client-stage:unpaired')
      // A fresh handshake installs a higher generation and activateSession marks
      // the prior session superseded. Its raw frames remain evidence only and are
      // never read or resent by this reconnect path.
      authorization = restored
    }
  } catch (error) {
    deviceStore?.close()
    throw error
  }
  const claims = authorization.grantClaims
  input.onStage?.('authenticating')
  const carrierOptions = {
    mode,
    webSocketUrl: defaultWebSocketUrl(),
    relayOrigin: expectedRelayOrigin,
    hostId: claims.hostId,
    hostDeviceId: claims.hostDeviceId,
    clientDeviceId: claims.clientDeviceId,
    authorizationId: claims.authorizationId,
    authorizationEpoch: claims.authorizationEpoch,
    signChallenge: (canonicalInput: Uint8Array) => signEphemeralClientRelayChallenge(
      authorization,
      canonicalInput,
    ),
  } as const
  const createCarrier = (): R3RelayClientCarrier => mode === 'production'
    ? createR3ProductionRelayClientCarrier({ ...carrierOptions, mode: 'production' })
    : createR3LoopbackRelayClientCarrier({ ...carrierOptions, mode: 'r3-local-test' })
  let carrier = createCarrier()
  try {
    await carrier.connect()
    input.onStage?.('establishing-session')
    const channel = await establishEphemeralClientSession({
      authorization,
      carrier,
      ...(deviceStore === undefined
        ? {}
        : { installGeneration: request => deviceStore.installGeneration(request) }),
    })
    const info = getEstablishedSessionChannelInfo(channel)
    const persistence = deviceStore === undefined
      ? createEphemeralPersistence(info.authority)
      : await deviceStore.activateSession(info)
    const transport = createRelayCodexServeTransport({
      channel,
      carrier,
      assertAuthorizationActive: persistence.assertActive,
      outboundPersistence: persistence.outbound,
      commitInbound: persistence.commitInbound,
    })
    const client = createTransportCodexServeClient(transport)
    let closed = false
    const verifySession = async (): Promise<boolean> => {
      if (closed) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          client.listWorkspaces().then(() => true, () => false),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_500) }),
        ])
      } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    return Object.freeze({
      client,
      permissionModes: Object.freeze([...claims.remotePermissionModes]),
      setPageVisible(visible: boolean) {
        carrier.setPageVisible?.(visible)
        transport.setPageVisible(visible)
      },
      async checkConnection() {
        if (closed || !(await carrier.ping?.())) return false
        return verifySession()
      },
      async tryResume() {
        if (closed || !transport.canResume()) return false
        const next = createCarrier()
        try {
          await carrier.close()
          await next.connect()
          if (closed) { await next.close(); return false }
          transport.replaceCarrier(next)
          carrier = next
          return await verifySession()
        } catch {
          await next.close().catch(() => undefined)
          return false
        }
      },
      onUnexpectedDisconnect(listener: (error: Error) => void) {
        let notified = false
        const notify = (error: Error) => { if (!notified) { notified = true; listener(error) } }
        const offCarrier = carrier.onUnexpectedDisconnect(notify)
        try {
          const offTransport = transport.onUnexpectedDisconnect(notify)
          return () => { offCarrier(); offTransport() }
        } catch (error) {
          offCarrier()
          throw error
        }
      },
      async close() {
        closed = true
        transport.close()
        if ('close' in persistence) persistence.close()
        await carrier.close()
        deviceStore?.close()
      },
    })
  } catch (error) {
    await carrier.close().catch(() => undefined)
    deviceStore?.close()
    throw error
  }
}
