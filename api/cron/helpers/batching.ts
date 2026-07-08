// Stateless, deterministic batch selection: derives which slice of a pool to
// scan this run from wall-clock time instead of a persisted cursor. Self-healing
// (a failed run just means that slice gets retried next cycle) and race-free
// (no shared state to corrupt under overlapping invocations).
export const pickBatch = (pool: string[], size: number, bucketIntervalMin: number): string[] => {
  const sorted = [...pool].sort()
  if (sorted.length <= size) return sorted

  const bucket = Math.floor(Date.now() / (bucketIntervalMin * 60_000))
  const n = Math.ceil(sorted.length / size)
  const idx = bucket % n
  return sorted.slice(idx * size, idx * size + size)
}
