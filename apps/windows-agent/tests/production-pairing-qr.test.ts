import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ProductionPairingQrError,
  writeProductionPairingQr,
} from '../src/production-pairing-qr.ts'

const projectRoot = resolve(import.meta.dirname, '..', '..', '..')
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('production pairing QR', () => {
  it('writes a bounded PNG without returning the pairing URL and deletes it on dispose', async () => {
    const root = resolve(projectRoot, '.tmp', `production-pairing-${randomUUID()}`)
    roots.add(root)
    await mkdir(root, { recursive: true })
    const file = resolve(root, 'pairing.png')
    const value = await writeProductionPairingQr({
      pairingUrl: 'https://gateway.example.com/pair#synthetic-test-fragment',
      expiresAt: 301_000,
      now: 1_000,
      file,
      temporaryRoot: root,
      restrictFile: async () => {},
    })

    expect(value).toEqual(expect.objectContaining({ file, expiresAt: 301_000 }))
    expect(value).not.toHaveProperty('pairingUrl')
    expect((await readFile(file)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    await value.dispose()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'http://gateway.example.com/pair#fragment',
    'https://gateway.example.com/pair',
    'https://gateway.example.com/other#fragment',
    'https://gateway.example.com/pair?query=1#fragment',
  ])('rejects an invalid pairing URL: %s', async pairingUrl => {
    const root = resolve(projectRoot, '.tmp', `production-pairing-${randomUUID()}`)
    roots.add(root)
    await expect(writeProductionPairingQr({
      pairingUrl,
      expiresAt: 2_000,
      now: 1_000,
      file: resolve(root, 'pairing.png'),
      temporaryRoot: root,
      restrictFile: async () => {},
    })).rejects.toBeInstanceOf(ProductionPairingQrError)
  })
})
