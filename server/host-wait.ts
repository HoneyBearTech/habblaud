// Long wait of the host helper rounds (scripts/codex-bridge.ts): instead of asking every half second, it
// asks with `?wait=1` and the response stays parked here until work arrives (or until HOST_WAIT_MS). While it waits,
// the helper counts as present.

/** How long a round stays parked waiting for work (the helper asks again right after). */
export const HOST_WAIT_MS = 20_000;

export class HostWait {
  private readonly waiters = new Set<() => void>();
  private seenAt = -Infinity;

  constructor(
    private readonly presenceMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The helper is waiting now or came by less than `presenceMs` ago. */
  present(): boolean {
    return this.waiters.size > 0 || this.now() - this.seenAt <= this.presenceMs;
  }

  seen(): void {
    this.seenAt = this.now();
  }

  /** Work arrived: releases whoever is waiting. */
  wake(): void {
    const list = [...this.waiters];
    this.waiters.clear();
    for (const done of list) done();
  }

  /** Waits for wake(), `ms` or `signal` (the helper's connection dropped). */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || ms <= 0) return Promise.resolve();
    return new Promise((ok) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.delete(done);
        this.seen();
        ok();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
      this.waiters.add(done);
    });
  }
}

/**
 * Round with wait: returns whatever `take` has at that moment; if it comes back empty, waits for work and tries
 * again. With the connection dropped midway, returns empty without taking anything from the queue.
 */
export async function pollWithWait<T>(wait: HostWait, take: () => T[], ms: number, signal?: AbortSignal): Promise<T[]> {
  wait.seen();
  const now = take();
  if (now.length || ms <= 0) return now;
  await wait.wait(ms, signal);
  return signal?.aborted ? [] : take();
}
