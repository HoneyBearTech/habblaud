// Copilot AI credits from the session files: made-up sessions only (server/test/copilot-fixtures.ts).
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotHome, E, ev, sessionId } from '../../test/copilot-fixtures';
import { CopilotCredits, NANO_AIU_PER_CREDIT, parseCreditEvent, parseCreditLine, utcDayStart, utcMonthStart, utcNextMonthStart, type CreditFileStat } from './credits';

const HOUR = 3_600_000;
/** 15 Nov 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 15, 12);
const MONTH = utcMonthStart(NOW);
/** Credits → billionths of a unit. */
const u = (credits: number) => credits * NANO_AIU_PER_CREDIT;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const home = copilotHome();
  cleanups.push(home.cleanup);
  const paths = new Map<string, string>();
  return {
    home,
    /** Writes a session file, last changed at `mtime` (default NOW). */
    write(id: string, lines: string[], mtime = NOW) {
      paths.set(id, home.session(id, lines, { mtime }));
    },
    append(id: string, lines: string[], mtime = NOW) {
      const path = paths.get(id)!;
      home.append(path, lines);
      utimesSync(path, mtime / 1000, mtime / 1000);
    },
    /** What the rescan would list. */
    list(): CreditFileStat[] {
      return [...paths].map(([sessionId, path]) => {
        const st = statSync(path);
        return { sessionId, path, size: st.size, mtimeMs: st.mtimeMs };
      });
    },
    path: (id: string) => paths.get(id)!,
  };
}

describe('parseCreditLine', () => {
  it('reads totalNanoAiu of checkpoints and shutdowns at the top-level timestamp', () => {
    expect(parseCreditLine(E.checkpoint(49_210_470_000, NOW))).toEqual({ at: NOW, nano: 49_210_470_000 });
    expect(parseCreditLine(E.shutdown(NOW, u(3)))).toEqual({ at: NOW, nano: u(3) });
    expect(parseCreditLine(E.checkpoint(0, NOW))).toEqual({ at: NOW, nano: 0 });
  });

  it('ignores premium requests, invalid totals, missing timestamps and broken lines', () => {
    expect(parseCreditLine(E.premium(NOW))).toBeUndefined();
    expect(parseCreditLine(E.shutdown(NOW))).toBeUndefined();
    expect(parseCreditLine(E.checkpoint(-1, NOW))).toBeUndefined();
    expect(parseCreditLine(E.checkpoint('5000000000', NOW))).toBeUndefined();
    expect(parseCreditLine(E.checkpoint(null, NOW))).toBeUndefined();
    expect(parseCreditLine(JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 5 }, timestamp: 'not a date' }))).toBeUndefined();
    expect(parseCreditLine(JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 5 } }))).toBeUndefined();
    expect(parseCreditLine('{"type":"session.usage_checkpoint","data":{"totalNanoAiu":5')).toBeUndefined();
    expect(parseCreditLine('totalNanoAiu')).toBeUndefined();
  });

  it('session.start and session.resume are restarts; other events are nothing', () => {
    expect(parseCreditEvent(E.start(sessionId(1), { at: NOW }))).toBe('start');
    expect(parseCreditEvent(ev('session.resume', { sessionId: sessionId(1) }, NOW))).toBe('start');
    expect(parseCreditEvent(E.user('session.start', NOW))).toBeUndefined();
    expect(parseCreditEvent(E.checkpoint(5, NOW))).toEqual({ at: NOW, nano: 5 });
    expect(parseCreditLine(E.start(sessionId(1), { at: NOW }))).toBeUndefined();
  });

  it('UTC month, next month and day', () => {
    expect(new Date(MONTH).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(new Date(utcNextMonthStart(NOW)).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(new Date(utcNextMonthStart(Date.UTC(2026, 11, 31, 23))).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(new Date(utcDayStart(NOW)).toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });
});

describe('CopilotCredits', () => {
  it('several checkpoints: each rise counts once, in its UTC day', () => {
    const ctx = setup();
    ctx.write(sessionId(1), [
      E.start(sessionId(1), { at: NOW - 30 * HOUR }),
      E.checkpoint(u(5), NOW - 26 * HOUR), // 14 Nov
      E.user('hi', NOW - 25 * HOUR),
      E.checkpoint(u(12.5), NOW - 25 * HOUR), // 14 Nov
      E.checkpoint(u(30), NOW - HOUR), // 15 Nov
    ]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.ready('.copilot')).toBe(true);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 30, today: 17.5, hasData: true });
  });

  it('a checkpoint and the shutdown with the same total count once; premium requests never count', () => {
    const ctx = setup();
    ctx.write(sessionId(1), [E.checkpoint(49_210_470_000, NOW - HOUR), E.premium(NOW - HOUR), E.shutdown(NOW - HOUR, 49_210_470_000)]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 49.21, today: 49.21, hasData: true });
  });

  it('month boundary: what was used before the 1st (UTC) is only the baseline', () => {
    const ctx = setup();
    ctx.write(sessionId(1), [E.checkpoint(u(10), MONTH - 60_000), E.checkpoint(u(25), MONTH + 60_000)]);
    // Only last month: kept as the baseline, nothing this month.
    ctx.write(sessionId(2), [E.checkpoint(u(7), MONTH - 2 * HOUR), E.shutdown(MONTH - HOUR, u(7))]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 15, today: 0, hasData: true });
    // The day after the 1st and a new month: the old days drop out (recounted on rollover).
    expect(c.totals('.copilot', MONTH + 30 * HOUR)).toEqual({ month: 15, today: 0, hasData: true });
    expect(c.totals('.copilot', MONTH + 5 * HOUR)).toEqual({ month: 15, today: 15, hasData: true });
    const next = utcNextMonthStart(NOW) + HOUR;
    expect(c.totals('.copilot', next)).toEqual({ month: 0, today: 0, hasData: false });
  });

  it('a file last changed before this month is not read; when it changes, its old total is the baseline', () => {
    const ctx = setup();
    const s = sessionId(1);
    ctx.write(s, [E.checkpoint(u(40), MONTH - 3 * HOUR)], MONTH - 3 * HOUR);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 0, today: 0, hasData: false });
    // Resumed this month: only the rise over 40 counts.
    ctx.append(s, [E.checkpoint(u(42.25), NOW - HOUR)]);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 2.25, today: 2.25, hasData: true });
  });

  it('a total that goes down starts the baseline again, with nothing counted twice', () => {
    const ctx = setup();
    ctx.write(sessionId(1), [E.checkpoint(u(40), NOW - 3 * HOUR), E.checkpoint(u(10), NOW - 2 * HOUR), E.checkpoint(u(15), NOW - HOUR)]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(45);
  });

  it('a total that goes down after a new session.start or session.resume is a new counter, counted in full', () => {
    const ctx = setup();
    const s1 = sessionId(1);
    const s2 = sessionId(2);
    // 40 -> start -> 3 -> 45: 40 + 3 (the new counter) + 42 = 85.
    ctx.write(s1, [E.start(s1, { at: NOW - 5 * HOUR }), E.checkpoint(u(40), NOW - 4 * HOUR), E.start(s1, { at: NOW - 3 * HOUR }), E.checkpoint(u(3), NOW - 2 * HOUR), E.checkpoint(u(45), NOW - HOUR)]);
    // A resume: 10, then the 7 counts at its own timestamp (yesterday, UTC) and the 2 after it today = 19.
    ctx.write(s2, [E.checkpoint(u(10), NOW - 40 * HOUR), ev('session.resume', { sessionId: s2 }, NOW - 30 * HOUR), E.checkpoint(u(7), NOW - 29 * HOUR), E.shutdown(NOW - HOUR, u(9))]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 85 + 19, today: 85 + 2, hasData: true });
  });

  it('a drop with no new start/resume in between only starts the baseline again, also when the start came earlier', () => {
    const ctx = setup();
    const s1 = sessionId(1);
    // The start is before the 40, not between the 40 and the 10: the 10 is only the new baseline.
    ctx.write(s1, [E.start(s1, { at: NOW - 5 * HOUR }), E.checkpoint(u(40), NOW - 4 * HOUR), E.user('hi', NOW - 3 * HOUR), E.checkpoint(u(10), NOW - 2 * HOUR), E.checkpoint(u(15), NOW - HOUR)]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(45);
  });

  it('a restart in a later read of a growing file still counts the new counter in full', () => {
    const ctx = setup();
    const s1 = sessionId(1);
    ctx.write(s1, [E.checkpoint(u(40), NOW - 4 * HOUR)], NOW - 4 * HOUR);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    ctx.append(s1, [E.start(s1, { at: NOW - 3 * HOUR })], NOW - 3 * HOUR);
    c.update('.copilot', ctx.list(), NOW);
    ctx.append(s1, [E.checkpoint(u(3), NOW - 2 * HOUR)], NOW - 2 * HOUR);
    c.update('.copilot', ctx.list(), NOW);
    // A start followed by a HIGHER total is the same counter going on: only the rise.
    ctx.append(s1, [E.start(s1, { at: NOW - HOUR }), E.checkpoint(u(5), NOW - HOUR)]);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(45);
  });

  it('a file that grows: only the new bytes are read, the new rises add up', () => {
    const ctx = setup();
    const s = sessionId(1);
    ctx.write(s, [E.checkpoint(u(5), NOW - 3 * HOUR)], NOW - 3 * HOUR);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(5);
    // Same size and mtime: nothing new.
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(5);
    ctx.append(s, [E.checkpoint(u(8), NOW - 2 * HOUR), E.shutdown(NOW - 2 * HOUR, u(8))]);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(8);
    ctx.append(s, [E.checkpoint(u(11.5), NOW - HOUR)]);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW)).toEqual({ month: 11.5, today: 11.5, hasData: true });
  });

  it('a replaced or shrunk file is counted again from the start, replacing its old share', () => {
    const ctx = setup();
    const s = sessionId(1);
    ctx.write(s, [E.start(s, { at: NOW - 4 * HOUR }), E.checkpoint(u(20), NOW - 3 * HOUR), E.checkpoint(u(50), NOW - 2 * HOUR)], NOW - 2 * HOUR);
    ctx.write(sessionId(2), [E.checkpoint(u(1), NOW - HOUR)]);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(51);
    // Shrunk (rewritten shorter).
    ctx.write(s, [E.checkpoint(u(7), NOW - HOUR)], NOW - HOUR);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(8);
    // Replaced by a longer file with different content.
    ctx.write(s, [E.user('another start', NOW - 3 * HOUR), E.checkpoint(u(3), NOW - 3 * HOUR), E.checkpoint(u(4), NOW - 2 * HOUR), E.shutdown(NOW - HOUR, u(4))], NOW - 30 * 60_000);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(5);
  });

  it('broken lines, invalid totals and a half-written last line are skipped', () => {
    const ctx = setup();
    const s = sessionId(1);
    ctx.write(s, ['not json', '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":', E.checkpoint(u(2), NOW - 2 * HOUR), E.checkpoint(Number.NaN, NOW - HOUR), E.checkpoint(-5, NOW - HOUR), '']);
    const c = new CopilotCredits();
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(2);
    // A line without its line break yet waits for the rest.
    const half = E.checkpoint(u(6), NOW - HOUR);
    writeFileSync(ctx.path(s), half.slice(0, 20), { flag: 'a' });
    utimesSync(ctx.path(s), NOW / 1000 - 60, NOW / 1000 - 60);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(2);
    ctx.append(s, [half.slice(20)]);
    c.update('.copilot', ctx.list(), NOW);
    expect(c.totals('.copilot', NOW).month).toBe(6);
  });

  it('accounts are counted apart; a session folder that is gone drops out', () => {
    const ctx = setup();
    ctx.write(sessionId(1), [E.checkpoint(u(3), NOW - HOUR)]);
    ctx.write(sessionId(2), [E.checkpoint(u(4), NOW - HOUR)]);
    const c = new CopilotCredits();
    const [a, b] = ctx.list();
    c.update('.copilot', [a, b], NOW);
    c.update('.copilot-work', [{ ...a }], NOW);
    expect(c.totals('.copilot', NOW).month).toBe(7);
    expect(c.totals('.copilot-work', NOW).month).toBe(3);
    c.update('.copilot', [b], NOW);
    expect(c.totals('.copilot', NOW).month).toBe(4);
    expect(c.ready('.other')).toBe(false);
  });

  it('a read budget: a large first pass goes on in slices and the account is only ready at the end', () => {
    const ctx = setup();
    const filler = Array.from({ length: 200 }, (_, i) => E.user(`prompt ${i} ${'x'.repeat(200)}`, NOW - 2 * HOUR));
    ctx.write(sessionId(1), [E.checkpoint(u(1), NOW - 3 * HOUR), ...filler, E.checkpoint(u(9), NOW - HOUR)]);
    const c = new CopilotCredits({ budgetBytes: 8 * 1024, chunkBytes: 4 * 1024 });
    c.update('.copilot', ctx.list(), NOW);
    expect(c.ready('.copilot')).toBe(false);
    expect(c.hasPending()).toBe(true);
    // Without a new poll the budget stays spent: nothing more is read.
    c.pump(NOW);
    expect(c.ready('.copilot')).toBe(false);
    for (let i = 0; i < 20 && c.hasPending(); i++) {
      c.startPoll();
      c.pump(NOW);
    }
    expect(c.ready('.copilot')).toBe(true);
    expect(c.totals('.copilot', NOW).month).toBe(9);
  });

  it('one read budget per poll, shared by the pump and every account', () => {
    const filler = Array.from({ length: 200 }, (_, i) => E.user(`prompt ${i} ${'x'.repeat(200)}`, NOW - 2 * HOUR));
    const lines = [E.checkpoint(u(1), NOW - 3 * HOUR), ...filler, E.checkpoint(u(9), NOW - HOUR)];
    const a = setup();
    const b = setup();
    a.write(sessionId(1), lines);
    b.write(sessionId(2), lines);
    const size = a.list()[0].size;
    // A budget a bit larger than one file: the first account reads all of its file, the second almost nothing.
    const c = new CopilotCredits({ budgetBytes: size + 1024, chunkBytes: 4 * 1024 });
    c.startPoll();
    c.update('.copilot', a.list(), NOW);
    c.update('.copilot-work', b.list(), NOW);
    expect(c.ready('.copilot')).toBe(true);
    expect(c.ready('.copilot-work')).toBe(false);
    // The pump of the same poll gets no new budget either.
    c.pump(NOW);
    expect(c.ready('.copilot-work')).toBe(false);
    c.startPoll();
    c.pump(NOW);
    expect(c.ready('.copilot-work')).toBe(true);
    expect(c.totals('.copilot-work', NOW).month).toBe(9);
  });
});
