import { encodeBase64Url, type P256PublicJwk, type RoutedEnvelope } from '../src/index.ts'

export const fixedNow = 1_800_000_000_000

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) throw new Error('Invalid test hex.')
  return Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}

function p256Point(x: string, y: string): P256PublicJwk {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(hexBytes(x)),
    y: encodeBase64Url(hexBytes(y)),
  }
}

// SEC 2 P-256 generator and its scalar multiples; these are valid curve points,
// unlike the zero-filled coordinate fixtures that R1 temporarily used.
export const p256Generator = p256Point(
  '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
  '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
)

export const p256Point2 = p256Point(
  '7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978',
  '07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1',
)

export const p256Point3 = p256Point(
  '5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c',
  '8734640c4998ff7e374b06ce1a64a2ecd82ab036384fb83d9a79b127a27d5032',
)

export const p256Point4 = p256Point(
  'e2534a3532d08fbba02dde659ee62bd0031fe2db785596ef509302446b030852',
  'e0f1575a4c633cc719dfee5fda862d764efc96c3f30ee0055c42c23f184ed8c6',
)

export const p256Point5 = p256Point(
  '51590b7a515140d2d784c85608668fdfef8c82fd1f5be52421554a0dc3d033ed',
  'e0c17da8904a727d8ae1bf36bf8a79260d012f00d4d80888d1d0bb44fda16da4',
)

export function base64Bytes(byteLength: number, fill: number): string {
  return encodeBase64Url(new Uint8Array(byteLength).fill(fill))
}

export function ciphertext(byteLength = 32): string {
  return encodeBase64Url(Uint8Array.from({ length: byteLength }, (_, index) => index % 251))
}

export function envelope(overrides: Partial<RoutedEnvelope> = {}): RoutedEnvelope {
  return {
    protocolVersion: 1,
    connectionGeneration: 7,
    fromDeviceId: 'device-phone',
    toDeviceId: 'device-host',
    hostId: 'host-main',
    keyId: 'key-7',
    requestId: 'request-1',
    taskId: 'task-1',
    seq: 1,
    ack: 0,
    sentAt: fixedNow - 1_000,
    expiresAt: fixedNow + 60_000,
    messageType: 'request',
    ciphertext: ciphertext(),
    ...overrides,
  }
}
