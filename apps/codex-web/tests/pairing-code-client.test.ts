import { describe, expect, it, vi } from 'vitest'

import {
  normalizePairingCode,
  redeemPairingCode,
  registerPairingCode,
} from '../src/pairing-code-client.ts'

describe('pairing code client', () => {
  it('normalizes human-entered codes without accepting extra characters', () => {
    expect(normalizePairingCode(' abcd-1234 ')).toBe('ABCD1234')
    expect(normalizePairingCode('ol-i2345!')).toBe('0112345')
    expect(normalizePairingCode('abcd1234extra')).toBe('ABCD1234')
  })

  it('registers and redeems through owner-authenticated same-origin JSON requests', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, code: 'ABCD1234', expiresAt: 123 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, invitationFragment: 'opaque', expiresAt: 123 }), { status: 200 }))
    await expect(registerPairingCode({ invitationFragment: 'opaque', expiresAt: 123 }, fetcher))
      .resolves.toEqual({ code: 'ABCD1234', expiresAt: 123 })
    await expect(redeemPairingCode('abcd-1234', fetcher))
      .resolves.toEqual({ invitationFragment: 'opaque', expiresAt: 123 })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/pairing-code/register', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/pairing-code/redeem', expect.objectContaining({
      body: JSON.stringify({ code: 'ABCD1234' }),
    }))
  })

  it('maps an unknown or already-consumed code to an empty result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 404 }))
    await expect(redeemPairingCode('ABCD1234', fetcher)).resolves.toBeUndefined()
  })

  it('fails closed on malformed success responses', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, code: 'TOO-SHORT', expiresAt: 1 }), { status: 200 }))
    await expect(registerPairingCode({ invitationFragment: 'opaque', expiresAt: 1 }, fetcher))
      .rejects.toThrow('pairing-code-register-failed')
  })
})
