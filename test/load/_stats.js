// Latency / measurement helpers shared by the load scripts.

/** Nearest-rank percentile (p in [0,100]) over an array of numbers. */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/** Summarize latency samples (ms): count, p50, p95, p99, max, mean. */
export function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length ? sum / sorted.length : NaN,
  };
}

export const ms = (n) => `${n.toFixed(1)}ms`;
export const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
