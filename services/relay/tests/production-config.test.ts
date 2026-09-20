import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  loadProductionGatewayConfig,
  ProductionGatewayConfigError,
  type ProductionGatewayConfigErrorCode,
  type ProductionGatewayEnvironment,
} from '../src/production-config.ts'
import {
  createOwnerPasswordVerifier,
  type OwnerPasswordVerifier,
} from '../src/owner-auth.ts'

const sharedTestRoot = fileURLToPath(new URL('../../../.tmp/relay-tests/', import.meta.url))
const testRoot = join(sharedTestRoot, `production-config-${process.pid}-${randomUUID()}`)
const stateFile = join(testRoot, 'state', 'relay-state.json')
const webRoot = join(testRoot, 'web')
const bootstrapFile = join(testRoot, 'bootstrap.secret')
const badBootstrapFile = join(testRoot, 'bad-bootstrap.secret')
const ownerVerifierFile = join(testRoot, 'owner-verifier.json')
const badOwnerVerifierFile = join(testRoot, 'bad-owner-verifier.json')
const bootstrapCredential = Buffer.alloc(32, 0x51).toString('base64url')
let ownerVerifier: OwnerPasswordVerifier

function validEnvironment(
  overrides: Partial<ProductionGatewayEnvironment> = {},
): ProductionGatewayEnvironment {
  return {
    CODEX_PLUS_MODE: 'production',
    CODEX_PLUS_BIND: '127.0.0.1',
    CODEX_PLUS_PORT: '8787',
    CODEX_PLUS_PUBLIC_ORIGIN: 'https://gateway.example.test',
    CODEX_PLUS_TRUSTED_PROXY_IPS: '127.0.0.1',
    CODEX_PLUS_STATE_FILE: stateFile,
    CODEX_PLUS_WEB_ROOT: webRoot,
    CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: bootstrapFile,
    CODEX_PLUS_OWNER_VERIFIER_FILE: ownerVerifierFile,
    CODEX_PLUS_LOG_LEVEL: 'warn',
    ...overrides,
  }
}

async function expectConfigError(
  environment: ProductionGatewayEnvironment,
  code: ProductionGatewayConfigErrorCode,
): Promise<void> {
  const error = await loadProductionGatewayConfig(environment).catch(reason => reason as unknown)
  expect(error).toBeInstanceOf(ProductionGatewayConfigError)
  expect(error).toMatchObject({
    name: 'ProductionGatewayConfigError',
    message: code,
    code,
  })
}

beforeAll(async () => {
  await mkdir(webRoot, { recursive: true })
  ownerVerifier = await createOwnerPasswordVerifier({
    username: 'owner',
    password: 'test owner password',
  }, () => Buffer.alloc(16, 8))
  await writeFile(bootstrapFile, bootstrapCredential, { encoding: 'utf8', flag: 'wx' })
  await writeFile(badBootstrapFile, `${bootstrapCredential}\n`, { encoding: 'utf8', flag: 'wx' })
  await writeFile(ownerVerifierFile, JSON.stringify(ownerVerifier), { encoding: 'utf8', flag: 'wx' })
  await writeFile(badOwnerVerifierFile, '{"version":1,"username":"owner"}', { encoding: 'utf8', flag: 'wx' })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('production Gateway configuration', () => {
  it('requires a strict owner verifier file outside the Web root', async () => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_OWNER_VERIFIER_FILE: undefined }),
      'invalid-owner-verifier-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_OWNER_VERIFIER_FILE: 'relative.json' }),
      'invalid-owner-verifier-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_OWNER_VERIFIER_FILE: badOwnerVerifierFile }),
      'invalid-owner-verifier-file',
    )
  })

  it('loads one complete explicit configuration and its bootstrap secret', async () => {
    const config = await loadProductionGatewayConfig(validEnvironment())

    expect(config).toEqual({
      mode: 'production',
      bind: '127.0.0.1',
      port: 8787,
      publicOrigin: 'https://gateway.example.test',
      trustedProxyIps: ['127.0.0.1'],
      stateFile,
      webRoot,
      bootstrapCredential,
      bootstrapCredentialFile: bootstrapFile,
      ownerVerifier,
      ownerVerifierFile,
      logLevel: 'warn',
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('requires the explicit mode and does not infer it from NODE_ENV', async () => {
    const environment: ProductionGatewayEnvironment & { NODE_ENV: string } = {
      ...validEnvironment(),
      CODEX_PLUS_MODE: undefined,
      NODE_ENV: 'production',
    }

    await expectConfigError(environment, 'invalid-mode')
  })

  it.each(['localhost', '::1', '', '203.0.113.10'])(
    'rejects the bind value %j',
    async (bind) => {
      await expectConfigError(validEnvironment({ CODEX_PLUS_BIND: bind }), 'invalid-bind')
    },
  )

  it.each(['0', '65536', '08787', '8787.0', '-1', ''])(
    'rejects the port value %j',
    async (port) => {
      await expectConfigError(validEnvironment({ CODEX_PLUS_PORT: port }), 'invalid-port')
    },
  )

  it.each([
    'http://gateway.example.test',
    'https://gateway.example.test/api',
    'https://gateway.example.test?source=test',
  ])('rejects the public origin %j', async (publicOrigin) => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_PUBLIC_ORIGIN: publicOrigin }),
      'invalid-public-origin',
    )
  })

  it.each([
    undefined,
    '',
    'localhost',
    '127.0.0.0/8',
    '127.0.0.1,127.0.0.1',
    '127.0.0.1, ::1',
    '127.0.0.1,192.0.2.1,198.51.100.1,203.0.113.1,10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5',
  ])('rejects the trusted proxy list %j', async (proxyIps) => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_TRUSTED_PROXY_IPS: proxyIps }),
      'invalid-trusted-proxy-ips',
    )
  })

  it('rejects relative state and Web roots', async () => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_STATE_FILE: join('relative', 'relay-state.json') }),
      'invalid-state-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_WEB_ROOT: join('relative', 'web') }),
      'invalid-web-root',
    )
  })

  it('rejects state and bootstrap files inside the public Web root', async () => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_STATE_FILE: join(webRoot, 'assets', 'relay-state.json') }),
      'invalid-state-file',
    )
    const publicSecret = join(webRoot, 'assets', 'relay-bootstrap')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await writeFile(publicSecret, bootstrapCredential, { encoding: 'utf8', flag: 'wx' })
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: publicSecret }),
      'invalid-bootstrap-file',
    )
  })

  it('rejects parent symlink or junction aliases that resolve into the Web root', async () => {
    const assets = join(webRoot, 'assets')
    const publicSecret = join(assets, 'aliased-bootstrap')
    const alias = join(testRoot, 'public-assets-alias')
    await mkdir(assets, { recursive: true })
    await writeFile(publicSecret, bootstrapCredential, 'utf8')
    try {
      await symlink(assets, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'EPERM'
      ) return
      throw error
    }

    await expectConfigError(
      validEnvironment({
        CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: join(alias, 'aliased-bootstrap'),
      }),
      'invalid-bootstrap-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_STATE_FILE: join(alias, 'aliased-state.json') }),
      'invalid-state-file',
    )
  })

  it('rejects missing, relative, and malformed bootstrap secret files', async () => {
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: join(testRoot, 'missing.secret') }),
      'invalid-bootstrap-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: 'relative.secret' }),
      'invalid-bootstrap-file',
    )
    await expectConfigError(
      validEnvironment({ CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: badBootstrapFile }),
      'invalid-bootstrap-file',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic link used as the bootstrap secret file',
    async () => {
      const link = join(testRoot, 'bootstrap-link.secret')
      await symlink(bootstrapFile, link, 'file')
      await expectConfigError(
        validEnvironment({ CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: link }),
        'invalid-bootstrap-file',
      )
    },
  )
})
