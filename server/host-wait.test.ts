import { describe, expect, it } from 'vitest';
import { HostWait, pollWithWait } from './host-wait';

describe('long wait of the host helper', () => {
  it('with no work, it waits; the wake releases it right away and the round takes what arrived', async () => {
    const wait = new HostWait(10_000);
    const queue: string[] = [];
    const take = () => queue.splice(0);
    const round = pollWithWait(wait, take, 60_000);
    expect(wait.present()).toBe(true);
    queue.push('a');
    wait.wake();
    await expect(round).resolves.toEqual(['a']);
  });

  it('with work in the queue, it answers right away; with no wait requested (ms 0), too', async () => {
    const wait = new HostWait(10_000);
    await expect(pollWithWait(wait, () => ['x'], 60_000)).resolves.toEqual(['x']);
    await expect(pollWithWait(wait, () => [], 0)).resolves.toEqual([]);
  });

  it('connection that drops midway: returns empty without taking anything from the queue', async () => {
    const wait = new HostWait(10_000);
    const ac = new AbortController();
    let taken = 0;
    const round = pollWithWait(wait, () => (taken++, []), 60_000, ac.signal);
    ac.abort();
    await expect(round).resolves.toEqual([]);
    expect(taken).toBe(1);
  });

  it('presence: whoever is waiting counts; after that, only up to presenceMs from the last round', async () => {
    let now = 0;
    const wait = new HostWait(1_000, () => now);
    expect(wait.present()).toBe(false);
    wait.seen();
    now = 900;
    expect(wait.present()).toBe(true);
    now = 2_000;
    expect(wait.present()).toBe(false);
    const round = wait.wait(60_000);
    expect(wait.present()).toBe(true);
    wait.wake();
    await round;
    expect(wait.present()).toBe(true);
  });
});
