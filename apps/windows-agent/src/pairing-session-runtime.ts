import {
  acceptClientSessionConfirm,
  approveHostPairing,
  createHostPairingInvitation,
  createHostSessionAccept,
  createHostSessionReady,
  exportPublicJwk,
  fingerprintP256PublicKey,
  invalidateEstablishedSession,
  openHostPairJoin,
  prepareHostPairingDenial,
  validateSessionInitForHost,
  E2eeError,
  type CreatedHostPairingInvitation,
  type EstablishedSessionChannel,
  type HostAuthorizationMaterial,
  type HostPairingConfirmation,
  type HostSessionAuthorization,
  type ReserveHostGeneration,
} from '../../../packages/e2ee/src/index.ts'
import {
  PROTOCOL_VERSION,
  ProtocolViolation,
  decodePairJoinFrame,
  type RelayPairClaim,
  type RelayPairCloseReason,
} from '../../../packages/protocol/src/index.ts'

import type { R3RelayHostClient } from './relay-host-client.ts'

export interface LocalPairingDecision {
  readonly decision: 'approve' | 'deny'
}

export function classifySessionAcceptFailure(error: unknown): string {
  if (error instanceof ProtocolViolation) return `protocol-${error.code}`
  if (error instanceof E2eeError) return `e2ee-${error.code}`
  return 'unknown'
}

export interface EphemeralHostPairingRuntimeOptions {
  readonly relayClient: R3RelayHostClient
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly hostAgreementPrivateKey: CryptoKey
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostSigningPrivateKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
  readonly requestLocalDecision: (
    confirmation: Readonly<{
      deviceDisplayName: string
      sas: string
      clientSigningFingerprint: string
      expiresAt: number
    }>,
  ) => Promise<LocalPairingDecision>
  readonly commitAuthorizationLocally: (
    authorization: HostAuthorizationMaterial,
  ) => Promise<Readonly<{
    hostAuthorizationRevision: number
    nextGeneration: number
  }>>
  readonly initialAuthorization?: HostAuthorizationMaterial
  readonly initialNextGeneration?: number
  readonly reserveGeneration?: ReserveHostGeneration
  readonly onReady?: (channel: EstablishedSessionChannel) => void | Promise<void>
  readonly onPairingCompleted?: () => void
  readonly onSessionReplacing?: (channel: EstablishedSessionChannel | undefined) => void | Promise<void>
  readonly remotePermissionModes?: readonly ['ask', 'read-only'] | readonly ['ask', 'read-only', 'full-access']
  readonly now?: () => number
}

export interface EphemeralHostPairingRuntime {
  createInvitation(options?: Readonly<{ requireLocalDecision?: boolean }>): Promise<CreatedHostPairingInvitation>
  cancelInvitation(pairSessionId: string): Promise<void>
  handlePairJoin(frame: string | Uint8Array): Promise<void>
  handleSessionInit(frame: string | Uint8Array): Promise<void>
  handleSessionEnvelope(frame: string | Uint8Array): Promise<void>
  readyChannel(): EstablishedSessionChannel | undefined
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid-runtime-state')
  return value
}

function closeFrame(
  hostId: string,
  hostDeviceId: string,
  pairSessionId: string,
  reason: RelayPairCloseReason,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'pair.close' as const,
    hostId,
    hostDeviceId,
    pairSessionId,
    reason,
  }
}

export function createEphemeralHostPairingRuntime(
  options: EphemeralHostPairingRuntimeOptions,
): EphemeralHostPairingRuntime {
  const now = options.now ?? Date.now
  if (
    (options.initialAuthorization === undefined) !== (options.initialNextGeneration === undefined)
    || (options.reserveGeneration !== undefined && typeof options.reserveGeneration !== 'function')
  ) throw new Error('invalid-runtime-state')
  let invitation: CreatedHostPairingInvitation | undefined
  let invitationRequiresLocalDecision = true
  let authorization: HostAuthorizationMaterial | undefined = options.initialAuthorization
  let nextGeneration = options.initialNextGeneration ?? 0
  let awaitingConfirm: Awaited<ReturnType<typeof createHostSessionAccept>> | undefined
  let established: EstablishedSessionChannel | undefined
  let busyPair = false
  let busySession = false

  const hostSessionAuthorization = (): HostSessionAuthorization => {
    if (authorization === undefined) throw new Error('authorization-unavailable')
    return {
      status: 'active',
      grantClaims: authorization.grantClaims,
      grantClaimsHash: authorization.grantClaimsHash,
      hostGrantSignature: authorization.hostGrantSignature,
      hostAgreementPublicKey: options.hostAgreementPublicKey,
      hostSigningPublicKey: options.hostSigningPublicKey,
      hostAgreementPrivateKey: options.hostAgreementPrivateKey,
      hostSigningPrivateKey: options.hostSigningPrivateKey,
    }
  }

  return {
    async createInvitation(createOptions = {}) {
      const at = now()
      if (invitation !== undefined && !busyPair && invitation.handle.expiresAt <= at) {
        invitation = undefined
        invitationRequiresLocalDecision = true
      }
      if (invitation !== undefined || busyPair) {
        throw new Error('pairing-already-started')
      }
      busyPair = true
      try {
      invitation = await createHostPairingInvitation({
        relayOrigin: options.relayOrigin,
        hostId: options.hostId,
        hostDeviceId: options.hostDeviceId,
        hostAgreementPublicKey: options.hostAgreementPublicKey,
        hostSigningPrivateKey: options.hostSigningPrivateKey,
        hostSigningPublicKey: options.hostSigningPublicKey,
        now: at,
        clock: now,
      })
      await options.relayClient.openPairSession({
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'pair.open',
        hostId: options.hostId,
        hostDeviceId: options.hostDeviceId,
        pairSessionId: invitation.handle.pairSessionId,
        expiresAt: invitation.handle.expiresAt,
      })
      invitationRequiresLocalDecision = createOptions.requireLocalDecision !== false
      return invitation
      } finally { busyPair = false }
    },

    async cancelInvitation(pairSessionId) {
      if (busyPair || invitation?.handle.pairSessionId !== pairSessionId) throw new Error('pairing-unavailable')
      const expired = invitation.handle.expiresAt <= now()
      invitation = undefined
      invitationRequiresLocalDecision = true
      if (!expired) await options.relayClient.closePairSession(closeFrame(
        options.hostId, options.hostDeviceId, pairSessionId, 'cancelled',
      ))
    },

    async handlePairJoin(frame) {
      if (busyPair || invitation === undefined) {
        throw new Error('pairing-unavailable')
      }
      busyPair = true
      try {
        const join = decodePairJoinFrame(frame, { now: now() })
        const opened = await openHostPairJoin({
          invitation: invitation.handle,
          attemptId: `attempt.${join.joinId}`,
          wireFrame: frame,
          now: now(),
        })
        if (opened.outcome !== 'pending-confirmation') return
        const confirmation: HostPairingConfirmation = opened.confirmation
        const claim: RelayPairClaim = {
          protocolVersion: PROTOCOL_VERSION,
          relayType: 'pair.claim',
          hostId: options.hostId,
          hostDeviceId: options.hostDeviceId,
          pairSessionId: confirmation.claim.pairSessionId,
          joinId: confirmation.claim.joinId,
        }
        await options.relayClient.claimPairSession(claim)
        let decision: LocalPairingDecision = { decision: 'approve' }
        if (invitationRequiresLocalDecision) {
          const remainingMs = Math.max(0, confirmation.claim.expiresAt - now())
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            decision = await Promise.race([
              options.requestLocalDecision({
                deviceDisplayName: confirmation.claim.deviceDisplayName,
                sas: confirmation.claim.sas,
                clientSigningFingerprint: confirmation.claim.clientSigningFingerprint,
                expiresAt: confirmation.claim.expiresAt,
              }),
              new Promise<LocalPairingDecision>(resolve => {
                timer = setTimeout(() => resolve({ decision: 'deny' }), remainingMs)
              }),
            ])
          } catch {
            decision = { decision: 'deny' }
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        }
        if (decision.decision !== 'approve') {
          const denied = await prepareHostPairingDenial({ confirmation, now: now() })
          await options.relayClient.sendPairResult(denied.wireText)
          await options.relayClient.closePairSession(closeFrame(
            options.hostId,
            options.hostDeviceId,
            confirmation.claim.pairSessionId,
            'denied',
          ))
          invitation = undefined
          invitationRequiresLocalDecision = true
          return
        }
        const approved = await approveHostPairing({
          confirmation,
          now: now(),
          ...(options.remotePermissionModes === undefined ? {} : { remotePermissionModes: options.remotePermissionModes }),
          persistenceAdapter: {
            commitAuthorizationAndUpsertRelay: async ({ authorization: material }) => {
              const local = await options.commitAuthorizationLocally(material)
              const clientSigningKey = await exportPublicJwk(material.clientSigningPublicKey)
              const clientSigningFingerprint = await fingerprintP256PublicKey(
                material.clientSigningPublicKey,
              )
              const applied = await options.relayClient.putAuthorization({
                protocolVersion: PROTOCOL_VERSION,
                relayType: 'authorization.put',
                hostId: material.grantClaims.hostId,
                hostDeviceId: material.grantClaims.hostDeviceId,
                clientDeviceId: material.grantClaims.clientDeviceId,
                authorizationId: material.grantClaims.authorizationId,
                authorizationEpoch: material.grantClaims.authorizationEpoch,
                hostAuthorizationRevision: positive(local.hostAuthorizationRevision),
                status: 'active',
                clientSigningKey,
                clientSigningFingerprint,
              })
              return {
                relayRevision: applied.hostAuthorizationRevision,
                nextGeneration: positive(local.nextGeneration),
              }
            },
          },
        })
        const replaced = established
        try {
          await options.onSessionReplacing?.(replaced)
        } catch {
          // The presentation handler cannot roll back an already committed authorization.
        }
        if (replaced !== undefined) invalidateEstablishedSession(replaced)
        established = undefined
        awaitingConfirm = undefined
        authorization = approved.authorization
        nextGeneration = approved.persistence.nextGeneration
        await options.relayClient.sendPairResult(approved.wireText)
        await options.relayClient.closePairSession(closeFrame(
          options.hostId,
          options.hostDeviceId,
          confirmation.claim.pairSessionId,
          'approved',
        ))
        invitation = undefined
        invitationRequiresLocalDecision = true
        options.onPairingCompleted?.()
      } finally {
        busyPair = false
      }
    },

    async handleSessionInit(frame) {
      if (busySession || awaitingConfirm !== undefined) {
        throw new Error('session-unavailable')
      }
      busySession = true
      try {
        let validated
        try {
          validated = await validateSessionInitForHost({
            authorization: hostSessionAuthorization(),
            frame,
            now: now(),
            reserveGeneration: options.reserveGeneration ?? (async () => {
              const generation = positive(nextGeneration)
              nextGeneration = generation + 1
              return generation
            }),
          })
        } catch {
          throw new Error('runtime-stage:validate-session-init')
        }
        if (established !== undefined) {
          const replaced = established
          try {
            await options.onSessionReplacing?.(replaced)
          } catch {
            // A presentation handler cannot invalidate the newly authenticated init.
          }
          invalidateEstablishedSession(replaced)
          established = undefined
        }
        try {
          awaitingConfirm = await createHostSessionAccept({
            state: validated,
            now: now(),
            expiresAt: now() + 20_000,
          })
        } catch (error) {
          throw new Error(`runtime-stage:create-session-accept:${classifySessionAcceptFailure(error)}`)
        }
        try {
          await options.relayClient.sendSessionAccept(awaitingConfirm.frame)
        } catch {
          throw new Error('runtime-stage:send-session-accept')
        }
      } finally {
        busySession = false
      }
    },

    async handleSessionEnvelope(frame) {
      if (awaitingConfirm === undefined || established !== undefined) {
        throw new Error('session-unavailable')
      }
      const confirmed = await acceptClientSessionConfirm({
        state: awaitingConfirm,
        frame,
        now: now(),
      })
      awaitingConfirm = undefined
      const ready = await createHostSessionReady({
        state: confirmed,
        now: now(),
        expiresAt: now() + 5_000,
      })
      const receipt = await options.relayClient.sendEnvelope(ready.ready.wireText)
      if (receipt.state !== 'relayed') throw new Error('relay-unavailable')
      established = ready.channel
      await options.onReady?.(ready.channel)
    },

    readyChannel() {
      return established
    },
  }
}
