import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { APP_SERVER_METHODS, AppServerSupervisor } from '../src/supervisor.ts'
import { readModelCatalog, requireModelSettings } from '../src/model-catalog.ts'

const supervisors: AppServerSupervisor[] = []
afterEach(async () => { await Promise.all(supervisors.splice(0).map(value => value.close())) })
describe('owned runtime model catalog', () => {
  it('discovers a new model and validates exact id/effort with one concurrent catalog read', async () => {
    const supervisor = new AppServerSupervisor({
      command: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-turn-app-server.mjs', import.meta.url))] },
      clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.1.0' }, allowedMethods: APP_SERVER_METHODS,
    })
    supervisors.push(supervisor)
    await supervisor.start()
    const first = readModelCatalog(supervisor)
    expect(readModelCatalog(supervisor)).toBe(first)
    expect((await first).find(model => model.id === 'gpt-6-astra')).toMatchObject({ isDefault: true, defaultReasoningEffort: 'medium' })
    await expect(requireModelSettings(supervisor, { model: 'gpt-6-astra', effort: 'high' })).resolves.toBeUndefined()
    await expect(requireModelSettings(supervisor, { model: 'GPT-6 Astra', effort: 'high' })).rejects.toThrow('unsupported')
    await expect(requireModelSettings(supervisor, { model: 'gpt-6-astra', effort: 'invented' })).rejects.toThrow('unsupported')
  })
})
