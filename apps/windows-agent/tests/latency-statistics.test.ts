import { expect, it } from 'vitest'
import { latencyStatistics } from './helpers/latency-statistics.ts'

it('reports nearest-rank percentiles rather than indexing one sample too far', () => {
  expect(latencyStatistics(Array.from({ length: 20 }, (_, index) => 20 - index))).toEqual({
    count: 20, minMs: 1, p50Ms: 10, p95Ms: 19, maxMs: 20,
  })
  expect(latencyStatistics([])).toEqual({ count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null })
  expect(() => latencyStatistics([1, Number.NaN])).toThrow('invalid-latency-sample')
})
