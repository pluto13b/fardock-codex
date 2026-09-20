import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import QRCode from 'qrcode'

import { MAX_PAIRING_INVITATION_TTL_MS } from '../../../packages/protocol/src/index.ts'
import { restrictFileToCurrentWindowsUser } from './windows-dpapi.ts'

const MAX_PAIRING_URL_BYTES = 16 * 1024

export class ProductionPairingQrError extends Error {
  constructor(readonly code: 'invalid-input' | 'unsafe-path' | 'write-failed') {
    super(`production-pairing-qr:${code}`)
    this.name = 'ProductionPairingQrError'
  }
}

export interface ProductionPairingQr {
  readonly file: string
  readonly expiresAt: number
  dispose(): Promise<void>
}

function fail(code: ProductionPairingQrError['code']): never {
  throw new ProductionPairingQrError(code)
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function unlinkRegular(file: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    return fail('write-failed')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('unsafe-path')
  await unlink(file).catch(() => fail('write-failed'))
}

export async function writeProductionPairingQr(input: Readonly<{
  pairingUrl: string
  expiresAt: number
  file: string
  temporaryRoot: string
  now?: number
  restrictFile?: (file: string) => Promise<void>
}>): Promise<ProductionPairingQr> {
  const now = input.now ?? Date.now()
  let url
  try {
    url = new URL(input.pairingUrl)
  } catch {
    return fail('invalid-input')
  }
  if (
    url.protocol !== 'https:'
    || url.pathname !== '/pair'
    || url.search !== ''
    || url.username !== ''
    || url.password !== ''
    || url.hash.length < 2
    || Buffer.byteLength(input.pairingUrl, 'utf8') > MAX_PAIRING_URL_BYTES
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= now
    || input.expiresAt > now + MAX_PAIRING_INVITATION_TTL_MS
    || !isAbsolute(input.file)
    || !isAbsolute(input.temporaryRoot)
  ) fail('invalid-input')

  const root = resolve(input.temporaryRoot)
  const file = resolve(input.file)
  if (!within(root, file) || file === root) fail('unsafe-path')
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root).catch(() => fail('unsafe-path'))
  if (canonicalRoot !== root) fail('unsafe-path')
  await unlinkRegular(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  const restrictFile = input.restrictFile ?? restrictFileToCurrentWindowsUser
  try {
    await QRCode.toFile(temporary, input.pairingUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      type: 'png',
      width: 420,
    })
    const metadata = await lstat(temporary)
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('unsafe-path')
    const signature = (await readFile(temporary)).subarray(0, 8)
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('write-failed')
    await restrictFile(temporary)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    if (error instanceof ProductionPairingQrError) throw error
    return fail('write-failed')
  }

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    clearTimeout(expiryTimer)
    await unlinkRegular(file)
  }
  const expiryTimer = setTimeout(() => {
    void dispose().catch(() => undefined)
  }, Math.max(1, input.expiresAt - now))
  expiryTimer.unref()

  return Object.freeze({ file, expiresAt: input.expiresAt, dispose })
}
