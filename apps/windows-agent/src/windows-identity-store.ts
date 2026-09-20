import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import {
  exportPublicJwk,
  importAgreementPublicKey,
  importSigningPublicKey,
  type HostAuthorizationMaterial,
  type HostGenerationReservationRequest,
} from '../../../packages/e2ee/src/index.ts'
import {
  GrantClaimsSchema,
  P256PublicJwkSchema,
  P256RawSignatureSchema,
  Secret32Schema,
  type GrantClaims,
  type P256PublicJwk,
} from '../../../packages/protocol/src/index.ts'
import type { ManagedDevice } from '../../../packages/codex-serve-client/src/index.ts'

import {
  protectForCurrentWindowsUser,
  restrictFileToCurrentWindowsUser,
  unprotectForCurrentWindowsUser,
  type WindowsDpapiOptions,
} from './windows-dpapi.ts'

const STATE_MAGIC = Buffer.from('CPID2', 'ascii')
const MAX_STATE_BYTES = 2 * 1024 * 1024
const MAX_AUTHORIZATIONS = 64
const MAX_GENERATION_REPLAYS = 2_048
const MAX_ACTION_FINGERPRINT_INPUT_BYTES = 512 * 1024
const ACTION_FINGERPRINT_DOMAIN = Buffer.from(
  'codex-plus/windows-action-fingerprint/v1\0',
  'utf8',
)
const encoder = new TextEncoder()
const subtle = globalThis.crypto.subtle

interface ReplayRecord {
  handshakeId: string
  clientNonce: string
  generation: number
}

interface PersistedAuthorization {
  status: 'active' | 'revoked'
  displayName?: string
  currentEpoch: number
  grantClaims: GrantClaims
  hostGrantSignature: string
  grantClaimsHash: string
  clientAgreementKey: P256PublicJwk
  clientSigningKey: P256PublicJwk
  hostAuthorizationRevision: number
  nextGeneration: number
  replays: ReplayRecord[]
}

interface IdentityMetadata {
  version: 1
  storeId: string
  stateRevision: number
  hostId: string
  hostDeviceId: string
  hostAgreementKey: P256PublicJwk
  hostSigningKey: P256PublicJwk
  hostAuthorizationRevision: number
  authorizations: PersistedAuthorization[]
}

interface DecodedIdentityState {
  metadata: IdentityMetadata
  agreementPrivatePkcs8: Buffer
  signingPrivatePkcs8: Buffer
  actionFingerprintKey: Buffer
  bootstrapCredential?: Buffer
}

export interface ActionRequestFingerprinter {
  readonly fingerprintCanonicalRequest: (canonicalBytes: Uint8Array) => Promise<string>
  close(): void
}

export interface WindowsHostIdentity {
  hostId: string
  hostDeviceId: string
  hostAgreementPrivateKey: CryptoKey
  hostAgreementPublicKey: CryptoKey
  hostSigningPrivateKey: CryptoKey
  hostSigningPublicKey: CryptoKey
  bootstrapCredential?: string
}

export interface LoadedHostAuthorization {
  material: HostAuthorizationMaterial
  hostAuthorizationRevision: number
  nextGeneration: number
}

export interface WindowsIdentityStoreOptions {
  workspaceRoot: string
  identityFile: string
  dpapi?: WindowsDpapiOptions
}

export class WindowsIdentityStoreError extends Error {
  constructor(readonly code: string) {
    super(`windows-identity-store:${code}`)
    this.name = 'WindowsIdentityStoreError'
  }
}

function fail(code: string): never {
  throw new WindowsIdentityStoreError(code)
}

function normalized(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function within(root: string, candidate: string): boolean {
  const path = relative(normalized(root), normalized(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function withinRuntimeData(workspaceRoot: string, candidate: string): boolean {
  return within(resolve(workspaceRoot, '.data'), candidate)
    || within(resolve(workspaceRoot, '.tmp'), candidate)
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('invalid-state')
  return value as number
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(value)) {
    fail('invalid-state')
  }
  return value
}

function displayName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 80
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail('invalid-state')
  return value
}

function samePublicKey(left: P256PublicJwk, right: P256PublicJwk): boolean {
  return left.kty === right.kty
    && left.crv === right.crv
    && left.x === right.x
    && left.y === right.y
}

function metadataRecord(value: unknown): IdentityMetadata {
  if (typeof value !== 'object' || value === null) fail('invalid-state')
  const candidate = value as Partial<IdentityMetadata>
  if (
    candidate.version !== 1
    || typeof candidate.storeId !== 'string'
    || candidate.storeId.length < 16
    || !Number.isSafeInteger(candidate.stateRevision)
    || (candidate.stateRevision ?? -1) < 1
    || !Array.isArray(candidate.authorizations)
    || candidate.authorizations.length > MAX_AUTHORIZATIONS
  ) fail('invalid-state')
  identifier(candidate.hostId)
  identifier(candidate.hostDeviceId)
  if (!Number.isSafeInteger(candidate.hostAuthorizationRevision) || (candidate.hostAuthorizationRevision ?? -1) < 0) {
    fail('invalid-state')
  }
  if (
    !P256PublicJwkSchema.safeParse(candidate.hostAgreementKey).success
    || !P256PublicJwkSchema.safeParse(candidate.hostSigningKey).success
  ) fail('invalid-state')
  for (const authorization of candidate.authorizations) authorizationRecord(authorization)
  return candidate as IdentityMetadata
}

function authorizationRecord(value: unknown): PersistedAuthorization {
  if (typeof value !== 'object' || value === null) fail('invalid-state')
  const candidate = value as Partial<PersistedAuthorization>
  const claims = GrantClaimsSchema.safeParse(candidate.grantClaims)
  if (
    (candidate.status !== 'active' && candidate.status !== 'revoked')
    || !claims.success
    || !P256RawSignatureSchema.safeParse(candidate.hostGrantSignature).success
    || !Secret32Schema.safeParse(candidate.grantClaimsHash).success
    || !P256PublicJwkSchema.safeParse(candidate.clientAgreementKey).success
    || !P256PublicJwkSchema.safeParse(candidate.clientSigningKey).success
    || !Array.isArray(candidate.replays)
    || candidate.replays.length > MAX_GENERATION_REPLAYS
  ) fail('invalid-state')
  if (candidate.displayName !== undefined) displayName(candidate.displayName)
  positive(candidate.hostAuthorizationRevision)
  positive(candidate.nextGeneration)
  if (positive(candidate.currentEpoch) < claims.data.authorizationEpoch) fail('invalid-state')
  for (const replay of candidate.replays) {
    if (typeof replay !== 'object' || replay === null) fail('invalid-state')
    identifier((replay as ReplayRecord).handshakeId)
    if (!Secret32Schema.safeParse((replay as ReplayRecord).clientNonce).success) fail('invalid-state')
    positive((replay as ReplayRecord).generation)
  }
  return { ...candidate, grantClaims: claims.data } as PersistedAuthorization
}

function encodeState(state: DecodedIdentityState): Buffer {
  const metadata = Buffer.from(JSON.stringify(state.metadata), 'utf8')
  const bootstrap = state.bootstrapCredential ?? Buffer.alloc(0)
  const lengths = [metadata.byteLength, state.agreementPrivatePkcs8.byteLength,
    state.signingPrivatePkcs8.byteLength, state.actionFingerprintKey.byteLength,
    bootstrap.byteLength]
  if (
    lengths.some(length => !Number.isSafeInteger(length) || length < 0)
    || state.actionFingerprintKey.byteLength !== 32
    || bootstrap.byteLength !== 0 && bootstrap.byteLength !== 32
  ) fail('invalid-state')
  const header = Buffer.alloc(STATE_MAGIC.byteLength + 20)
  STATE_MAGIC.copy(header)
  lengths.forEach((length, index) => header.writeUInt32BE(length, STATE_MAGIC.byteLength + index * 4))
  const output = Buffer.concat([
    header,
    metadata,
    state.agreementPrivatePkcs8,
    state.signingPrivatePkcs8,
    state.actionFingerprintKey,
    bootstrap,
  ])
  metadata.fill(0)
  if (output.byteLength > MAX_STATE_BYTES) {
    output.fill(0)
    fail('capacity-exceeded')
  }
  return output
}

function decodeState(plaintext: Buffer): DecodedIdentityState {
  if (
    plaintext.byteLength < STATE_MAGIC.byteLength + 20
    || plaintext.byteLength > MAX_STATE_BYTES
    || !plaintext.subarray(0, STATE_MAGIC.byteLength).equals(STATE_MAGIC)
  ) fail('invalid-state')
  const lengths = Array.from({ length: 5 }, (_, index) => (
    plaintext.readUInt32BE(STATE_MAGIC.byteLength + index * 4)
  ))
  const headerLength = STATE_MAGIC.byteLength + 20
  if (lengths.reduce((sum, value) => sum + value, headerLength) !== plaintext.byteLength) {
    fail('invalid-state')
  }
  let offset = headerLength
  const take = (length: number): Buffer => {
    const value = Buffer.from(plaintext.subarray(offset, offset + length))
    offset += length
    return value
  }
  const metadataBytes = take(lengths[0] ?? 0)
  const agreementPrivatePkcs8 = take(lengths[1] ?? 0)
  const signingPrivatePkcs8 = take(lengths[2] ?? 0)
  const actionFingerprintKey = take(lengths[3] ?? 0)
  const bootstrap = take(lengths[4] ?? 0)
  let metadata: IdentityMetadata
  try {
    metadata = metadataRecord(JSON.parse(metadataBytes.toString('utf8')))
  } catch (error) {
    metadataBytes.fill(0)
    agreementPrivatePkcs8.fill(0)
    signingPrivatePkcs8.fill(0)
    actionFingerprintKey.fill(0)
    bootstrap.fill(0)
    if (error instanceof WindowsIdentityStoreError) throw error
    return fail('invalid-state')
  }
  metadataBytes.fill(0)
  if (
    agreementPrivatePkcs8.byteLength < 1
    || signingPrivatePkcs8.byteLength < 1
    || actionFingerprintKey.byteLength !== 32
    || (bootstrap.byteLength !== 0 && bootstrap.byteLength !== 32)
  ) {
    agreementPrivatePkcs8.fill(0)
    signingPrivatePkcs8.fill(0)
    actionFingerprintKey.fill(0)
    bootstrap.fill(0)
    fail('invalid-state')
  }
  return {
    metadata,
    agreementPrivatePkcs8,
    signingPrivatePkcs8,
    actionFingerprintKey,
    ...(bootstrap.byteLength === 0 ? {} : { bootstrapCredential: bootstrap }),
  }
}

function wipeState(state: DecodedIdentityState): void {
  state.agreementPrivatePkcs8.fill(0)
  state.signingPrivatePkcs8.fill(0)
  state.actionFingerprintKey.fill(0)
  state.bootstrapCredential?.fill(0)
}

function createActionRequestFingerprinter(key: Buffer): ActionRequestFingerprinter {
  if (key.byteLength !== 32) {
    key.fill(0)
    fail('invalid-state')
  }
  let closed = false
  const fingerprintCanonicalRequest = async (canonicalBytes: Uint8Array): Promise<string> => {
    if (closed) fail('fingerprinter-closed')
    if (
      !(canonicalBytes instanceof Uint8Array)
      || canonicalBytes.byteLength < 1
      || canonicalBytes.byteLength > MAX_ACTION_FINGERPRINT_INPUT_BYTES
    ) fail('invalid-fingerprint-input')
    return createHmac('sha256', key)
      .update(ACTION_FINGERPRINT_DOMAIN)
      .update(canonicalBytes)
      .digest('base64url')
  }
  return Object.freeze({
    fingerprintCanonicalRequest,
    close: (): void => {
      if (closed) return
      closed = true
      key.fill(0)
    },
  })
}

async function importPrivateKeys(state: DecodedIdentityState): Promise<Readonly<{
  agreementPrivateKey: CryptoKey
  signingPrivateKey: CryptoKey
}>> {
  const [agreementPrivateKey, signingPrivateKey] = await Promise.all([
    subtle.importKey(
      'pkcs8',
      Uint8Array.from(state.agreementPrivatePkcs8),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    ),
    subtle.importKey(
      'pkcs8',
      Uint8Array.from(state.signingPrivatePkcs8),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    ),
  ])
  return { agreementPrivateKey, signingPrivateKey }
}

async function verifyKeyPairs(
  identity: WindowsHostIdentity,
): Promise<void> {
  const probe = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
  const [left, right] = await Promise.all([
    subtle.deriveBits({ name: 'ECDH', public: probe.publicKey }, identity.hostAgreementPrivateKey, 256),
    subtle.deriveBits({ name: 'ECDH', public: identity.hostAgreementPublicKey }, probe.privateKey, 256),
  ])
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  const agreementMatches = leftBytes.equals(rightBytes)
  leftBytes.fill(0)
  rightBytes.fill(0)
  new Uint8Array(left).fill(0)
  new Uint8Array(right).fill(0)
  if (!agreementMatches) fail('identity-mismatch')
  const challenge = encoder.encode('codex-plus-windows-identity-check-v1')
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.hostSigningPrivateKey,
    challenge,
  )
  if (!await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.hostSigningPublicKey,
    signature,
    challenge,
  )) fail('identity-mismatch')
}

async function writeFileAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filePath)
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    fail('storage-failed')
  }
}

export class WindowsIdentityStore {
  readonly #workspaceRoot: string
  readonly #identityFile: string
  readonly #anchorFile: string
  readonly #lockFile: string
  readonly #dpapi: WindowsDpapiOptions

  private constructor(
    workspaceRoot: string,
    identityFile: string,
    dpapi: WindowsDpapiOptions,
  ) {
    this.#workspaceRoot = workspaceRoot
    this.#identityFile = identityFile
    this.#anchorFile = `${identityFile}.anchor`
    this.#lockFile = `${identityFile}.lock`
    this.#dpapi = dpapi
  }

  static async open(options: WindowsIdentityStoreOptions): Promise<WindowsIdentityStore> {
    if (process.platform !== 'win32') fail('unsupported-platform')
    if (!isAbsolute(options.workspaceRoot) || !isAbsolute(options.identityFile)) fail('invalid-path')
    const workspaceRoot = await realpath(options.workspaceRoot).catch(() => fail('invalid-path'))
    if (!withinRuntimeData(workspaceRoot, options.identityFile)) fail('invalid-path')
    const parent = dirname(options.identityFile)
    await mkdir(parent, { recursive: true })
    const realParent = await realpath(parent).catch(() => fail('invalid-path'))
    if (!within(workspaceRoot, realParent) || normalized(realParent) !== normalized(parent)) fail('invalid-path')
    return new WindowsIdentityStore(workspaceRoot, resolve(options.identityFile), options.dpapi ?? {})
  }

  async initialize(): Promise<WindowsHostIdentity> {
    return await this.#withLock(async () => {
      if (await this.#exists(this.#identityFile) || await this.#exists(this.#anchorFile)) {
        fail('already-initialized')
      }
      const [agreementPair, signingPair] = await Promise.all([
        subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
        subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
      ])
      const [agreementPkcs8, signingPkcs8, hostAgreementKey, hostSigningKey] = await Promise.all([
        subtle.exportKey('pkcs8', agreementPair.privateKey),
        subtle.exportKey('pkcs8', signingPair.privateKey),
        exportPublicJwk(agreementPair.publicKey),
        exportPublicJwk(signingPair.publicKey),
      ])
      const state: DecodedIdentityState = {
        metadata: {
          version: 1,
          storeId: `store.${randomUUID()}`,
          stateRevision: 1,
          hostId: `host.${randomUUID()}`,
          hostDeviceId: `windows.${randomUUID()}`,
          hostAgreementKey,
          hostSigningKey,
          hostAuthorizationRevision: 0,
          authorizations: [],
        },
        agreementPrivatePkcs8: Buffer.from(agreementPkcs8),
        signingPrivatePkcs8: Buffer.from(signingPkcs8),
        actionFingerprintKey: randomBytes(32),
        bootstrapCredential: randomBytes(32),
      }
      try {
        await this.#persist(state, true)
        return await this.#identityFromState(state)
      } finally {
        wipeState(state)
      }
    })
  }

  async loadIdentity(): Promise<WindowsHostIdentity> {
    const state = await this.#readState()
    try {
      return await this.#identityFromState(state)
    } finally {
      wipeState(state)
    }
  }

  async openActionRequestFingerprinter(): Promise<ActionRequestFingerprinter> {
    const state = await this.#readState()
    try {
      return createActionRequestFingerprinter(Buffer.from(state.actionFingerprintKey))
    } finally {
      wipeState(state)
    }
  }

  async exportBootstrap(exportFile: string): Promise<void> {
    if (!isAbsolute(exportFile) || !withinRuntimeData(this.#workspaceRoot, exportFile)) fail('invalid-path')
    const parent = dirname(exportFile)
    await mkdir(parent, { recursive: true })
    const realParent = await realpath(parent).catch(() => fail('invalid-path'))
    if (!within(this.#workspaceRoot, realParent) || normalized(realParent) !== normalized(parent)) {
      fail('invalid-path')
    }
    const state = await this.#readState()
    try {
      if (state.bootstrapCredential === undefined) fail('bootstrap-unavailable')
      const text = state.bootstrapCredential.toString('base64url')
      let handle
      let created = false
      try {
        handle = await open(exportFile, 'wx', 0o600)
        created = true
        await handle.writeFile(text, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await restrictFileToCurrentWindowsUser(exportFile, this.#dpapi)
      } catch {
        await handle?.close().catch(() => undefined)
        if (created) await unlink(exportFile).catch(() => undefined)
        fail('bootstrap-export-failed')
      }
    } finally {
      wipeState(state)
    }
  }

  async markBootstrapRegistered(): Promise<void> {
    await this.#mutate(state => {
      if (state.bootstrapCredential === undefined) return
      state.bootstrapCredential.fill(0)
      state.bootstrapCredential = undefined
    })
  }

  async commitAuthorization(
    authorizationMaterial: HostAuthorizationMaterial,
  ): Promise<Readonly<{ hostAuthorizationRevision: number; nextGeneration: number }>> {
    const claimsResult = GrantClaimsSchema.safeParse(authorizationMaterial.grantClaims)
    if (!claimsResult.success) fail('invalid-authorization')
    const [clientAgreementKey, clientSigningKey] = await Promise.all([
      exportPublicJwk(authorizationMaterial.clientAgreementPublicKey),
      exportPublicJwk(authorizationMaterial.clientSigningPublicKey),
    ])
    let result: Readonly<{ hostAuthorizationRevision: number; nextGeneration: number }> | undefined
    await this.#mutate(state => {
      const claims = claimsResult.data
      if (
        claims.hostId !== state.metadata.hostId
        || claims.hostDeviceId !== state.metadata.hostDeviceId
        || !samePublicKey(claims.hostAgreementKey, state.metadata.hostAgreementKey)
        || !samePublicKey(claims.hostSigningKey, state.metadata.hostSigningKey)
        || !samePublicKey(claims.clientAgreementKey, clientAgreementKey)
        || !samePublicKey(claims.clientSigningKey, clientSigningKey)
      ) fail('invalid-authorization')
      if (state.metadata.authorizations.some(value => (
        value.grantClaims.authorizationId === claims.authorizationId
      ))) fail('authorization-conflict')
      if (state.metadata.authorizations.length >= MAX_AUTHORIZATIONS) fail('capacity-exceeded')
      const hostAuthorizationRevision = positive(state.metadata.hostAuthorizationRevision + 1)
      const nextGeneration = 1
      state.metadata.hostAuthorizationRevision = hostAuthorizationRevision
      state.metadata.authorizations.push({
        status: 'active',
        currentEpoch: claims.authorizationEpoch,
        grantClaims: claims,
        hostGrantSignature: authorizationMaterial.hostGrantSignature,
        grantClaimsHash: authorizationMaterial.grantClaimsHash,
        clientAgreementKey,
        clientSigningKey,
        hostAuthorizationRevision,
        nextGeneration,
        replays: [],
      })
      result = Object.freeze({ hostAuthorizationRevision, nextGeneration })
    })
    if (result === undefined) fail('storage-failed')
    return result
  }

  async activeAuthorizationIds(): Promise<readonly string[]> {
    const state = await this.#readState()
    try {
      return Object.freeze(state.metadata.authorizations
        .filter(value => value.status === 'active')
        .map(value => value.grantClaims.authorizationId))
    } finally {
      wipeState(state)
    }
  }

  async listManagedDevices(input: Readonly<{
    currentClientDeviceId: string
    generatedAt: number
    onlineClientDeviceIds?: readonly string[]
  }>): Promise<readonly ManagedDevice[]> {
    identifier(input.currentClientDeviceId)
    if (!Number.isSafeInteger(input.generatedAt) || input.generatedAt < 0) fail('invalid-state')
    const onlineClientDeviceIds = input.onlineClientDeviceIds ?? [input.currentClientDeviceId]
    if (
      !Array.isArray(onlineClientDeviceIds)
      || onlineClientDeviceIds.length > MAX_AUTHORIZATIONS
      || new Set(onlineClientDeviceIds).size !== onlineClientDeviceIds.length
    ) fail('invalid-state')
    for (const deviceId of onlineClientDeviceIds) identifier(deviceId)
    const online = new Set(onlineClientDeviceIds)
    const state = await this.#readState()
    try {
      const devices = state.metadata.authorizations.map((authorization): ManagedDevice => {
        const deviceId = authorization.grantClaims.clientDeviceId
        const isCurrent = deviceId === input.currentClientDeviceId
        const shortId = deviceId.slice(-8)
        return {
          deviceId,
          displayName: authorization.displayName ?? (isCurrent ? '当前设备' : `设备 ${shortId}`),
          shortId,
          signingFingerprint: authorization.grantClaims.clientSigningFingerprint,
          authorizationId: authorization.grantClaims.authorizationId,
          authorizationEpoch: authorization.currentEpoch,
          status: authorization.status,
          presence: authorization.status === 'active' && online.has(deviceId)
            ? 'online'
            : authorization.status === 'revoked' ? 'offline' : 'unknown',
          pairedAt: authorization.grantClaims.issuedAt,
          lastSeenAt: authorization.status === 'active' && online.has(deviceId) ? input.generatedAt : null,
          isCurrent,
        }
      })
      devices.sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || right.pairedAt - left.pairedAt)
      return Object.freeze(devices.map(device => Object.freeze(device)))
    } finally {
      wipeState(state)
    }
  }

  async renameManagedDevice(input: Readonly<{
    deviceId: string
    authorizationId: string
    authorizationEpoch: number
    displayName: string
  }>): Promise<void> {
    identifier(input.deviceId)
    identifier(input.authorizationId)
    positive(input.authorizationEpoch)
    const name = displayName(input.displayName)
    await this.#mutate(state => {
      const authorization = state.metadata.authorizations.find(value => (
        value.grantClaims.authorizationId === input.authorizationId
      ))
      if (
        authorization === undefined
        || authorization.status !== 'active'
        || authorization.grantClaims.clientDeviceId !== input.deviceId
        || authorization.currentEpoch !== input.authorizationEpoch
      ) fail('stale-authority')
      authorization.displayName = name
    })
  }

  async revokeManagedDevice(input: Readonly<{
    currentClientDeviceId: string
    deviceId: string
    authorizationId: string
    authorizationEpoch: number
  }>): Promise<Readonly<{
    hostId: string
    hostDeviceId: string
    clientDeviceId: string
    authorizationId: string
    authorizationEpoch: number
    hostAuthorizationRevision: number
    status: 'revoked'
  }>> {
    identifier(input.currentClientDeviceId)
    identifier(input.deviceId)
    identifier(input.authorizationId)
    positive(input.authorizationEpoch)
    if (input.currentClientDeviceId === input.deviceId) fail('stale-authority')
    let result: Readonly<{
      hostId: string
      hostDeviceId: string
      clientDeviceId: string
      authorizationId: string
      authorizationEpoch: number
      hostAuthorizationRevision: number
      status: 'revoked'
    }> | undefined
    await this.#mutate(state => {
      const authorization = state.metadata.authorizations.find(value => (
        value.grantClaims.authorizationId === input.authorizationId
      ))
      if (
        authorization === undefined
        || authorization.status !== 'active'
        || authorization.grantClaims.clientDeviceId !== input.deviceId
        || authorization.currentEpoch !== input.authorizationEpoch
      ) fail('stale-authority')
      const authorizationEpoch = positive(authorization.currentEpoch + 1)
      const hostAuthorizationRevision = positive(state.metadata.hostAuthorizationRevision + 1)
      authorization.status = 'revoked'
      authorization.currentEpoch = authorizationEpoch
      authorization.hostAuthorizationRevision = hostAuthorizationRevision
      state.metadata.hostAuthorizationRevision = hostAuthorizationRevision
      result = Object.freeze({
        hostId: state.metadata.hostId,
        hostDeviceId: state.metadata.hostDeviceId,
        clientDeviceId: authorization.grantClaims.clientDeviceId,
        authorizationId: authorization.grantClaims.authorizationId,
        authorizationEpoch,
        hostAuthorizationRevision,
        status: 'revoked' as const,
      })
    })
    if (result === undefined) fail('storage-failed')
    return result
  }

  async revokeAuthorization(input: Readonly<{
    authorizationId: string
    authorizationEpoch: number
    hostAuthorizationRevision: number
  }>): Promise<void> {
    await this.#mutate(state => {
      const authorization = state.metadata.authorizations.find(value => (
        value.grantClaims.authorizationId === input.authorizationId
      ))
      if (
        authorization === undefined
        || authorization.status !== 'active'
        || !Number.isSafeInteger(input.authorizationEpoch)
        || input.authorizationEpoch <= authorization.currentEpoch
        || !Number.isSafeInteger(input.hostAuthorizationRevision)
        || input.hostAuthorizationRevision <= state.metadata.hostAuthorizationRevision
      ) fail('stale-authority')
      authorization.status = 'revoked'
      authorization.currentEpoch = input.authorizationEpoch
      authorization.hostAuthorizationRevision = input.hostAuthorizationRevision
      state.metadata.hostAuthorizationRevision = input.hostAuthorizationRevision
    })
  }

  async loadAuthorization(authorizationId: string): Promise<LoadedHostAuthorization> {
    const state = await this.#readState()
    try {
      const authorization = state.metadata.authorizations.find(value => (
        value.grantClaims.authorizationId === authorizationId && value.status === 'active'
      ))
      if (authorization === undefined) fail('authorization-unavailable')
      const identity = await this.#identityFromState(state)
      const [clientAgreementPublicKey, clientSigningPublicKey] = await Promise.all([
        importAgreementPublicKey(authorization.clientAgreementKey),
        importSigningPublicKey(authorization.clientSigningKey),
      ])
      return {
        material: {
          grantClaims: authorization.grantClaims,
          hostGrantSignature: authorization.hostGrantSignature,
          grantClaimsHash: authorization.grantClaimsHash,
          clientAgreementPublicKey,
          clientSigningPublicKey,
        },
        hostAuthorizationRevision: authorization.hostAuthorizationRevision,
        nextGeneration: authorization.nextGeneration,
      }
    } finally {
      wipeState(state)
    }
  }

  async reserveGeneration(request: Readonly<HostGenerationReservationRequest>): Promise<number> {
    let reserved = 0
    await this.#mutate(state => {
      const authorization = state.metadata.authorizations.find(value => (
        value.status === 'active'
        && value.grantClaims.authorizationId === request.authorizationId
      ))
      if (
        authorization === undefined
        || request.hostId !== state.metadata.hostId
        || request.hostDeviceId !== state.metadata.hostDeviceId
        || request.clientDeviceId !== authorization.grantClaims.clientDeviceId
        || request.authorizationEpoch !== authorization.currentEpoch
        || authorization.replays.some(value => (
          value.handshakeId === request.handshakeId || value.clientNonce === request.clientNonce
        ))
      ) fail('stale-authority')
      if (authorization.replays.length >= MAX_GENERATION_REPLAYS) fail('capacity-exceeded')
      reserved = positive(authorization.nextGeneration)
      authorization.nextGeneration = reserved + 1
      authorization.replays.push({
        handshakeId: request.handshakeId,
        clientNonce: request.clientNonce,
        generation: reserved,
      })
    })
    return reserved
  }

  async #identityFromState(state: DecodedIdentityState): Promise<WindowsHostIdentity> {
    const [privateKeys, hostAgreementPublicKey, hostSigningPublicKey] = await Promise.all([
      importPrivateKeys(state),
      importAgreementPublicKey(state.metadata.hostAgreementKey),
      importSigningPublicKey(state.metadata.hostSigningKey),
    ])
    const identity: WindowsHostIdentity = {
      hostId: state.metadata.hostId,
      hostDeviceId: state.metadata.hostDeviceId,
      hostAgreementPrivateKey: privateKeys.agreementPrivateKey,
      hostAgreementPublicKey,
      hostSigningPrivateKey: privateKeys.signingPrivateKey,
      hostSigningPublicKey,
      ...(state.bootstrapCredential === undefined
        ? {}
        : { bootstrapCredential: state.bootstrapCredential.toString('base64url') }),
    }
    await verifyKeyPairs(identity)
    return identity
  }

  async #readState(): Promise<DecodedIdentityState> {
    const [ciphertext, anchorCiphertext] = await Promise.all([
      this.#readProtectedFile(this.#identityFile),
      this.#readProtectedFile(this.#anchorFile),
    ])
    const [plaintext, anchorPlaintext] = await Promise.all([
      unprotectForCurrentWindowsUser(ciphertext, this.#dpapi),
      unprotectForCurrentWindowsUser(anchorCiphertext, this.#dpapi),
    ])
    ciphertext.fill(0)
    anchorCiphertext.fill(0)
    try {
      const state = decodeState(plaintext)
      const anchor: unknown = JSON.parse(anchorPlaintext.toString('utf8'))
      if (
        typeof anchor !== 'object'
        || anchor === null
        || (anchor as { version?: unknown }).version !== 1
        || (anchor as { storeId?: unknown }).storeId !== state.metadata.storeId
        || (anchor as { stateRevision?: unknown }).stateRevision !== state.metadata.stateRevision
      ) {
        wipeState(state)
        fail('rollback-detected')
      }
      return state
    } catch (error) {
      if (error instanceof WindowsIdentityStoreError) throw error
      return fail('invalid-state')
    } finally {
      plaintext.fill(0)
      anchorPlaintext.fill(0)
    }
  }

  async #persist(state: DecodedIdentityState, create: boolean): Promise<void> {
    const plaintext = encodeState(state)
    const anchorPlaintext = Buffer.from(JSON.stringify({
      version: 1,
      storeId: state.metadata.storeId,
      stateRevision: state.metadata.stateRevision,
    }), 'utf8')
    const [ciphertext, anchorCiphertext] = await Promise.all([
      protectForCurrentWindowsUser(plaintext, this.#dpapi),
      protectForCurrentWindowsUser(anchorPlaintext, this.#dpapi),
    ])
    plaintext.fill(0)
    anchorPlaintext.fill(0)
    try {
      if (create && (await this.#exists(this.#identityFile) || await this.#exists(this.#anchorFile))) {
        fail('already-initialized')
      }
      await writeFileAtomic(this.#identityFile, ciphertext)
      await restrictFileToCurrentWindowsUser(this.#identityFile, this.#dpapi)
      await writeFileAtomic(this.#anchorFile, anchorCiphertext)
      await restrictFileToCurrentWindowsUser(this.#anchorFile, this.#dpapi)
    } finally {
      ciphertext.fill(0)
      anchorCiphertext.fill(0)
    }
  }

  async #mutate(update: (state: DecodedIdentityState) => void): Promise<void> {
    await this.#withLock(async () => {
      const state = await this.#readState()
      try {
        update(state)
        state.metadata.stateRevision = positive(state.metadata.stateRevision + 1)
        await this.#persist(state, false)
      } finally {
        wipeState(state)
      }
    })
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    let lock
    try {
      lock = await open(this.#lockFile, 'wx', 0o600)
    } catch {
      return fail('backpressure')
    }
    try {
      return await operation()
    } finally {
      await lock.close().catch(() => undefined)
      await unlink(this.#lockFile).catch(() => undefined)
    }
  }

  async #readProtectedFile(filePath: string): Promise<Buffer> {
    try {
      const metadata = await lstat(filePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > MAX_STATE_BYTES) {
        fail('invalid-state')
      }
      return await readFile(filePath)
    } catch (error) {
      if (error instanceof WindowsIdentityStoreError) throw error
      return fail('missing-store')
    }
  }

  async #exists(filePath: string): Promise<boolean> {
    try {
      await lstat(filePath)
      return true
    } catch (error) {
      return typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code !== 'ENOENT'
        ? fail('storage-failed')
        : false
    }
  }
}
