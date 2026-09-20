import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, resolve, win32 as windowsPath } from 'node:path'
import { createInterface } from 'node:readline/promises'

import {
  exportPublicJwk,
  fingerprintP256PublicKey,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  getEstablishedSessionChannelInfo,
  type HostAuthorizationMaterial,
} from '../../../packages/e2ee/src/index.ts'
import { createR3LocalTestRelayServer } from '../../../services/relay/src/index.ts'

import { createActionState } from './action-state.ts'
import { createEphemeralHostPairingRuntime } from './pairing-session-runtime.ts'
import { AppServerReadProjection } from './read-projection.ts'
import { createWindowsCompanionReadySessionHandler } from './ready-session.ts'
import {
  createLiveRequestAuthority,
  type LiveRequestAuthority,
} from './live-request-authority.ts'
import { R3LoopbackRelayHostClient } from './relay-host-client.ts'
import { establishRuntimeCompatibility } from './runtime-binding.ts'
import { isSupportedTextTurnSettings, startBoundTask, type TextTurnAttachment } from './turn-runtime.ts'
import type { StartTaskInput, StartTaskReceipt } from '../../../packages/codex-serve-client/src/index.ts'
import {
  APP_SERVER_METHODS,
  AppServerSupervisor,
  AppServerSupervisorError,
} from './supervisor.ts'

const RELAY_ORIGIN = 'http://127.0.0.1:5173'
const RELAY_PORT = 41744
const DEMO_LOGIN_PORT = 41745
const EXPECTED_SETTINGS = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'xhigh' as const,
  permission: 'ask' as const,
})

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

async function readDemoLogin(request: IncomingMessage): Promise<Readonly<{ username: string; password: string }>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > 1024) throw new Error('invalid-demo-login')
    chunks.push(chunk)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid-demo-login')
  }
  const values = parsed as Record<string, unknown>
  if (
    Object.keys(values).length !== 2
    || typeof values.username !== 'string'
    || typeof values.password !== 'string'
  ) {
    throw new Error('invalid-demo-login')
  }
  return Object.freeze({ username: values.username, password: values.password })
}

async function main(): Promise<void> {
  const codexExecutable = argument('--codex-executable')
  const workspace = argument('--workspace')
  const testAutoApprove = process.argv.includes('--test-auto-approve')
  const localDemoLogin = process.argv.includes('--local-demo-login')
  const localDemoFullAccess = process.argv.includes('--local-demo-full-access')
  if (codexExecutable === undefined || workspace === undefined) {
    process.stderr.write(
      'Usage: pnpm --filter @codex-plus/windows-agent local -- --codex-executable <absolute codex path> --workspace <absolute workspace> [--local-demo-login]\n',
    )
    process.exitCode = 2
    return
  }
  if (localDemoFullAccess && !localDemoLogin) {
    process.stderr.write('Local demo full access requires --local-demo-login.\n')
    process.exitCode = 2
    return
  }
  const normalizedCodexExecutable = windowsPath.normalize(codexExecutable)
  const normalizedWorkspace = windowsPath.normalize(workspace)

  const projectRoot = resolve(import.meta.dirname, '..', '..', '..')
  const runtimeDirectory = windowsPath.join(projectRoot, '.tmp', `remote-runtime-${randomUUID()}`)
  mkdirSync(runtimeDirectory, { recursive: true })
  const hostId = `host.${randomUUID()}`
  const hostDeviceId = `windows.${randomUUID()}`
  const bootstrapCredential = randomBytes(32).toString('base64url')
  const fingerprintKey = randomBytes(32)
  const [hostAgreement, hostSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const hostSigningKey = await exportPublicJwk(hostSigning.publicKey)
  const hostSigningFingerprint = await fingerprintP256PublicKey(hostSigning.publicKey)

  const relay = createR3LocalTestRelayServer({
    mode: 'r3-local-test',
    stateFile: windowsPath.join(runtimeDirectory, 'relay-state.json'),
    relayOrigin: RELAY_ORIGIN,
    bootstrapCredential,
  })
  let liveRequests: LiveRequestAuthority | undefined
  const supervisor = new AppServerSupervisor({
    command: {
      executable: normalizedCodexExecutable,
      args: ['app-server'],
      cwd: normalizedWorkspace,
    },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: [...APP_SERVER_METHODS],
    onServerRequest: request => liveRequests?.handleServerRequest(request) ?? Promise.resolve({
      error: { code: -32601, message: 'Server request is not supported.' },
    }),
  })
  const projection = new AppServerReadProjection({
    supervisor,
    workspaces: [{
      id: 'workspace.local',
      name: basename(normalizedWorkspace),
      path: normalizedWorkspace,
      pathLabel: basename(normalizedWorkspace),
    }],
    allowAllLocalThreads: localDemoFullAccess,
    paginateTurns: localDemoFullAccess,
  })
  const actionStore = createActionState({
    workspaceRoot: projectRoot,
    databasePath: windowsPath.join(runtimeDirectory, 'action.sqlite'),
  })
  const demoOwnedTaskIds = new Set<string>()
  liveRequests = createLiveRequestAuthority({
    isTaskOwned: taskId => demoOwnedTaskIds.has(taskId),
  })
  const demoStartResults = new Map<string, Readonly<{ fingerprint: string; result: Promise<StartTaskReceipt> }>>()
  const demoPairingResults = new Map<string, Readonly<{
    fingerprint: string
    result: Promise<Readonly<{ actionId: string; state: 'accepted'; invitationFragment: string; expiresAt: number }>>
  }>>()
  process.stdout.write('Local startup: Relay.\n')
  const relayAddress = await relay.listen({ host: '127.0.0.1', port: RELAY_PORT })
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  let hostRuntime!: ReturnType<typeof createEphemeralHostPairingRuntime>
  let readyHandler: ReturnType<typeof createWindowsCompanionReadySessionHandler> | undefined
  let unsubscribeAppServerNotifications: (() => void) | undefined
  let demoLoginServer: Server | undefined
  let closePromise: Promise<void> | undefined
  const runStage = async (stage: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      const detail = error instanceof Error && error.message.startsWith('runtime-stage:')
        ? ` (${error.message.slice('runtime-stage:'.length)})`
        : ''
      process.stderr.write(`Codex Plus local stage failed closed: ${stage}${detail}.\n`)
      throw new Error('local-stage-failed')
    }
  }
  const hostClient = new R3LoopbackRelayHostClient({
    mode: 'r3-local-test',
    webSocketUrl: relayAddress.webSocketUrl,
    relayOrigin: RELAY_ORIGIN,
    hostId,
    hostDeviceId,
    authentication: {
      kind: 'bootstrap',
      bootstrapCredential,
      hostSigningKey,
      hostSigningFingerprint,
    },
    signChallenge: async canonicalInput => new Uint8Array(await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      hostSigning.privateKey,
      new Uint8Array(canonicalInput),
    )),
    onPairJoin: frame => runStage('pair-join', () => hostRuntime.handlePairJoin(frame)),
    onSessionInit: frame => runStage('session-init', () => hostRuntime.handleSessionInit(frame))
      .then(() => { process.stdout.write('Local startup: session accept sent.\n') }),
    onEnvelope: frame => runStage(
      readyHandler === undefined ? 'session-confirm' : 'application',
      async () => {
        if (readyHandler === undefined) {
          process.stdout.write('Local startup: session confirm received.\n')
          await hostRuntime.handleSessionEnvelope(frame)
        } else {
          await readyHandler(frame)
        }
      },
    ),
  })

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closePromise = (async () => {
      terminal.close()
      unsubscribeAppServerNotifications?.()
      if (demoLoginServer?.listening) {
        await new Promise<void>(resolveClose => demoLoginServer?.close(() => resolveClose()))
      }
      await hostClient.close().catch(() => undefined)
      await relay.close().catch(() => undefined)
      await supervisor.close().catch(() => undefined)
      actionStore.close()
      fingerprintKey.fill(0)
    })()
    return closePromise
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })

  try {
    process.stdout.write('Local startup: official app-server.\n')
    try {
      await supervisor.start()
      unsubscribeAppServerNotifications = supervisor.onNotification(() => undefined)
    } catch (error) {
      if (error instanceof AppServerSupervisorError) {
        process.stderr.write(`Official app-server start failed closed: ${error.code}.\n`)
      }
      throw error
    }
    process.stdout.write('Local startup: runtime compatibility.\n')
    const compatibility = await establishRuntimeCompatibility(supervisor)
    process.stdout.write('Local startup: Host Relay authentication.\n')
    await hostClient.connect()
    let hostAuthorizationRevision = 0
    let localAuthorization: HostAuthorizationMaterial | undefined
    let localDeviceName = '当前浏览器'
    const createHostRuntime = () => createEphemeralHostPairingRuntime({
    relayClient: hostClient,
    relayOrigin: RELAY_ORIGIN,
    hostId,
    hostDeviceId,
    hostAgreementPrivateKey: hostAgreement.privateKey,
    hostAgreementPublicKey: hostAgreement.publicKey,
    hostSigningPrivateKey: hostSigning.privateKey,
    hostSigningPublicKey: hostSigning.publicKey,
    remotePermissionModes: localDemoFullAccess
      ? ['ask', 'read-only', 'full-access']
      : ['ask', 'read-only'],
    requestLocalDecision: async confirmation => {
      process.stdout.write(
        `\nPair request\nDevice: ${JSON.stringify(confirmation.deviceDisplayName)}\nSAS: ${confirmation.sas}\nSigning fingerprint: ${confirmation.clientSigningFingerprint}\n`,
      )
      if (testAutoApprove || localDemoLogin) {
        process.stdout.write('Pairing approved by explicit local test flag.\n')
        return { decision: 'approve' }
      }
      const answer = await terminal.question('Type APPROVE to pair this device: ')
      return { decision: answer.trim() === 'APPROVE' ? 'approve' : 'deny' }
    },
    commitAuthorizationLocally: async authorization => {
      localAuthorization = authorization
      return {
        hostAuthorizationRevision: ++hostAuthorizationRevision,
        nextGeneration: 1,
      }
    },
    onSessionReplacing: () => {
      readyHandler = undefined
    },
    onReady: channel => {
      const info = getEstablishedSessionChannelInfo(channel)
      actionStore.applyAuthorization({
        hostId: info.authority.hostId,
        authorizationId: info.authority.authorizationId,
        clientDeviceId: info.authority.clientDeviceId,
        authorizationEpoch: info.authority.authorizationEpoch,
        connectionGeneration: info.authority.connectionGeneration,
        status: 'active',
        revision: 1,
      })
      actionStore.activateChannel({
        hostId: info.authority.hostId,
        authorizationId: info.authority.authorizationId,
        authorizationEpoch: info.authority.authorizationEpoch,
        connectionGeneration: info.authority.connectionGeneration,
        inboundKeyId: info.inboundKeyId,
        outboundKeyId: info.outboundKeyId,
        lastInboundSequence: info.sequenceState.lastAcceptedInboundSequence,
        lastPeerAck: info.sequenceState.lastPeerAck,
        maxSentSequence: info.sequenceState.maxSentSequence,
      })
      const startDemoTask = async (input: StartTaskInput): Promise<StartTaskReceipt> => {
        const fingerprint = JSON.stringify(input)
        const existing = demoStartResults.get(input.actionId)
        if (existing !== undefined) {
          return existing.fingerprint === fingerprint
            ? existing.result
            : Object.freeze({
                actionId: input.actionId,
                state: 'rejected' as const,
                rejection: { code: 'action-id-conflict' as const, message: 'The action id was reused with different input.' },
              })
        }
        const result = (async (): Promise<StartTaskReceipt> => {
          if (input.workspaceId !== 'workspace.local') {
            return Object.freeze({
              actionId: input.actionId,
              state: 'rejected' as const,
              rejection: { code: 'unknown-workspace' as const, message: 'The workspace is unavailable.' },
            })
          }
          const textInput = input.input[0]?.type === 'text' ? input.input[0] : undefined
          const refs = input.input.slice(textInput === undefined ? 0 : 1).filter(value => value.type !== 'text')
          const sidecars = new Map((input.attachments ?? []).map(value => [value.attachmentId, value]))
          const attachments: TextTurnAttachment[] = refs.map(ref => {
            const sidecar = sidecars.get(ref.attachmentId)
            if (sidecar === undefined) throw new Error('invalid-input')
            return Object.freeze({
              kind: ref.type,
              attachmentId: ref.attachmentId,
              name: ref.name,
              mediaType: sidecar.mediaType,
              byteLength: sidecar.byteLength,
              contentBase64Url: sidecar.contentBase64Url,
            })
          })
          if (!isSupportedTextTurnSettings(input.settings, localDemoFullAccess)) {
            return Object.freeze({
              actionId: input.actionId,
              state: 'rejected' as const,
              rejection: { code: 'invalid-input' as const, message: 'The task settings are unavailable.' },
            })
          }
          try {
            const started = await startBoundTask(supervisor, compatibility, {
              workspacePath: normalizedWorkspace,
              actionId: input.actionId,
              text: textInput?.text ?? '',
              settings: input.settings,
              attachments,
              attachmentDirectory: windowsPath.join(runtimeDirectory, 'attachments'),
              allowFullAccess: localDemoFullAccess,
              onThreadStarted: taskId => demoOwnedTaskIds.add(taskId),
            })
            actionStore.upsertTask({
              hostId: info.authority.hostId,
              taskId: started.threadId,
              workspaceId: input.workspaceId,
              revision: 1,
              writeState: 'writable',
              canSend: false,
              canInterrupt: true,
            })
            const title = (textInput?.text.trim().split(/\r?\n/u)[0] || attachments[0]?.name || '新任务').slice(0, 256)
            projection.registerOwnedActiveTask({
              taskId: started.threadId,
              workspaceId: input.workspaceId,
              actionId: input.actionId,
              turnId: started.turnId,
              title,
              text: textInput?.text ?? '',
              now: Date.now(),
            })
            demoOwnedTaskIds.add(started.threadId)
            return Object.freeze({
              actionId: input.actionId,
              state: 'accepted' as const,
              revision: 1,
              task: {
                id: started.threadId,
                workspaceId: input.workspaceId,
                title,
                status: 'running' as const,
                updatedAt: new Date().toISOString(),
                revision: 1,
                activeTurnId: started.turnId,
              },
            })
          } catch {
            return Object.freeze({ actionId: input.actionId, state: 'queued' as const })
          }
        })()
        demoStartResults.set(input.actionId, Object.freeze({ fingerprint, result }))
        return result
      }
      const createDemoPairing = (
        input: { actionId: string },
        context: { requestFingerprint: string },
      ) => {
        const existing = demoPairingResults.get(input.actionId)
        if (existing !== undefined) {
          if (existing.fingerprint !== context.requestFingerprint) {
            return Promise.resolve({
              actionId: input.actionId,
              state: 'rejected' as const,
              rejection: {
                code: 'action-id-conflict' as const,
                message: 'The action id was reused with different input.',
              },
            })
          }
          return existing.result
        }
        const result = hostRuntime.createInvitation().then(invitation => Object.freeze({
          actionId: input.actionId,
          state: 'accepted' as const,
          invitationFragment: invitation.invitationFragment,
          expiresAt: invitation.handle.expiresAt,
        }))
        demoPairingResults.set(input.actionId, Object.freeze({
          fingerprint: context.requestFingerprint,
          result,
        }))
        return result
      }
      readyHandler = createWindowsCompanionReadySessionHandler({
        state: channel,
        store: actionStore,
        projection,
        supervisor,
        compatibility,
        expectedSettings: EXPECTED_SETTINGS,
        attachmentDirectory: windowsPath.join(runtimeDirectory, 'attachments'),
        allowFullAccess: localDemoFullAccess,
        ...(localDemoFullAccess ? { isTaskDemoOwned: (taskId: string) => demoOwnedTaskIds.has(taskId) } : {}),
        ...(localDemoFullAccess ? { startTask: startDemoTask } : {}),
        canStartTask: localDemoFullAccess,
        listManagedDevices: async ({ currentClientDeviceId, generatedAt }) => {
          const claims = localAuthorization?.grantClaims
          if (claims === undefined || claims.clientDeviceId !== currentClientDeviceId) return []
          const shortId = currentClientDeviceId.slice(-8)
          return [{
            deviceId: currentClientDeviceId,
            displayName: localDeviceName,
            shortId,
            signingFingerprint: claims.clientSigningFingerprint,
            authorizationId: claims.authorizationId,
            authorizationEpoch: claims.authorizationEpoch,
            status: 'active',
            presence: 'online',
            pairedAt: claims.issuedAt,
            lastSeenAt: generatedAt,
            isCurrent: true,
          }]
        },
        liveRequests,
        managementActions: {
          createPairing: createDemoPairing,
          renameDevice: async (input, context) => {
            if (
              input.deviceId !== context.authority.clientDeviceId
              || input.authorizationId !== context.authority.authorizationId
              || input.authorizationEpoch !== context.authority.authorizationEpoch
            ) {
              return {
                actionId: input.actionId,
                state: 'rejected',
                rejection: { code: 'stale-host', message: 'The device authority changed.' },
              }
            }
            localDeviceName = input.displayName
            return { actionId: input.actionId, state: 'accepted' }
          },
          revokeDevice: async input => ({
            actionId: input.actionId,
            state: 'rejected',
            rejection: { code: 'stale-host', message: 'The device authority changed.' },
          }),
        },
        assertAuthorizationActive: async () => {},
        fingerprintCanonicalRequest: async bytes => createHmac('sha256', fingerprintKey)
          .update(bytes)
          .digest('base64url'),
        sendEnvelope: frame => hostClient.sendEnvelope(frame),
      })
      process.stdout.write('\nEncrypted Codex Plus session is ready.\n')
    },
    })
    hostRuntime = createHostRuntime()
    if (localDemoLogin) {
      let loginBusy = false
      demoLoginServer = createServer((request, response) => {
        void (async () => {
          if (
            request.method !== 'POST'
            || request.url !== '/api/local-demo-login'
            || request.headers.origin !== RELAY_ORIGIN
            || !request.headers['content-type']?.toLowerCase().startsWith('application/json')
          ) {
            sendJson(response, 404, { error: 'not-found' })
            return
          }
          if (loginBusy) {
            sendJson(response, 409, { error: 'demo-session-unavailable' })
            return
          }
          loginBusy = true
          try {
            const credentials = await readDemoLogin(request)
            if (credentials.username !== 'admin' || credentials.password !== '123456') {
              sendJson(response, 401, { error: 'invalid-credentials' })
              return
            }
            if (readyHandler !== undefined) {
              readyHandler = undefined
              process.stdout.write('Local demo login: replacing the previous browser session.\n')
            }
            hostRuntime = createHostRuntime()
            const invitation = await hostRuntime.createInvitation()
            sendJson(response, 200, {
              invitationFragment: invitation.invitationFragment,
              fullAccess: localDemoFullAccess,
            })
          } catch {
            sendJson(response, 400, { error: 'invalid-request' })
          } finally {
            loginBusy = false
          }
        })()
      })
      await new Promise<void>((resolveListen, rejectListen) => {
        demoLoginServer?.once('error', rejectListen)
        demoLoginServer?.listen(DEMO_LOGIN_PORT, '127.0.0.1', () => resolveListen())
      })
      process.stdout.write(`\nLocal demo login ready: ${RELAY_ORIGIN}/pair (admin / 123456).\n\n`)
    } else {
      process.stdout.write('Local startup: one-time invitation.\n')
      const invitation = await hostRuntime.createInvitation()
      process.stdout.write(
        `\nStart the formal Web app in another terminal with: pnpm codex-web:formal\nThen open this one-time local pairing link:\n${RELAY_ORIGIN}/pair#${invitation.invitationFragment}\n\n`,
      )
    }
    await new Promise<void>(resolveDone => {
      process.once('SIGINT', resolveDone)
      process.once('SIGTERM', resolveDone)
    })
  } finally {
    await close()
  }
}

void main().catch(() => {
  process.stderr.write('Codex Plus local Companion failed closed.\n')
  process.exitCode = 1
})
