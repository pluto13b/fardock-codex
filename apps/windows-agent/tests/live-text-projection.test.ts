import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveTextProjection } from '../src/live-text-projection.ts'

afterEach(() => vi.restoreAllMocks())

describe('owned live assistant text', () => {
  it('measures acceptance to first text separately from text to snapshot', () => {
    let now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const firstText = vi.fn(), firstSnapshot = vi.fn()
    const live = createLiveTextProjection(() => true, firstSnapshot, firstText)
    live.markAcceptedTurn('task.1', 'turn.1')
    now = 250
    live.observe({ method: 'item/agentMessage/delta', params: { threadId: 'task.1', turnId: 'turn.1', itemId: 'item.1', delta: 'test text' } })
    expect(firstText).toHaveBeenCalledExactlyOnceWith(150)
    now = 300
    expect(live.read('task.1')!.messages[0]?.markdown).toBe('test text')
    expect(firstSnapshot).toHaveBeenCalledExactlyOnceWith(50)
    live.markAcceptedTurn('task.1', 'turn.1')
    live.read('task.1')
    expect(firstText).toHaveBeenCalledTimes(1)
    expect(firstSnapshot).toHaveBeenCalledTimes(1)
  })

  it('retains text that arrives before acceptance and resets timing for the next owned turn', () => {
    let owned = false, turn = 'turn.1', now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const firstText = vi.fn()
    const live = createLiveTextProjection((_, id) => owned && id === turn, undefined, firstText)
    live.markAcceptedTurn('task.1', turn)
    live.observe({ method: 'item/agentMessage/delta', params: { threadId: 'task.1', turnId: turn, itemId: 'item.1', delta: 'early' } })
    expect(firstText).not.toHaveBeenCalled()
    owned = true; now = 150; live.markAcceptedTurn('task.1', turn)
    expect(firstText).toHaveBeenLastCalledWith(0)
    expect(live.read('task.1')!.messages[0]?.markdown).toBe('early')
    turn = 'turn.2'; now = 200; live.markAcceptedTurn('task.1', turn)
    now = 275
    live.observe({ method: 'item/agentMessage/delta', params: { threadId: 'task.1', turnId: turn, itemId: 'item.2', delta: 'new' } })
    expect(firstText).toHaveBeenLastCalledWith(75)
    expect(live.read('task.1')!.messages.map(item => item.markdown)).toEqual(['new'])
  })

  it('shows early deltas before completion only after the matching turn is accepted', () => {
    let owned = false
    const live = createLiveTextProjection((task, turn) => owned && task === 'task.1' && turn === 'turn.1')
    live.observe({ method: 'item/started', params: { threadId: 'task.1', turnId: 'turn.1', item: { type: 'agentMessage', id: 'item.1', text: '' } } })
    live.observe({ method: 'item/agentMessage/delta', params: { threadId: 'task.1', turnId: 'turn.1', itemId: 'item.1', delta: '第一' } })
    expect(live.read('task.1')).toBeUndefined()
    owned = true
    const first = live.read('task.1')!
    expect(first.messages[0]?.markdown).toBe('第一')
    live.observe({ method: 'item/agentMessage/delta', params: { threadId: 'task.1', turnId: 'turn.1', itemId: 'item.1', delta: '个字 😀' } })
    expect(live.read('task.1')!.version).toBeGreaterThan(first.version)
    expect(first.messages[0]?.markdown).toBe('第一')
    expect(live.read('task.1')!.messages[0]?.markdown).toBe('第一个字 😀')
    live.observe({ method: 'item/completed', params: { threadId: 'task.1', turnId: 'turn.1', item: { type: 'agentMessage', id: 'item.1', text: '完整回复' } } })
    expect(live.read('task.1')!.messages[0]?.markdown).toBe('完整回复')
  })

  it('isolates turns and ignores reasoning, unknown data and oversized gaps', () => {
    const live = createLiveTextProjection((_, turn) => turn === 'turn.1')
    live.observe({ method: 'item/reasoning/textDelta', params: { threadId: 'task.1', turnId: 'turn.1', itemId: 'reasoning', delta: 'private reasoning' } })
    expect(live.read('task.1')).toBeUndefined()
    const params = { threadId: 'task.1', turnId: 'turn.1', itemId: 'item.1' }
    live.observe({ method: 'item/agentMessage/delta', params: { ...params, delta: 'prefix' } })
    live.observe({ method: 'item/agentMessage/delta', params: { ...params, delta: 'x'.repeat(128 * 1024) } })
    live.observe({ method: 'item/agentMessage/delta', params: { ...params, delta: 'missing-middle-must-not-be-joined' } })
    live.observe({ method: 'item/agentMessage/delta', params: { ...params, turnId: 'turn.other', delta: 'other turn' } })
    expect(live.read('task.1')!.messages[0]?.markdown).toBe('prefix')
    expect(live.read('task.other')).toBeUndefined()
    live.clear()
    expect(live.read('task.1')).toBeUndefined()
  })
})
