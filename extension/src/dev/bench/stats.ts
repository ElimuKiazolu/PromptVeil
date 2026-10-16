export interface TimingSummary {
  runs: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile of a non-empty list (p in 0–100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('no values');
  if (p < 0 || p > 100) throw new RangeError('percentile must be 0–100');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

export function summarise(values: readonly number[]): TimingSummary {
  return {
    runs: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
