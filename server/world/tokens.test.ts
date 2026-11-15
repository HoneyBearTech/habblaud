// Building tokens (server/world/tokens.ts): sum of input + output of today and of the 7 calendar days, only from the
// real source (the demo never goes in), only from the accounts of tools World accepts, rounded to 2 digits.
import { describe, expect, it } from 'vitest';
import { zeroCounts, type DayStatsResponse, type StatsSource } from '../../shared/daystats';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import { DayStatsService } from '../history/daystats';
import { setQuiet } from '../log';
import { BuildingTokens } from './tokens';

setQuiet(true);

const S = 1_000;
/** 15/10/2026 10:00 UTC. */
const T0 = Date.UTC(2026, 9, 15, 10);

function fakeStats(perDay: Record<string, [number, number]>, today = '2026-10-15') {
  const calls: Array<[string, StatsSource | undefined]> = [];
  return {
    calls,
    tz: 'UTC',
    today: () => today,
    day(day: string, _tz: string, source?: StatsSource): DayStatsResponse | null {
      calls.push([day, source]);
      const v = perDay[day];
      if (!v) return null;
      const counts = { ...zeroCounts(), tokensIn: v[0], tokensOut: v[1] };
      return { source: 'real', demoAvailable: false, today, serverTime: T0, stats: { totals: { counts }, accounts: [{ id: 'acc', counts }] } } as unknown as DayStatsResponse;
    },
  };
}

describe('BuildingTokens', () => {
  it('today and the 7 consecutive days (today + 6), rounded; a day without data counts as zero', () => {
    const stats = fakeStats({
      '2026-10-15': [1_000_000, 234_567],
      '2026-10-14': [5_000_000, 1_000],
      '2026-10-09': [1_000, 1_000],
      '2026-10-08': [9_999_999_999, 0], // outside the week
    });
    const t = new BuildingTokens({ stats, now: () => T0 });
    expect(t.read()).toEqual({ day: 1_200_000, week: 6_200_000 });
    expect(stats.calls.every(([, src]) => src === 'real')).toBe(true);
    expect(stats.calls.map(([d]) => d).sort()).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
  });

  it('past days stay stored; today is reread after the deadline', () => {
    const per: Record<string, [number, number]> = { '2026-10-15': [100, 0], '2026-10-14': [50, 0] };
    const stats = fakeStats(per);
    let now = T0;
    const t = new BuildingTokens({ stats, now: () => now, ttlMs: 10_000 });
    expect(t.read()).toEqual({ day: 100, week: 150 });
    per['2026-10-15'] = [300, 0];
    per['2026-10-14'] = [999, 0];
    expect(t.read()).toEqual({ day: 100, week: 150 });
    now += 10_000;
    expect(t.read()).toEqual({ day: 300, week: 350 });
    expect(stats.calls.filter(([d]) => d === '2026-10-14')).toHaveLength(1);
  });

  it('with the real DayStatsService and the demo on: only the tokens of the real agents', () => {
    let now = T0;
    const real: AgentInfo = {
      id: '.claude:1', kind: 'main', roomId: '/p/store', name: 'Ana', look: 'f', role: 'Main agent', sessionId: 'sess-1',
      account: '.claude', status: 'working', recent: [], tasks: [], startedAt: T0 - 60_000, lastEventAt: T0, statusSince: T0,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1,
    };
    const demo: AgentInfo = { ...real, id: 'demo:abc-1', roomId: '/demo/store', account: 'demo:.claude', sessionId: 'sess-demo' };
    let agents = [real, demo];
    const snap = (): Pick<OfficeSnapshot, 'agents' | 'rooms' | 'accounts' | 'meta'> => ({
      agents,
      rooms: [],
      accounts: [],
      meta: { demo: true, sources: [], startedAt: 0, version: 'test' },
    });
    const svc = new DayStatsService({ dir: null, tz: 'UTC', now: () => now, snapshot: snap });
    const step = (until: number) => {
      while (now < until) {
        now += S;
        svc.sample(now);
      }
    };
    step(T0 + 120 * S); // gets past the boot settling
    agents = [
      { ...real, stats: { ...real.stats, tokensIn: 40_000, tokensOut: 2_000 } },
      { ...demo, stats: { ...demo.stats, tokensIn: 7_000_000, tokensOut: 900_000 } },
    ];
    step(T0 + 130 * S);
    expect(svc.isDemo()).toBe(true);
    // Without `source`, today with the demo on would bring the demo bucket: not here.
    expect(svc.day('2026-10-15', 'UTC')?.source).toBe('demo');
    const t = new BuildingTokens({ stats: svc, now: () => now });
    expect(t.read()).toEqual({ day: 42_000, week: 42_000 });
  });

  it('the tokens of tools World leaves out (Copilot) do not count; the other tools do', () => {
    const stats = fakeStats({});
    const counts = (tokensIn: number, tokensOut: number) => ({ ...zeroCounts(), tokensIn, tokensOut });
    stats.day = (day: string, _tz: string, source?: StatsSource) => {
      stats.calls.push([day, source]);
      if (day !== '2026-10-15') return null;
      const accounts = [
        { id: 'acc-default', counts: counts(10_000, 1_000) },
        { id: '.codex', provider: 'codex', counts: counts(20_000, 2_000) },
        { id: '.copilot', provider: 'copilot', counts: counts(9_000_000, 900_000) },
      ];
      return { source: 'real', demoAvailable: false, today: day, serverTime: T0, stats: { totals: { counts: counts(9_030_000, 903_000) }, accounts } } as unknown as DayStatsResponse;
    };
    expect(new BuildingTokens({ stats, now: () => T0 }).read()).toEqual({ day: 33_000, week: 33_000 });
  });

  it('with the real DayStatsService: a Copilot agent in the office adds nothing to the building tokens', () => {
    let now = T0;
    const base: AgentInfo = {
      id: 'acc-a:1', kind: 'main', roomId: '/p/store', name: 'Ana', look: 'f', role: 'Main agent', sessionId: 'sess-1',
      account: 'acc-a', status: 'working', recent: [], tasks: [], startedAt: T0 - 60_000, lastEventAt: T0, statusSince: T0,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1,
    };
    const copilot: AgentInfo = { ...base, id: '.copilot:2', account: '.copilot', sessionId: 'sess-2', provider: 'copilot' };
    let agents = [base, copilot];
    const snap = (): Pick<OfficeSnapshot, 'agents' | 'rooms' | 'accounts' | 'meta'> => ({
      agents,
      rooms: [],
      accounts: [
        { id: 'acc-a', name: 'A', short: 'A', color: '#123456' },
        { id: '.copilot', name: 'Copilot', short: 'CP', color: '#654321', provider: 'copilot' },
      ] as unknown as OfficeSnapshot['accounts'],
      meta: { demo: false, sources: [], startedAt: 0, version: 'test' },
    });
    const svc = new DayStatsService({ dir: null, tz: 'UTC', now: () => now, snapshot: snap });
    const step = (until: number) => {
      while (now < until) {
        now += S;
        svc.sample(now);
      }
    };
    step(T0 + 120 * S);
    agents = [
      { ...base, stats: { ...base.stats, tokensIn: 40_000, tokensOut: 2_000 } },
      { ...copilot, stats: { ...copilot.stats, tokensIn: 3_000_000, tokensOut: 100_000 } },
    ];
    step(T0 + 130 * S);
    const day = svc.day('2026-10-15', 'UTC', 'real')!;
    expect(day.stats.totals.counts.tokensIn).toBe(3_040_000);
    expect(day.stats.accounts.find((a) => a.id === '.copilot')?.provider).toBe('copilot');
    expect(new BuildingTokens({ stats: svc, now: () => now }).read()).toEqual({ day: 42_000, week: 42_000 });
  });
});
