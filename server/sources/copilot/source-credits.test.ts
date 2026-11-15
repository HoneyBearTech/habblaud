// Copilot source → account usage: AI credits of every session folder, pushed as the 'copilot' usage source.
// Made-up sessions only (server/test/copilot-fixtures.ts), on a fixed clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { log, setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { copilotHome, E, sessionId } from '../../test/copilot-fixtures';
import { NANO_AIU_PER_CREDIT } from './credits';
import { CopilotSource } from './source';

setQuiet(true);

const HOUR = 3_600_000;
/** 15 Nov 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 15, 12);
const DEC_1 = Date.UTC(2026, 11, 1);
const u = (credits: number) => credits * NANO_AIU_PER_CREDIT;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
});

function setup(env: NodeJS.ProcessEnv = {}, name?: string) {
  const home = copilotHome(name);
  cleanups.push(home.cleanup);
  let clock = NOW;
  const now = () => clock;
  let changes = 0;
  const accounts = new AccountsService({ dirs: [], home: home.home, env, now, onChange: () => changes++ });
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  const make = () => {
    const source = new CopilotSource({ accounts, office, dirs: [home.dir], env, home: home.home, now, watch: false });
    cleanups.unshift(() => source.stop());
    return source;
  };
  return {
    home,
    accounts,
    make,
    set(at: number) {
      clock = at;
    },
    changes: () => changes,
    account(): AccountInfo {
      return accounts.list(new Map()).find((a) => a.provider === 'copilot')!;
    },
  };
}

describe('Copilot source: AI credits as account usage', () => {
  it('no session with a total this month: usage stays "disabled"', () => {
    const ctx = setup();
    ctx.home.session(sessionId(1), [E.start(sessionId(1), { at: NOW - HOUR }), E.premium(NOW - HOUR)], { mtime: NOW });
    ctx.make().boot();
    expect(ctx.account()).toMatchObject({ usageStatus: 'disabled' });
    expect(ctx.account().usage).toBeUndefined();
  });

  it('every session folder counts (open or not): month, today and the reset on the 1st of next month (UTC)', () => {
    const ctx = setup();
    // Old, shut down and not listed anywhere: still counted.
    ctx.home.session(sessionId(1), [E.checkpoint(u(30), NOW - 50 * HOUR), E.shutdown(NOW - 50 * HOUR, u(30))], { mtime: NOW - 50 * HOUR });
    ctx.home.session(sessionId(2), [E.checkpoint(u(4.25), NOW - HOUR)], { mtime: NOW - HOUR });
    ctx.home.open([sessionId(2)]);
    ctx.make().boot();
    expect(ctx.account()).toMatchObject({
      usageStatus: 'ok',
      usage: { source: 'copilot', credits: { month: 34.25, today: 4.25, resetsAt: DEC_1 } },
    });
    expect(ctx.account().usage?.credits?.limit).toBeUndefined();
  });

  it('a new checkpoint shows at the next rescan; nothing is pushed again while nothing changes', () => {
    const ctx = setup();
    const path = ctx.home.session(sessionId(1), [E.checkpoint(u(2), NOW - HOUR)], { mtime: NOW - HOUR });
    const source = ctx.make();
    source.boot();
    expect(ctx.account().usage?.credits?.month).toBe(2);
    const before = ctx.changes();
    ctx.set(NOW + 1_000);
    source.poll();
    expect(ctx.changes()).toBe(before);
    ctx.home.append(path, [E.checkpoint(u(5), NOW + 2_000), E.shutdown(NOW + 3_000, u(5))]);
    ctx.set(NOW + 11_000);
    source.poll();
    expect(ctx.account().usage?.credits).toMatchObject({ month: 5, today: 5 });
  });

  it('rollover: today starts again at 00:00 UTC, and the month on the 1st (back to "disabled")', () => {
    const ctx = setup();
    ctx.home.session(sessionId(1), [E.checkpoint(u(3), NOW - HOUR)], { mtime: NOW - HOUR });
    const source = ctx.make();
    source.boot();
    expect(ctx.account().usage?.credits).toMatchObject({ month: 3, today: 3 });
    ctx.set(Date.UTC(2026, 10, 16, 0, 0, 30));
    source.poll();
    expect(ctx.account().usage?.credits).toMatchObject({ month: 3, today: 0 });
    ctx.set(DEC_1 + 30_000);
    source.poll();
    expect(ctx.account()).toMatchObject({ usageStatus: 'disabled' });
  });

  it('the count is a running total: it never turns "stale" with age', () => {
    const ctx = setup();
    ctx.home.session(sessionId(1), [E.checkpoint(u(3), NOW - HOUR)], { mtime: NOW - HOUR });
    const source = ctx.make();
    source.boot();
    ctx.set(NOW + 5 * HOUR);
    source.poll();
    expect(ctx.account().usageStatus).toBe('ok');
  });

  it('HABBLAUD_COPILOT_CREDIT_LIMIT sets the allowance of every account; creditLimit in HABBLAUD_ACCOUNTS wins', () => {
    const one = setup({ HABBLAUD_COPILOT_CREDIT_LIMIT: '1500' });
    one.home.session(sessionId(1), [E.checkpoint(u(140), NOW - HOUR)], { mtime: NOW - HOUR });
    one.make().boot();
    expect(one.account().usage?.credits).toMatchObject({ month: 140, limit: 1500 });

    const raw = JSON.stringify([{ id: '.copilot', provider: 'copilot', creditLimit: 300 }]);
    const two = setup({ HABBLAUD_COPILOT_CREDIT_LIMIT: '1500', HABBLAUD_ACCOUNTS: raw });
    two.home.session(sessionId(1), [E.checkpoint(u(1), NOW - HOUR)], { mtime: NOW - HOUR });
    two.make().boot();
    expect(two.account().usage?.credits?.limit).toBe(300);
  });

  it('an invalid allowance is ignored with one warning', () => {
    const warn = vi.spyOn(log, 'warnOnce').mockImplementation(() => {});
    const raw = JSON.stringify([{ id: '.copilot', provider: 'copilot', creditLimit: 'lots' }]);
    const ctx = setup({ HABBLAUD_COPILOT_CREDIT_LIMIT: '-5', HABBLAUD_ACCOUNTS: raw });
    ctx.home.session(sessionId(1), [E.checkpoint(u(1), NOW - HOUR)], { mtime: NOW - HOUR });
    ctx.make().boot();
    expect(ctx.account().usage?.credits).toMatchObject({ month: 1 });
    expect(ctx.account().usage?.credits?.limit).toBeUndefined();
    const keys = warn.mock.calls.map((c) => c[0]);
    expect(keys.filter((k) => k === 'copilot-credit-limit')).toHaveLength(1);
    expect(keys.filter((k) => k === 'copilot-credit-limit-account')).toHaveLength(1);
    expect(warn.mock.calls.find((c) => c[0] === 'copilot-credit-limit')?.[1]).toMatch(/HABBLAUD_COPILOT_CREDIT_LIMIT must be a positive number/);
  });
});
