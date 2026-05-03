export async function measure<T>(
  fn: () => Promise<T>,
  report: (durationMs: number) => void,
): Promise<T> {
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    report(performance.now() - t0)
  }
}
