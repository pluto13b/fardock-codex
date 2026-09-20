import { describe, expect, it } from 'vitest'

import {
  createOwnerPasswordVerifier,
  OWNER_SESSION_COOKIE,
  OwnerSessionAuthority,
  parseOwnerPasswordVerifier,
} from '../src/owner-auth.ts'

const salt = Buffer.alloc(16, 7)
let tokenByte = 20
const tokens = (length: number): Buffer => Buffer.alloc(length, tokenByte++)

describe('single-owner password and session authority', () => {
  it('creates and parses a strict scrypt verifier without retaining the password', async () => {
    const verifier = await createOwnerPasswordVerifier({
      username: 'owner',
      password: 'correct horse battery staple',
    }, () => Buffer.from(salt))
    expect(verifier).toMatchObject({ version: 1, username: 'owner', kdf: 'scrypt' })
    expect(JSON.stringify(verifier)).not.toContain('correct horse')
    expect(parseOwnerPasswordVerifier(JSON.parse(JSON.stringify(verifier)))).toEqual(verifier)
    expect(() => parseOwnerPasswordVerifier({ ...verifier, extra: true })).toThrow('invalid-verifier')
    expect(() => parseOwnerPasswordVerifier({ ...verifier, derivedKey: 'bad' })).toThrow('invalid-verifier')
  })

  it('issues an HttpOnly strict cookie, restores it, logs out, and expires it', async () => {
    let now = 1_800_000_000_000
    const verifier = await createOwnerPasswordVerifier({
      username: '主人',
      password: 'mobile full access',
    }, () => Buffer.from(salt))
    const authority = new OwnerSessionAuthority({ verifier, now: () => now, randomBytes: tokens })
    await expect(authority.login('主人', 'wrong password')).resolves.toEqual({ state: 'invalid' })
    const login = await authority.login('主人', 'mobile full access')
    expect(login.state).toBe('authenticated')
    if (login.state !== 'authenticated') throw new Error('expected login')
    expect(login.setCookie).toContain(`${OWNER_SESSION_COOKIE}=`)
    expect(login.setCookie).toContain('Secure; HttpOnly; SameSite=Strict')
    expect(login.setCookie).not.toContain('mobile full access')
    const requestCookie = login.setCookie.split(';')[0]
    expect(authority.session(requestCookie)).toEqual({ authenticated: true, username: '主人' })
    expect(authority.session(`${requestCookie}; ${requestCookie}`)).toBeUndefined()
    expect(authority.logout(requestCookie)).toContain('Max-Age=0')
    expect(authority.session(requestCookie)).toBeUndefined()

    const second = await authority.login('主人', 'mobile full access')
    if (second.state !== 'authenticated') throw new Error('expected second login')
    now += 12 * 60 * 60 * 1_000
    expect(authority.session(second.setCookie.split(';')[0])).toBeUndefined()
  })

  it('rate-limits repeated failures without revealing whether the username exists', async () => {
    const verifier = await createOwnerPasswordVerifier({
      username: 'owner',
      password: 'long enough password',
    }, () => Buffer.from(salt))
    const authority = new OwnerSessionAuthority({ verifier, randomBytes: tokens })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(authority.login(attempt % 2 === 0 ? 'owner' : 'missing', 'incorrect password'))
        .resolves.toEqual({ state: 'invalid' })
    }
    await expect(authority.login('owner', 'long enough password'))
      .resolves.toEqual({ state: 'rate-limited' })
  })
})
