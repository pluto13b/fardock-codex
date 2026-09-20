import {
  createHash,
  createPublicKey,
  randomBytes,
} from 'node:crypto'
import {
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from 'node:path'

import {
  Hash32Schema,
  OpaqueIdentifierSchema,
  P256PublicJwkSchema,
  RelayAuthorizationPutSchema,
  type P256PublicJwk,
  type RelayAuthorizationPut,
} from '@codex-plus/protocol'

export const MAX_R3_RELAY_STATE_BYTES = 512 * 1024
export const MAX_R3_RELAY_AUTHORIZATIONS = 512

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface R3RelayHostRegistration {
  hostId: string
  hostDeviceId: string
  hostSigningKey: P256PublicJwk
  hostSigningFingerprint: string
}

export interface R3RelayActiveAuthorizationRecord {
  authorizationId: string
  clientDeviceId: string
  authorizationEpoch: number
  hostAuthorizationRevision: number
  status: 'active'
  clientSigningKey: P256PublicJwk
  clientSigningFingerprint: string
}

export interface R3RelayRevokedAuthorizationRecord {
  authorizationId: string
  clientDeviceId: string
  authorizationEpoch: number
  hostAuthorizationRevision: number
  status: 'revoked'
}

export type R3RelayAuthorizationRecord =
  | R3RelayActiveAuthorizationRecord
  | R3RelayRevokedAuthorizationRecord

export interface R3RelayPersistedState {
  stateVersion: 1
  registrationClosed: true
  host: R3RelayHostRegistration
  hostAuthorizationRevision: number
  authorizations: R3RelayAuthorizationRecord[]
}

export interface R3RelayAuthorizationRoute {
  hostId: string
  hostDeviceId: string
  clientDeviceId: string
  authorizationId: string
  authorizationEpoch: number
}

export interface R3RelayAuthorizationApplyResult {
  outcome: 'applied' | 'idempotent'
  authorization: R3RelayAuthorizationRecord
}

export class R3RelayStateError extends Error {
  constructor() {
    super('R3 Relay state operation failed.')
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'R3RelayStateError',
    })
  }
}

function fail(): never {
  throw new R3RelayStateError()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every(key => expected.includes(key))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 1
}

function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizePublicKey(value: unknown): P256PublicJwk | undefined {
  const parsed = P256PublicJwkSchema.safeParse(value)
  if (!parsed.success) return undefined

  try {
    const imported = createPublicKey({
      key: parsed.data,
      format: 'jwk',
    })
    if (
      imported.asymmetricKeyType !== 'ec'
      || imported.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      return undefined
    }
    const exported = imported.export({ format: 'jwk' })
    if (
      exported.kty !== parsed.data.kty
      || exported.crv !== parsed.data.crv
      || exported.x !== parsed.data.x
      || exported.y !== parsed.data.y
    ) {
      return undefined
    }
  } catch {
    return undefined
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: parsed.data.x,
    y: parsed.data.y,
  }
}

function fingerprintPublicKey(key: P256PublicJwk): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }), 'utf8')
    .digest('base64url')
}

function normalizeKeyAndFingerprint(
  keyValue: unknown,
  fingerprintValue: unknown,
): { key: P256PublicJwk; fingerprint: string } | undefined {
  const key = normalizePublicKey(keyValue)
  const fingerprint = Hash32Schema.safeParse(fingerprintValue)
  if (
    key === undefined
    || !fingerprint.success
    || fingerprint.data !== fingerprintPublicKey(key)
  ) {
    return undefined
  }
  return { key, fingerprint: fingerprint.data }
}

function normalizeHostRegistration(value: unknown): R3RelayHostRegistration | undefined {
  if (!isRecord(value)) return undefined
  const expected = [
    'hostId',
    'hostDeviceId',
    'hostSigningKey',
    'hostSigningFingerprint',
  ] as const
  if (!hasOnlyKeys(value, expected)) return undefined

  const hostId = OpaqueIdentifierSchema.safeParse(value.hostId)
  const hostDeviceId = OpaqueIdentifierSchema.safeParse(value.hostDeviceId)
  const signing = normalizeKeyAndFingerprint(
    value.hostSigningKey,
    value.hostSigningFingerprint,
  )
  if (!hostId.success || !hostDeviceId.success || signing === undefined) return undefined

  return {
    hostId: hostId.data,
    hostDeviceId: hostDeviceId.data,
    hostSigningKey: signing.key,
    hostSigningFingerprint: signing.fingerprint,
  }
}

function normalizeAuthorizationRecord(
  value: unknown,
  hostDeviceId: string,
): R3RelayAuthorizationRecord | undefined {
  if (!isRecord(value)) return undefined

  const commonKeys = [
    'authorizationId',
    'clientDeviceId',
    'authorizationEpoch',
    'hostAuthorizationRevision',
    'status',
  ] as const
  const activeKeys = [
    ...commonKeys,
    'clientSigningKey',
    'clientSigningFingerprint',
  ] as const
  if (
    (value.status === 'active' && !hasOnlyKeys(value, activeKeys))
    || (value.status === 'revoked' && !hasOnlyKeys(value, commonKeys))
    || (value.status !== 'active' && value.status !== 'revoked')
  ) {
    return undefined
  }

  const authorizationId = OpaqueIdentifierSchema.safeParse(value.authorizationId)
  const clientDeviceId = OpaqueIdentifierSchema.safeParse(value.clientDeviceId)
  if (
    !authorizationId.success
    || !clientDeviceId.success
    || clientDeviceId.data === hostDeviceId
    || !isPositiveSafeInteger(value.authorizationEpoch)
    || !isPositiveSafeInteger(value.hostAuthorizationRevision)
  ) {
    return undefined
  }

  if (value.status === 'revoked') {
    if (value.authorizationEpoch < 2) return undefined
    return {
      authorizationId: authorizationId.data,
      clientDeviceId: clientDeviceId.data,
      authorizationEpoch: value.authorizationEpoch,
      hostAuthorizationRevision: value.hostAuthorizationRevision,
      status: 'revoked',
    }
  }

  const signing = normalizeKeyAndFingerprint(
    value.clientSigningKey,
    value.clientSigningFingerprint,
  )
  if (signing === undefined) return undefined
  return {
    authorizationId: authorizationId.data,
    clientDeviceId: clientDeviceId.data,
    authorizationEpoch: value.authorizationEpoch,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
    status: 'active',
    clientSigningKey: signing.key,
    clientSigningFingerprint: signing.fingerprint,
  }
}

function normalizePersistedState(value: unknown): R3RelayPersistedState | undefined {
  if (!isRecord(value)) return undefined
  const stateKeys = [
    'stateVersion',
    'registrationClosed',
    'host',
    'hostAuthorizationRevision',
    'authorizations',
  ] as const
  if (!hasOnlyKeys(value, stateKeys)) return undefined
  if (
    value.stateVersion !== 1
    || value.registrationClosed !== true
    || !isNonNegativeSafeInteger(value.hostAuthorizationRevision)
    || !Array.isArray(value.authorizations)
    || value.authorizations.length > MAX_R3_RELAY_AUTHORIZATIONS
  ) {
    return undefined
  }

  const host = normalizeHostRegistration(value.host)
  if (host === undefined) return undefined

  const authorizations: R3RelayAuthorizationRecord[] = []
  const authorizationIds = new Set<string>()
  const clientDeviceIds = new Set<string>()
  const revisions = new Set<number>()
  let maximumRevision = 0
  for (const candidate of value.authorizations) {
    const authorization = normalizeAuthorizationRecord(candidate, host.hostDeviceId)
    if (
      authorization === undefined
      || authorizationIds.has(authorization.authorizationId)
      || clientDeviceIds.has(authorization.clientDeviceId)
      || revisions.has(authorization.hostAuthorizationRevision)
      || authorization.hostAuthorizationRevision > value.hostAuthorizationRevision
    ) {
      return undefined
    }
    authorizationIds.add(authorization.authorizationId)
    clientDeviceIds.add(authorization.clientDeviceId)
    revisions.add(authorization.hostAuthorizationRevision)
    maximumRevision = Math.max(maximumRevision, authorization.hostAuthorizationRevision)
    authorizations.push(authorization)
  }

  authorizations.sort((left, right) => compareIdentifiers(
    left.authorizationId,
    right.authorizationId,
  ))
  if (maximumRevision !== value.hostAuthorizationRevision) return undefined

  return {
    stateVersion: 1,
    registrationClosed: true,
    host,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
    authorizations,
  }
}

function encodePersistedState(value: unknown): string {
  const normalized = normalizePersistedState(value)
  if (normalized === undefined) fail()
  const encoded = JSON.stringify(normalized)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_R3_RELAY_STATE_BYTES) fail()
  return encoded
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function requireAbsoluteStateFile(stateFile: string): string {
  if (typeof stateFile !== 'string' || stateFile.length === 0 || !isAbsolute(stateFile)) fail()
  return stateFile
}

async function closeHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.close()
  } catch {
    fail()
  }
}

async function syncParentDirectory(parent: string): Promise<void> {
  if (process.platform === 'win32') return
  let directory
  try {
    directory = await open(parent, 'r')
    await directory.sync()
  } catch {
    fail()
  } finally {
    if (directory !== undefined) await closeHandle(directory)
  }
}

async function readStateFile(stateFile: string): Promise<R3RelayPersistedState | undefined> {
  let handle
  try {
    handle = await open(stateFile, 'r')
  } catch (error) {
    if (isEnoent(error)) return undefined
    fail()
  }

  try {
    const bounded = Buffer.alloc(MAX_R3_RELAY_STATE_BYTES + 1)
    let offset = 0
    while (offset < bounded.byteLength) {
      const result = await handle.read(
        bounded,
        offset,
        bounded.byteLength - offset,
        offset,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > MAX_R3_RELAY_STATE_BYTES) fail()
    const text = decoder.decode(bounded.subarray(0, offset))
    const parsed = JSON.parse(text) as unknown
    const normalized = normalizePersistedState(parsed)
    if (normalized === undefined || JSON.stringify(normalized) !== text) fail()
    return normalized
  } catch {
    fail()
  } finally {
    await closeHandle(handle)
  }
}

export async function loadR3RelayState(
  stateFile: string,
): Promise<R3RelayPersistedState | undefined> {
  try {
    return await readStateFile(requireAbsoluteStateFile(stateFile))
  } catch {
    fail()
  }
}

async function createHostStateFile(
  stateFile: string,
  registrationValue: unknown,
): Promise<R3RelayPersistedState> {
  const registration = normalizeHostRegistration(registrationValue)
  if (registration === undefined) fail()
  const state: R3RelayPersistedState = {
    stateVersion: 1,
    registrationClosed: true,
    host: registration,
    hostAuthorizationRevision: 0,
    authorizations: [],
  }
  const encoded = encodePersistedState(state)
  const parent = dirname(stateFile)

  let handle
  try {
    await mkdir(parent, { recursive: true })
    handle = await open(stateFile, 'wx', 0o600)
    await handle.writeFile(encoded, { encoding: 'utf8' })
    await handle.sync()
  } catch {
    // A partially created target is deliberately retained. Its presence keeps
    // bootstrap closed, and strict loading will reject it after a crash.
    fail()
  } finally {
    if (handle !== undefined) await closeHandle(handle)
  }
  await syncParentDirectory(parent)
  return state
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isEnoent(error)) fail()
  }
}

async function replaceStateFile(
  stateFile: string,
  state: R3RelayPersistedState,
): Promise<void> {
  const encoded = encodePersistedState(state)
  const parent = dirname(stateFile)
  const temporaryFile = join(
    parent,
    `.${basename(stateFile)}.${randomBytes(16).toString('base64url')}.tmp`,
  )
  let handle
  let replaced = false
  try {
    handle = await open(temporaryFile, 'wx', 0o600)
    await handle.writeFile(encoded, { encoding: 'utf8' })
    await handle.sync()
    await closeHandle(handle)
    handle = undefined
    await rename(temporaryFile, stateFile)
    replaced = true
    await syncParentDirectory(parent)
  } catch {
    fail()
  } finally {
    if (handle !== undefined) await closeHandle(handle)
    if (!replaced) await removeIfPresent(temporaryFile)
  }
}

async function withStateLock<T>(stateFile: string, action: () => Promise<T>): Promise<T> {
  const parent = dirname(stateFile)
  const lockFile = join(parent, `.${basename(stateFile)}.lock`)
  let handle
  try {
    handle = await open(lockFile, 'wx', 0o600)
  } catch {
    fail()
  }

  try {
    return await action()
  } catch {
    fail()
  } finally {
    await closeHandle(handle)
    await removeIfPresent(lockFile)
  }
}

function cloneHost(host: R3RelayHostRegistration): R3RelayHostRegistration {
  return {
    hostId: host.hostId,
    hostDeviceId: host.hostDeviceId,
    hostSigningKey: { ...host.hostSigningKey },
    hostSigningFingerprint: host.hostSigningFingerprint,
  }
}

function cloneAuthorization(
  authorization: R3RelayActiveAuthorizationRecord,
): R3RelayActiveAuthorizationRecord
function cloneAuthorization(
  authorization: R3RelayRevokedAuthorizationRecord,
): R3RelayRevokedAuthorizationRecord
function cloneAuthorization(
  authorization: R3RelayAuthorizationRecord,
): R3RelayAuthorizationRecord
function cloneAuthorization(
  authorization: R3RelayAuthorizationRecord,
): R3RelayAuthorizationRecord {
  if (authorization.status === 'revoked') return { ...authorization }
  return {
    ...authorization,
    clientSigningKey: { ...authorization.clientSigningKey },
  }
}

function cloneState(state: R3RelayPersistedState): R3RelayPersistedState {
  return {
    stateVersion: 1,
    registrationClosed: true,
    host: cloneHost(state.host),
    hostAuthorizationRevision: state.hostAuthorizationRevision,
    authorizations: state.authorizations.map(cloneAuthorization),
  }
}

function authorizationFromPut(update: RelayAuthorizationPut): R3RelayAuthorizationRecord {
  if (update.status === 'revoked') {
    return {
      authorizationId: update.authorizationId,
      clientDeviceId: update.clientDeviceId,
      authorizationEpoch: update.authorizationEpoch,
      hostAuthorizationRevision: update.hostAuthorizationRevision,
      status: 'revoked',
    }
  }

  const signing = normalizeKeyAndFingerprint(
    update.clientSigningKey,
    update.clientSigningFingerprint,
  )
  if (signing === undefined) fail()
  return {
    authorizationId: update.authorizationId,
    clientDeviceId: update.clientDeviceId,
    authorizationEpoch: update.authorizationEpoch,
    hostAuthorizationRevision: update.hostAuthorizationRevision,
    status: 'active',
    clientSigningKey: signing.key,
    clientSigningFingerprint: signing.fingerprint,
  }
}

function applyAuthorizationToState(
  state: R3RelayPersistedState,
  updateValue: unknown,
): { state: R3RelayPersistedState; result: R3RelayAuthorizationApplyResult } {
  const parsed = RelayAuthorizationPutSchema.safeParse(updateValue)
  if (!parsed.success) fail()
  const update = parsed.data
  if (
    update.hostId !== state.host.hostId
    || update.hostDeviceId !== state.host.hostDeviceId
  ) {
    fail()
  }

  const incoming = authorizationFromPut(update)
  const existingIndex = state.authorizations.findIndex(
    authorization => authorization.authorizationId === incoming.authorizationId,
  )
  const existing = state.authorizations[existingIndex]

  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(incoming)) {
    return {
      state,
      result: { outcome: 'idempotent', authorization: cloneAuthorization(existing) },
    }
  }

  if (
    update.hostAuthorizationRevision <= state.hostAuthorizationRevision
    || state.authorizations.some(authorization => (
      authorization.clientDeviceId === update.clientDeviceId
      && authorization.authorizationId !== update.authorizationId
    ))
  ) {
    fail()
  }

  if (existing === undefined) {
    if (update.status !== 'active' || update.authorizationEpoch !== 1) fail()
    if (state.authorizations.length >= MAX_R3_RELAY_AUTHORIZATIONS) fail()
  } else {
    if (
      existing.clientDeviceId !== update.clientDeviceId
      || existing.status === 'revoked'
      || update.authorizationEpoch <= existing.authorizationEpoch
    ) {
      fail()
    }
  }

  const authorizations = state.authorizations.map(cloneAuthorization)
  if (existingIndex === -1) authorizations.push(incoming)
  else authorizations[existingIndex] = incoming
  authorizations.sort((left, right) => compareIdentifiers(
    left.authorizationId,
    right.authorizationId,
  ))
  const nextState: R3RelayPersistedState = {
    stateVersion: 1,
    registrationClosed: true,
    host: cloneHost(state.host),
    hostAuthorizationRevision: update.hostAuthorizationRevision,
    authorizations,
  }
  // Re-normalization is an internal invariant check and enforces the byte cap.
  encodePersistedState(nextState)
  return {
    state: nextState,
    result: { outcome: 'applied', authorization: cloneAuthorization(incoming) },
  }
}

export class R3RelayStateStore {
  readonly #stateFile: string
  #state: R3RelayPersistedState | undefined
  #closed = false
  #operationTail: Promise<void> = Promise.resolve()

  private constructor(stateFile: string, state: R3RelayPersistedState | undefined) {
    this.#stateFile = stateFile
    this.#state = state
  }

  static async open(stateFile: string): Promise<R3RelayStateStore> {
    const absoluteStateFile = requireAbsoluteStateFile(stateFile)
    const state = await loadR3RelayState(absoluteStateFile)
    return new R3RelayStateStore(absoluteStateFile, state)
  }

  get registrationClosed(): boolean {
    this.#assertOpen()
    return this.#state !== undefined
  }

  snapshot(): R3RelayPersistedState | undefined {
    this.#assertOpen()
    return this.#state === undefined ? undefined : cloneState(this.#state)
  }

  hostRegistration(): R3RelayHostRegistration | undefined {
    this.#assertOpen()
    return this.#state === undefined ? undefined : cloneHost(this.#state.host)
  }

  authorization(authorizationId: string): R3RelayAuthorizationRecord | undefined {
    this.#assertOpen()
    if (!OpaqueIdentifierSchema.safeParse(authorizationId).success) fail()
    const authorization = this.#state?.authorizations.find(
      candidate => candidate.authorizationId === authorizationId,
    )
    return authorization === undefined ? undefined : cloneAuthorization(authorization)
  }

  activeAuthorization(
    route: R3RelayAuthorizationRoute,
  ): R3RelayActiveAuthorizationRecord | undefined {
    this.#assertOpen()
    const state = this.#state
    if (state === undefined) return undefined
    const authorization = state.authorizations.find(candidate => (
      candidate.authorizationId === route.authorizationId
      && candidate.clientDeviceId === route.clientDeviceId
      && candidate.authorizationEpoch === route.authorizationEpoch
      && candidate.status === 'active'
      && state.host.hostId === route.hostId
      && state.host.hostDeviceId === route.hostDeviceId
    ))
    if (authorization?.status !== 'active') return undefined
    return cloneAuthorization(authorization)
  }

  async bootstrapHost(
    registration: R3RelayHostRegistration,
  ): Promise<R3RelayPersistedState> {
    return this.#enqueue(async () => {
      if (this.#state !== undefined) fail()
      const state = await createHostStateFile(this.#stateFile, registration)
      this.#state = state
      return cloneState(state)
    })
  }

  async applyAuthorization(
    update: RelayAuthorizationPut,
  ): Promise<R3RelayAuthorizationApplyResult> {
    return this.#enqueue(async () => withStateLock(this.#stateFile, async () => {
      const persisted = await readStateFile(this.#stateFile)
      if (persisted === undefined) fail()
      this.#state = persisted
      const applied = applyAuthorizationToState(persisted, update)
      if (applied.result.outcome === 'applied') {
        await replaceStateFile(this.#stateFile, applied.state)
        this.#state = applied.state
      }
      return {
        outcome: applied.result.outcome,
        authorization: cloneAuthorization(applied.result.authorization),
      }
    }))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#operationTail
  }

  #assertOpen(): void {
    if (this.#closed) fail()
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen()
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export async function openR3RelayStateStore(stateFile: string): Promise<R3RelayStateStore> {
  return R3RelayStateStore.open(stateFile)
}
