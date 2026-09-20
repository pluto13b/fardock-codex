import { describe, expect, it } from 'vitest'
import {
  encodeRelayPairCodeRegister, decodeRelayPairCodeRegister,
  encodeRelayPairCodeRegistered, decodeRelayPairCodeRegistered,
} from '../src/index.ts'

const route = { protocolVersion: 1, hostId: 'host.local', hostDeviceId: 'device.local', pairSessionId: 'pair.local', expiresAt: 1_900_000_300_000 }
describe('local Host pairing code control', () => {
  it('round-trips the bounded request and strict Crockford reply', () => {
    const request = { ...route, relayType: 'pair.code.register', invitationFragment: 'opaque-invitation' }
    const reply = { ...route, relayType: 'pair.code.registered', code: '23456789' }
    expect(decodeRelayPairCodeRegister(encodeRelayPairCodeRegister(request))).toEqual(request)
    expect(decodeRelayPairCodeRegistered(encodeRelayPairCodeRegistered(reply))).toEqual(reply)
    for (const code of ['123', '1234567I', '1234567O', '1234567U', 'abcd1234']) {
      expect(() => encodeRelayPairCodeRegistered({ ...reply, code })).toThrow()
    }
    expect(() => encodeRelayPairCodeRegister({ ...request, invitationFragment: 'x'.repeat(12 * 1024 + 1) })).toThrow()
    expect(() => encodeRelayPairCodeRegister({ ...request, password: 'forbidden' })).toThrow()
    expect(() => decodeRelayPairCodeRegistered(JSON.stringify({ ...reply, extra: true }))).toThrow()
  })
})
