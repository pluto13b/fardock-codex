import { afterEach, expect, it, vi } from 'vitest'
import { createFixtureCodexServeClient } from '../src/fixture.ts'
import type { CodexServeClient, SendTurnInput } from '../src/contracts.ts'

afterEach(() => vi.useRealTimers())

async function inputFor(client: CodexServeClient): Promise<SendTurnInput> {
  const snapshot = await client.readTask('adapter')
  return {
    actionId: 'mobile-stream-once', input: [{ type: 'text', text: '  原文\n第二行 😀  ' }],
    settings: { model: 'gpt-6-astra', effort: 'medium', permission: 'ask' },
    expected: { hostId: snapshot.host.hostId, connectionGeneration: snapshot.host.generation, revision: snapshot.revision },
  }
}
it('keeps the original non-streaming behaviour unless explicitly enabled', async () => {
  vi.useFakeTimers()
  const client = createFixtureCodexServeClient(), input = await inputFor(client)
  await client.sendTurn('adapter', input); await vi.advanceTimersByTimeAsync(10_000)
  const state = await client.readTask('adapter')
  expect(state.task.status).toBe('running')
  expect(state.messages.filter(message => message.kind === 'assistant')).toHaveLength(1)
})

it('emits a partial reply, preserves input and completes without duplicate sends', async () => {
  vi.useFakeTimers()
  const client = createFixtureCodexServeClient({ simulateReplies: true }), input = await inputFor(client)
  expect((await client.sendTurn('adapter', input)).state).toBe('accepted')
  await client.sendTurn('adapter', input)
  await vi.advanceTimersByTimeAsync(400)
  const partial = await client.readTask('adapter'), last = partial.messages.at(-1)
  expect(last?.kind).toBe('assistant')
  expect(last && 'markdown' in last && last.markdown.length).toBeGreaterThan(0)
  expect(partial.task.status).toBe('running')
  expect(partial.messages.filter(message => message.kind === 'user' && message.text === '  原文\n第二行 😀  ')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(10_000)
  const done = await client.readTask('adapter')
  expect(done.task.status).toBe('completed')
  expect(done.capabilities.sendTurn).toBe(true)
  expect(done.messages.at(-1)).toMatchObject({ kind: 'assistant', markdown: expect.stringContaining('模拟回复已完成。') })
})

it('stops pending simulated chunks when interrupted', async () => {
  vi.useFakeTimers()
  const client = createFixtureCodexServeClient({ simulateReplies: true }), input = await inputFor(client)
  await client.sendTurn('adapter', input); await vi.advanceTimersByTimeAsync(400)
  const partial = await client.readTask('adapter')
  await client.interruptTurn('adapter', { actionId: 'stop-mobile-stream', turnId: partial.activeTurnId!, expected: { hostId: partial.host.hostId, connectionGeneration: partial.host.generation, revision: partial.revision } })
  await vi.advanceTimersByTimeAsync(10_000)
  const stopped = await client.readTask('adapter')
  expect(stopped.messages.at(-1)).toEqual(partial.messages.at(-1))
  expect(stopped.task.completionReason).toBe('interrupted')
})
