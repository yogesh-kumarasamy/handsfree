/**
 * Per-key mutex: `lock(key, fn)` runs `fn` after every earlier call with the same key has settled; other keys don't wait.
 * Used to serialise git operations that write a repo's `.git` (worktree add/remove) when several tickets start at once.
 */
export function keyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection leak out of the tail itself.
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
