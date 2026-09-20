import { expect, it } from 'vitest'
import { ReplyBuffer, REPLY_BUFFER_MS, REPLY_FINISH_MS } from '../src/reply-buffer.ts'

it('buffers the first burst, then releases smaller visible increments', () => {
  const reply = new ReplyBuffer(), source = '平滑呈现一段返回的文字。'.repeat(20)
  reply.receive(source, 0, false)
  expect(reply.advance(REPLY_BUFFER_MS - 1)).toBe('')
  const first = reply.advance(REPLY_BUFFER_MS + 17)
  const second = reply.advance(REPLY_BUFFER_MS + 34)
  expect(first.length).toBeGreaterThan(0)
  expect(second.length).toBeGreaterThan(first.length)
  expect(second.length).toBeLessThan(source.length / 4)
  expect(source.startsWith(second)).toBe(true)
})

it.each(['OK', '  **文字**\n`code`\n👩🏽‍💻\t尾部  ', '长文本'.repeat(10_000)])('finishes short and burst replies within the tail deadline (%#)', source => {
  const reply = new ReplyBuffer()
  reply.receive(source, 0, true)
  for (let now = 0; now <= REPLY_FINISH_MS; now += 10) reply.advance(now)
  expect(reply.text).toBe(source)
  expect(reply.pending).toBe(false)
  expect(reply.canAdvance).toBe(false)
})

it('does not split surrogate pairs, combining marks, flags or ZWJ emoji across chunks', () => {
  const source = '开头 👨‍👩‍👧‍👦 e\u0301 🇨🇳 👩🏽‍💻 结束'
  const boundaries = new Set(['', ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source), part => source.slice(0, part.index + part.segment.length))])
  const reply = new ReplyBuffer()
  for (let i = 1; i <= source.length; i++) {
    reply.receive(source.slice(0, i), i * 70, false)
    for (let time = i * 70; time < i * 70 + 70; time += 10) expect(boundaries.has(reply.advance(time))).toBe(true)
  }
  reply.receive(source, 4000, true)
  expect(reply.advance(4000 + REPLY_FINISH_MS)).toBe(source)
})

it('preserves source corrections and lets stop or visibility changes flush immediately', () => {
  const reply = new ReplyBuffer()
  reply.receive('初始回答'.repeat(30), 0, false)
  reply.advance(620)
  reply.receive('修正后的原文', 630, false)
  expect(reply.text).toBe('修正后的原文')
  reply.receive('修正后的原文\n继续输出', 640, false)
  expect(reply.flush()).toBe('修正后的原文\n继续输出')
  expect(reply.pending).toBe(false)
})

it('keeps pacing time based across refresh rates', () => {
  const countAt = (hz: number) => {
    const reply = new ReplyBuffer()
    reply.receive('文字'.repeat(500), 0, false)
    for (let now = 0; now <= 1300; now += 1000 / hz) reply.advance(now)
    return reply.text.length
  }
  expect(Math.abs(countAt(60) - countAt(120))).toBeLessThan(20)
})

it('waits without a frame loop when only an incomplete boundary remains', () => {
  const reply = new ReplyBuffer()
  reply.receive('👨‍', 0, false)
  expect(reply.canAdvance).toBe(false)
  expect(reply.pending).toBe(true)
  reply.receive('👨‍👩‍👧‍👦好', 800, false)
  expect(reply.canAdvance).toBe(true)
  expect(reply.advance(850)).toBe('👨‍👩‍👧‍👦')
})
