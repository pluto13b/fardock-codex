/** Nearest-rank percentiles; failure counts are reported separately by callers. */
export function latencyStatistics(values: readonly number[]) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid-latency-sample')
  const sorted = [...values].sort((a, b) => a - b)
  const round = (value: number) => Math.round(value * 100) / 100
  const percentile = (p: number) => sorted.length === 0 ? null : round(sorted[Math.ceil(sorted.length * p) - 1])
  return {
    count: sorted.length,
    minMs: sorted.length ? round(sorted[0]) : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.length ? round(sorted[sorted.length - 1]) : null,
  }
}
