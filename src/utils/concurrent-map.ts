/** Bounded reads retain input order and stop scheduling after an authoritative failure. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit");
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await read(items[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
