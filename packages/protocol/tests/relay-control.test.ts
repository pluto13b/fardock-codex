import { describe, expect, it } from 'vitest'

import {
  decodeRelayHello,
  decodeRelayNotAuthenticated,
  decodeRelayWelcome,
  encodeBase64Url,
  encodeRelayHello,
  encodeRelayNotAuthenticated,
  encodeRelayWelcome,
  MAX_FRAME_BYTES,
  MAX_RELAY_CONTROL_BYTES,
  ProtocolViolation,
} from '../src/index.ts'

const credential = encodeBase64Url(new Uint8Array(32).fill(3))
const sessionCredential = encodeBase64Url(new Uint8Array(32).fill(4))

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

describe('Relay control codecs', () => {
  it('locks bootstrap and resume hello shapes', () => {
    const bootstrap = {
      protocolVersion: 1 as const,
      relayType: 'hello' as const,
      role: 'host' as const,
      hostId: 'host-main',
      deviceId: 'device-host',
      credential,
      authMode: 'bootstrap' as const,
      sessionCredential,
    }
    expect(decodeRelayHello(encodeRelayHello(bootstrap))).toEqual(bootstrap)
    expectCode(() => encodeRelayHello({ ...bootstrap, role: 'client' }), 'schema-invalid')
    expectCode(() => encodeRelayHello({ ...bootstrap, authMode: 'resume' }), 'schema-invalid')
    expectCode(() => encodeRelayHello({ ...bootstrap, extra: true }), 'schema-invalid')

    const resume = {
      protocolVersion: 1 as const,
      relayType: 'hello' as const,
      role: 'client' as const,
      hostId: 'host-main',
      deviceId: 'device-web',
      credential,
      authMode: 'resume' as const,
    }
    expect(decodeRelayHello(encodeRelayHello(resume))).toEqual(resume)
    expectCode(() => encodeRelayHello({ ...resume, sessionCredential }), 'schema-invalid')
  })

  it('requires exact 32-byte unpadded credentials and canonical control JSON', () => {
    const resume = {
      protocolVersion: 1 as const,
      relayType: 'hello' as const,
      role: 'host' as const,
      hostId: 'host-main',
      deviceId: 'device-host',
      credential,
      authMode: 'resume' as const,
    }
    expectCode(() => encodeRelayHello({ ...resume, credential: `${credential}=` }), 'schema-invalid')
    expectCode(
      () => encodeRelayHello({ ...resume, credential: encodeBase64Url(new Uint8Array(31)) }),
      'schema-invalid',
    )
    const encoded = encodeRelayHello(resume)
    expectCode(() => decodeRelayHello(` ${encoded}`), 'schema-invalid')
    expectCode(() => decodeRelayHello(encoded.replace('{', '{"extra":true,')), 'schema-invalid')
    const encodedBytes = new TextEncoder().encode(encoded)
    const bomBytes = new Uint8Array(encodedBytes.byteLength + 3)
    bomBytes.set([0xef, 0xbb, 0xbf])
    bomBytes.set(encodedBytes, 3)
    expectCode(() => decodeRelayHello(bomBytes), 'invalid-json')
    expectCode(() => decodeRelayHello('x'.repeat(MAX_RELAY_CONTROL_BYTES + 1)), 'frame-too-large')
  })

  it('locks secret-free welcome and pre-auth error frames', () => {
    const welcome = {
      protocolVersion: 1 as const,
      relayType: 'welcome' as const,
      role: 'host' as const,
      hostId: 'host-main',
      deviceId: 'device-host',
      authMode: 'bootstrap' as const,
      registrationState: 'closed' as const,
      heartbeatIntervalMs: 30_000,
      maxFrameBytes: MAX_FRAME_BYTES,
    }
    expect(decodeRelayWelcome(encodeRelayWelcome(welcome))).toEqual(welcome)
    expectCode(() => encodeRelayWelcome({ ...welcome, sessionCredential }), 'schema-invalid')
    expect(decodeRelayNotAuthenticated(encodeRelayNotAuthenticated())).toEqual({
      protocolVersion: 1,
      relayType: 'error',
      code: 'not-authenticated',
    })
  })
})
