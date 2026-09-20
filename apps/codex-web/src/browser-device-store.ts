import type {
  ClientAuthorizationMaterial,
  ClientGenerationInstallRequest,
  CommitInboundFrame,
  EstablishedSessionChannelInfo,
  OutboundFramePersistenceAdapter,
  SessionAuthority,
} from '@codex-plus/e2ee'

const DATABASE_NAME = 'codex-plus-device-v1'
const DATABASE_VERSION = 1
const DEVICE_STORE = 'device'
const SESSION_STORE = 'sessions'
const DEVICE_KEY = 'current'
const MAX_RAW_FRAMES = 16
const MAX_RAW_FRAME_BYTES = 8 * 1024 * 1024
const encoder = new TextEncoder()

interface DeviceRecord {
  key: typeof DEVICE_KEY
  version: 1
  relayOrigin: string
  authorization: ClientAuthorizationMaterial
  status: 'active' | 'revoked'
  currentEpoch: number
  highestGeneration: number
  currentSessionKey?: string
}

interface SessionRecord {
  key: string
  version: 1
  status: 'active' | 'superseded'
  authority: SessionAuthority
  inboundKeyId: string
  outboundKeyId: string
  nextOutboundSequence: number
  maxSentSequence: number
  lastInboundSequence: number
  lastPeerAck: number
  rawFrames: Array<{ sequence: number; wireText: string; byteLength: number }>
}

export class BrowserDeviceStoreError extends Error {
  constructor(readonly code: string) {
    super(`browser-device-store:${code}`)
    this.name = 'BrowserDeviceStoreError'
  }
}

function fail(code: string): never {
  throw new BrowserDeviceStoreError(code)
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(new BrowserDeviceStoreError('storage-failed')), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(new BrowserDeviceStoreError('storage-failed')), { once: true })
    transaction.addEventListener('error', () => reject(new BrowserDeviceStoreError('storage-failed')), { once: true })
  })
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

function sessionKey(authority: SessionAuthority): string {
  return `${authority.authorizationId}:${authority.connectionGeneration}`
}

function cryptoKey(value: unknown, type: KeyType, usage?: KeyUsage, privateKey = false): CryptoKey {
  if (!(value instanceof CryptoKey)) fail('invalid-identity')
  if (value.type !== type || (usage !== undefined && !value.usages.includes(usage))) fail('invalid-identity')
  if (privateKey && value.extractable) fail('extractable-private-key')
  return value
}

function authorizationRecord(value: unknown): ClientAuthorizationMaterial {
  if (typeof value !== 'object' || value === null) fail('invalid-identity')
  const candidate = value as Partial<ClientAuthorizationMaterial>
  if (
    typeof candidate.grantClaims !== 'object'
    || candidate.grantClaims === null
    || typeof candidate.hostGrantSignature !== 'string'
    || typeof candidate.grantClaimsHash !== 'string'
  ) fail('invalid-identity')
  cryptoKey(candidate.clientAgreementPrivateKey, 'private', 'deriveBits', true)
  cryptoKey(candidate.clientAgreementPublicKey, 'public')
  cryptoKey(candidate.clientSigningPrivateKey, 'private', 'sign', true)
  cryptoKey(candidate.clientSigningPublicKey, 'public', 'verify')
  cryptoKey(candidate.hostAgreementPublicKey, 'public')
  cryptoKey(candidate.hostSigningPublicKey, 'public', 'verify')
  return candidate as ClientAuthorizationMaterial
}

function deviceRecord(value: unknown): DeviceRecord | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) fail('invalid-store')
  const candidate = value as Partial<DeviceRecord>
  if (
    candidate.key !== DEVICE_KEY
    || candidate.version !== 1
    || typeof candidate.relayOrigin !== 'string'
    || (candidate.status !== 'active' && candidate.status !== 'revoked')
    || !Number.isSafeInteger(candidate.currentEpoch)
    || (candidate.currentEpoch ?? -1) < 1
    || !Number.isSafeInteger(candidate.highestGeneration)
    || (candidate.highestGeneration ?? -1) < 0
    || (candidate.currentSessionKey !== undefined && typeof candidate.currentSessionKey !== 'string')
  ) fail('invalid-store')
  authorizationRecord(candidate.authorization)
  return candidate as DeviceRecord
}

function sessionRecord(value: unknown): SessionRecord {
  if (typeof value !== 'object' || value === null) fail('invalid-store')
  const candidate = value as Partial<SessionRecord>
  if (
    typeof candidate.key !== 'string'
    || candidate.version !== 1
    || (candidate.status !== 'active' && candidate.status !== 'superseded')
    || typeof candidate.authority !== 'object'
    || candidate.authority === null
    || typeof candidate.inboundKeyId !== 'string'
    || typeof candidate.outboundKeyId !== 'string'
    || !Number.isSafeInteger(candidate.nextOutboundSequence)
    || !Number.isSafeInteger(candidate.maxSentSequence)
    || !Number.isSafeInteger(candidate.lastInboundSequence)
    || !Number.isSafeInteger(candidate.lastPeerAck)
    || !Array.isArray(candidate.rawFrames)
  ) fail('invalid-store')
  return candidate as SessionRecord
}

function requireActiveSession(record: SessionRecord, authority: SessionAuthority): void {
  if (record.status !== 'active' || !sameAuthority(record.authority, authority)) fail('stale-authority')
}

export interface BrowserSessionPersistence {
  readonly outbound: OutboundFramePersistenceAdapter
  readonly commitInbound: CommitInboundFrame
  readonly assertActive: (authority: SessionAuthority) => Promise<void>
  listUnacknowledgedFrames(): Promise<readonly string[]>
}

export interface BrowserDeviceStore {
  saveAuthorization(relayOrigin: string, authorization: ClientAuthorizationMaterial): Promise<void>
  loadAuthorization(relayOrigin: string): Promise<ClientAuthorizationMaterial | undefined>
  markRevoked(authorizationId: string, authorizationEpoch: number): Promise<void>
  installGeneration(request: Readonly<ClientGenerationInstallRequest>): Promise<number>
  activateSession(info: EstablishedSessionChannelInfo): Promise<BrowserSessionPersistence>
  recoverySnapshot(): Promise<Readonly<{
    highestGeneration: number
    authority?: SessionAuthority
    rawFrames: readonly string[]
  }>>
  clear(): Promise<void>
  close(): void
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') fail('indexeddb-unavailable')
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.addEventListener('upgradeneeded', () => {
    const database = request.result
    if (!database.objectStoreNames.contains(DEVICE_STORE)) database.createObjectStore(DEVICE_STORE, { keyPath: 'key' })
    if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE, { keyPath: 'key' })
  }, { once: true })
  return await requestResult(request)
}

export async function openBrowserDeviceStore(): Promise<BrowserDeviceStore> {
  const database = await openDatabase()
  let closed = false
  const requireOpen = (): void => { if (closed) fail('closed') }

  const readDevice = async (transaction: IDBTransaction): Promise<DeviceRecord | undefined> => (
    deviceRecord(await requestResult(transaction.objectStore(DEVICE_STORE).get(DEVICE_KEY)))
  )

  const readSession = async (
    transaction: IDBTransaction,
    key: string,
  ): Promise<SessionRecord> => sessionRecord(
    await requestResult(transaction.objectStore(SESSION_STORE).get(key)),
  )

  return {
    async saveAuthorization(relayOrigin, authorization) {
      requireOpen()
      authorizationRecord(authorization)
      const transaction = database.transaction([DEVICE_STORE], 'readwrite', { durability: 'strict' })
      const existing = await readDevice(transaction)
      if (existing !== undefined) fail('device-already-paired')
      transaction.objectStore(DEVICE_STORE).add({
        key: DEVICE_KEY,
        version: 1,
        relayOrigin,
        authorization,
        status: 'active',
        currentEpoch: authorization.grantClaims.authorizationEpoch,
        highestGeneration: 0,
      } satisfies DeviceRecord)
      await transactionDone(transaction)
    },

    async loadAuthorization(relayOrigin) {
      requireOpen()
      const transaction = database.transaction([DEVICE_STORE], 'readonly')
      const record = await readDevice(transaction)
      await transactionDone(transaction)
      if (record === undefined) return undefined
      if (record.relayOrigin !== relayOrigin) fail('origin-mismatch')
      if (record.status !== 'active') fail('device-revoked')
      return authorizationRecord(record.authorization)
    },

    async markRevoked(authorizationId, authorizationEpoch) {
      requireOpen()
      const transaction = database.transaction([DEVICE_STORE, SESSION_STORE], 'readwrite', { durability: 'strict' })
      const record = await readDevice(transaction)
      if (
        record === undefined
        || record.status !== 'active'
        || record.authorization.grantClaims.authorizationId !== authorizationId
        || !Number.isSafeInteger(authorizationEpoch)
        || authorizationEpoch <= record.currentEpoch
      ) fail('stale-authority')
      record.status = 'revoked'
      record.currentEpoch = authorizationEpoch
      if (record.currentSessionKey !== undefined) {
        const sessionValue = await requestResult(
          transaction.objectStore(SESSION_STORE).get(record.currentSessionKey),
        )
        if (sessionValue !== undefined) {
          const session = sessionRecord(sessionValue)
          session.status = 'superseded'
          transaction.objectStore(SESSION_STORE).put(session)
        }
      }
      transaction.objectStore(DEVICE_STORE).put(record)
      await transactionDone(transaction)
    },

    async installGeneration(request) {
      requireOpen()
      const transaction = database.transaction([DEVICE_STORE], 'readwrite', { durability: 'strict' })
      const record = await readDevice(transaction)
      if (record === undefined) fail('unpaired')
      const claims = record.authorization.grantClaims
      if (
        record.status !== 'active'
        || claims.hostId !== request.hostId
        || claims.hostDeviceId !== request.hostDeviceId
        || claims.clientDeviceId !== request.clientDeviceId
        || claims.authorizationId !== request.authorizationId
        || record.currentEpoch !== request.authorizationEpoch
        || request.connectionGeneration <= record.highestGeneration
      ) fail('generation-replay')
      const previous = record.highestGeneration
      record.highestGeneration = request.connectionGeneration
      transaction.objectStore(DEVICE_STORE).put(record)
      await transactionDone(transaction)
      return previous
    },

    async activateSession(info) {
      requireOpen()
      const key = sessionKey(info.authority)
      const transaction = database.transaction([DEVICE_STORE, SESSION_STORE], 'readwrite', { durability: 'strict' })
      const record = await readDevice(transaction)
      if (
        record === undefined
        || record.status !== 'active'
        || record.highestGeneration !== info.authority.connectionGeneration
        || record.authorization.grantClaims.authorizationId !== info.authority.authorizationId
        || record.authorization.grantClaims.authorizationEpoch !== info.authority.authorizationEpoch
      ) fail('stale-authority')
      const sessions = transaction.objectStore(SESSION_STORE)
      if (await requestResult(sessions.get(key)) !== undefined) fail('generation-replay')
      if (record.currentSessionKey !== undefined) {
        const previousValue = await requestResult(sessions.get(record.currentSessionKey))
        if (previousValue !== undefined) {
          const previous = sessionRecord(previousValue)
          previous.status = 'superseded'
          sessions.put(previous)
        }
      }
      const session: SessionRecord = {
        key,
        version: 1,
        status: 'active',
        authority: info.authority,
        inboundKeyId: info.inboundKeyId,
        outboundKeyId: info.outboundKeyId,
        nextOutboundSequence: info.sequenceState.nextOutboundSequence,
        maxSentSequence: info.sequenceState.maxSentSequence,
        lastInboundSequence: info.sequenceState.lastAcceptedInboundSequence,
        lastPeerAck: info.sequenceState.lastPeerAck,
        rawFrames: [],
      }
      sessions.add(session)
      record.currentSessionKey = key
      transaction.objectStore(DEVICE_STORE).put(record)
      await transactionDone(transaction)

      const assertActive = async (authority: SessionAuthority): Promise<void> => {
        requireOpen()
        const check = database.transaction([DEVICE_STORE, SESSION_STORE], 'readonly')
        const [device, current] = await Promise.all([
          readDevice(check),
          readSession(check, key),
        ])
        await transactionDone(check)
        if (
          device?.status !== 'active'
          || device.currentSessionKey !== key
          || device.highestGeneration !== authority.connectionGeneration
          || !sameAuthority(current.authority, authority)
          || current.status !== 'active'
        ) fail('stale-authority')
      }

      const outbound: OutboundFramePersistenceAdapter = {
        async reserveSequence(request) {
          requireOpen()
          const update = database.transaction([SESSION_STORE], 'readwrite', { durability: 'strict' })
          const current = await readSession(update, key)
          requireActiveSession(current, request.authority)
          if (current.outboundKeyId !== request.keyId || current.nextOutboundSequence !== request.expectedSequence) {
            fail('sequence-gap')
          }
          const sequence = current.nextOutboundSequence
          current.nextOutboundSequence += 1
          update.objectStore(SESSION_STORE).put(current)
          await transactionDone(update)
          return sequence
        },
        async commitFrame(request) {
          requireOpen()
          const update = database.transaction([SESSION_STORE], 'readwrite', { durability: 'strict' })
          const current = await readSession(update, key)
          requireActiveSession(current, request.authority)
          const byteLength = encoder.encode(request.wireText).byteLength
          const total = current.rawFrames.reduce((sum, frame) => sum + frame.byteLength, 0)
          if (
            current.outboundKeyId !== request.keyId
            || request.sequence !== current.maxSentSequence + 1
            || current.nextOutboundSequence !== request.sequence + 1
          ) fail('sequence-gap')
          if (current.rawFrames.length >= MAX_RAW_FRAMES || total + byteLength > MAX_RAW_FRAME_BYTES) {
            fail('backpressure')
          }
          current.maxSentSequence = request.sequence
          current.rawFrames.push({ sequence: request.sequence, wireText: request.wireText, byteLength })
          update.objectStore(SESSION_STORE).put(current)
          await transactionDone(update)
        },
      }

      const commitInbound: CommitInboundFrame = async request => {
        requireOpen()
        const update = database.transaction([SESSION_STORE], 'readwrite', { durability: 'strict' })
        const current = await readSession(update, key)
        requireActiveSession(current, request.authority)
        if (
          current.inboundKeyId !== request.keyId
          || request.sequence !== current.lastInboundSequence + 1
          || request.ack < current.lastPeerAck
          || request.ack > current.maxSentSequence
        ) fail('sequence-gap')
        current.lastInboundSequence = request.sequence
        current.lastPeerAck = request.ack
        current.rawFrames = current.rawFrames.filter(frame => frame.sequence > request.ack)
        update.objectStore(SESSION_STORE).put(current)
        await transactionDone(update)
      }

      return {
        outbound,
        commitInbound,
        assertActive,
        async listUnacknowledgedFrames() {
          requireOpen()
          const read = database.transaction([SESSION_STORE], 'readonly')
          const current = await readSession(read, key)
          requireActiveSession(current, info.authority)
          await transactionDone(read)
          return Object.freeze(current.rawFrames.map(frame => frame.wireText))
        },
      }
    },

    async recoverySnapshot() {
      requireOpen()
      const transaction = database.transaction([DEVICE_STORE, SESSION_STORE], 'readonly')
      const record = await readDevice(transaction)
      if (record === undefined) {
        await transactionDone(transaction)
        return Object.freeze({ highestGeneration: 0, rawFrames: Object.freeze([]) })
      }
      if (record.currentSessionKey === undefined) {
        await transactionDone(transaction)
        return Object.freeze({
          highestGeneration: record.highestGeneration,
          rawFrames: Object.freeze([]),
        })
      }
      const session = await readSession(transaction, record.currentSessionKey)
      await transactionDone(transaction)
      return Object.freeze({
        highestGeneration: record.highestGeneration,
        authority: Object.freeze({ ...session.authority }),
        rawFrames: Object.freeze(session.rawFrames.map(frame => frame.wireText)),
      })
    },

    async clear() {
      requireOpen()
      const transaction = database.transaction([DEVICE_STORE, SESSION_STORE], 'readwrite', { durability: 'strict' })
      transaction.objectStore(DEVICE_STORE).clear()
      transaction.objectStore(SESSION_STORE).clear()
      await transactionDone(transaction)
    },

    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
