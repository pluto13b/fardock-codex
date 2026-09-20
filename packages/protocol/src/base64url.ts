const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const base64UrlPattern = /^[A-Za-z0-9_-]+$/

export function isBase64Url(value: string): boolean {
  return value.length > 0 && value.length % 4 !== 1 && base64UrlPattern.test(value)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += alphabet[first >>> 2]
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]
    if (second !== undefined) {
      encoded += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]
    }
    if (third !== undefined) encoded += alphabet[third & 0x3f]
  }
  return encoded
}

export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!isBase64Url(value)) return undefined
  const output: number[] = []
  let buffer = 0
  let bitCount = 0
  for (const character of value) {
    const next = alphabet.indexOf(character)
    if (next < 0) return undefined
    buffer = (buffer << 6) | next
    bitCount += 6
    while (bitCount >= 8) {
      bitCount -= 8
      output.push((buffer >>> bitCount) & 0xff)
    }
    buffer &= (1 << bitCount) - 1
  }
  if (buffer !== 0) return undefined
  const decoded = new Uint8Array(output)
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

export function decodedBase64UrlLength(value: string): number | undefined {
  const decoded = decodeBase64Url(value)
  return decoded?.byteLength
}
