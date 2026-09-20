import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseD7WssSmokeArguments } from '../src/d7-wss-smoke.ts'

const root = resolve(import.meta.dirname, '..', '..', '..')
const bootstrap = resolve(root, '.tmp', 'd7-wss-test-bootstrap')

describe('D7 external WSS smoke boundary', () => {
  it('accepts only an exact HTTPS origin and workspace-local synthetic bootstrap file', () => {
    expect(parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--bootstrap-file', bootstrap,
      '--restart-timeout-ms', '120000',
      '--confirm-disposable-d7-gateway', 'yes',
    ], root)).toEqual({
      origin: 'https://codex.example.test',
      webSocketUrl: 'wss://codex.example.test/api/ws',
      bootstrapFile: bootstrap,
      restartTimeoutMs: 120_000,
    })
  })

  it.each([
    'http://codex.example.test',
    'https://codex.example.test/path',
    'https://user@codex.example.test',
    'https://codex.example.test?unsafe=1',
  ])('rejects a non-production origin: %s', origin => {
    expect(() => parseD7WssSmokeArguments([
      '--origin', origin,
      '--bootstrap-file', bootstrap,
      '--confirm-disposable-d7-gateway', 'yes',
    ], root)).toThrowError(/invalid-arguments/)
  })

  it('rejects credentials outside .tmp and duplicate or unbounded options', () => {
    const outside = resolve(root, '.data', 'not-a-d7-test-secret')
    expect(() => parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--bootstrap-file', outside,
      '--confirm-disposable-d7-gateway', 'yes',
    ], root)).toThrowError(/invalid-arguments/)
    expect(() => parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--origin', 'https://other.example.test',
      '--bootstrap-file', bootstrap,
      '--confirm-disposable-d7-gateway', 'yes',
    ], root)).toThrowError(/invalid-arguments/)
    expect(() => parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--bootstrap-file', bootstrap,
      '--restart-timeout-ms', '999999999',
      '--confirm-disposable-d7-gateway', 'yes',
    ], root)).toThrowError(/invalid-arguments/)
  })

  it('requires an explicit disposable Gateway confirmation before execution', () => {
    expect(() => parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--bootstrap-file', bootstrap,
    ], root)).toThrowError(/invalid-arguments/)
    expect(() => parseD7WssSmokeArguments([
      '--origin', 'https://codex.example.test',
      '--bootstrap-file', bootstrap,
      '--confirm-disposable-d7-gateway', 'no',
    ], root)).toThrowError(/invalid-arguments/)
  })
})
