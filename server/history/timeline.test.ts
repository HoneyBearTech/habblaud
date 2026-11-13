import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import { applyChanges, frameOf, parseTimeline, type TimelineDelta, type TimelineKeyframe, type TimelineRecord } from '../../shared/timeline';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { listTimelineDays, TimelineRecorder, timelineFile, type TimelineRecorderOptions } from './timeline';

setQuiet(true);

const T0 = new Date(2026, 9, 7, 10, 0).getTime();

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId: '/p/store',
    name: 'Marina',
    look: 'f',
    role: 'Main agent',
    sessionId: `s-${id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...extra,
  };
}

function snap(agents: AgentInfo[]): OfficeSnapshot {
  return {
    rev: 1,
    serverTime: T0,
    rooms: agents.length ? [{ id: '/p/store', name: 'store', path: '/p/store', slot: 0, seed: 3, createdAt: T0 }] : [],
    agents,
    accounts: [],
    meta: { demo: false, sources: [], startedAt: T0, version: 't' },
  };
}

let tmp: { dir: string; cleanup: () => void };
let dir: string;
let now: number;

beforeEach(() => {
  tmp = tempDir('habblaud-tl-');
  dir = join(tmp.dir, 'timeline');
  now = T0;
});
afterEach(() => tmp.cleanup());

const recorder = (opts: Partial<TimelineRecorderOptions> = {}) => new TimelineRecorder({ dir, now: () => now, ...opts });
const read = (day = '2026-10-07'): TimelineRecord[] => {
  const f = join(dir, `${day}.jsonl`);
  return existsSync(f) ? parseTimeline(readFileSync(f, 'utf8')) : [];
};

describe('timeline recorder', () => {
  it('keyframe first; deltas with a 1 s throttle and only when something changed', () => {
    const rec = recorder();
    rec.ingest(snap([agent('.claude:1')]));
    let recs = read();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ t: 'k', at: T0, boot: true, every: 300_000 });
    expect((recs[0] as TimelineKeyframe).agents.map((a) => a.id)).toEqual(['.claude:1']);

    now += 200;
    rec.ingest(snap([agent('.claude:1', { status: 'idle', statusSince: now })]));
    expect(read()).toHaveLength(1); // inside the throttle
    now += 300;
    rec.ingest(snap([agent('.claude:1', { status: 'waiting', statusSince: now, waitingFor: 'answer' })]));
    expect(read()).toHaveLength(1);
    now += 600; // 1.1 s after the keyframe: the internal clock writes the most recent state
    rec.tick();
    recs = read();
    expect(recs).toHaveLength(2);
    expect(recs[1]).toEqual({ t: 'd', at: now, agents: [['.claude:1', { status: 'waiting', statusSince: T0 + 500, waitingFor: 'answer' }]] });

    // Change only in what the player does not draw (numbers, rev): nothing.
    now += 5_000;
    rec.ingest({ ...snap([agent('.claude:1', { status: 'waiting', statusSince: T0 + 500, waitingFor: 'answer', stats: { toolCalls: 9, tokensIn: 1, tokensOut: 1, subagents: 0 } })]), rev: 99 });
    rec.tick();
    expect(read()).toHaveLength(2);

    // New agent and the old one leaving, in the same delta.
    now += 1_000;
    rec.ingest(snap([agent('.claude:2', { name: 'Caio' })]));
    const d = read()[2] as TimelineDelta;
    expect(d.t).toBe('d');
    expect(new Map(d.agents)).toEqual(
      new Map([
        ['.claude:2', expect.objectContaining({ id: '.claude:2', name: 'Caio' })],
        ['.claude:1', null],
      ]),
    );
  });

  it('the file rebuilds the last state (keyframe + deltas)', () => {
    const rec = recorder();
    const states = [
      [agent('.claude:1')],
      [agent('.claude:1', { activity: { id: 'a', kind: 'read', icon: '📖', text: 'Reading App.tsx', at: T0 + 1 } })],
      [agent('.claude:1', { status: 'shell', shells: [{ id: 'j', label: 'Build', startedAt: T0, background: true, kind: 'shell' }] }), agent('s:x', { kind: 'sub', parentId: '.claude:1' })],
      [agent('.claude:1', { status: 'idle', activity: { id: 'b', kind: 'done', icon: '✅', text: 'Done', at: T0 + 2 } })],
    ];
    for (const s of states) {
      rec.ingest(snap(s));
      now += 1_500;
    }
    const recs = read();
    expect(recs.map((r) => r.t)).toEqual(['k', 'd', 'd', 'd']);
    const frame = frameOf(recs[0] as TimelineKeyframe);
    for (const r of recs.slice(1)) applyChanges(frame, r as TimelineDelta);
    expect([...frame.agents.keys()]).toEqual(['.claude:1']);
    expect(frame.agents.get('.claude:1')).toMatchObject({ status: 'idle', activity: { text: 'Done' } });
    expect(frame.agents.get('.claude:1')!.shells).toBeUndefined();
  });

  it('periodic keyframe (every 5 min, even with no change) and end marked on stop', () => {
    const rec = recorder();
    rec.ingest(snap([agent('.claude:1')]));
    now += 299_000;
    rec.tick();
    expect(read()).toHaveLength(1);
    now += 1_000;
    rec.tick();
    const recs = read();
    expect(recs).toHaveLength(2);
    expect(recs[1]).toMatchObject({ t: 'k', at: T0 + 300_000 });
    expect(recs[1]).not.toHaveProperty('boot');
    now += 10;
    rec.stop();
    expect(read().at(-1)).toEqual({ t: 'end', at: T0 + 300_010 });
    // Restart on the same day: continues the same file, with a boot keyframe.
    const again = recorder();
    now += 60_000;
    again.ingest(snap([]));
    expect(read().at(-1)).toMatchObject({ t: 'k', boot: true, agents: [] });
  });

  it('day rollover: new file starting with a keyframe', () => {
    now = new Date(2026, 9, 7, 23, 59, 59, 500).getTime();
    const rec = recorder();
    rec.ingest(snap([agent('.claude:1')]));
    now = new Date(2026, 9, 8, 0, 0, 0, 200).getTime();
    rec.tick();
    expect(read('2026-10-07')).toHaveLength(1);
    const next = read('2026-10-08');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ t: 'k', at: now });
    expect(next[0]).not.toHaveProperty('boot');
    expect((next[0] as TimelineKeyframe).agents).toHaveLength(1);
  });

  it('retention: deletes only day files older than the last 7 days', () => {
    mkdirSync(dir, { recursive: true });
    const keep = ['2026-10-01', '2026-10-04', '2026-10-06'];
    const drop = ['2026-09-30', '2026-09-01', '2025-12-31'];
    for (const d of [...keep, ...drop]) writeFileSync(join(dir, `${d}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '2026-02-30.jsonl'), 'x');
    recorder().ingest(snap([]));
    expect(readdirSync(dir).sort()).toEqual(['2026-02-30.jsonl', ...keep.map((d) => `${d}.jsonl`), '2026-10-07.jsonl', 'notes.txt'].sort());
    // retentionDays 0 = never deletes (generator of the fictional timelapse)
    writeFileSync(join(dir, '2020-01-01.jsonl'), '{}\n');
    now = new Date(2026, 9, 8, 9).getTime();
    recorder({ retentionDays: 0 }).ingest(snap([]));
    expect(existsSync(join(dir, '2020-01-01.jsonl'))).toBe(true);
  });

  it('size limit: writes less after the soft limit and stops at the hard limit until the rollover', () => {
    const rec = recorder({ softBytes: 1_500, hardBytes: 3_000, slowThrottleMs: 10_000, slowKeyframeMs: 600_000 });
    let i = 0;
    const step = (ms: number) => {
      now += ms;
      rec.ingest(snap([agent('.claude:1', { activity: { id: String(i), kind: 'read', icon: '📖', text: `Reading file-${i++}.ts`, at: now } })]));
    };
    step(0);
    while (!rec.state.slow) step(1_000);
    const before = read().length;
    step(1_000);
    step(1_000);
    expect(read()).toHaveLength(before); // now only every 10 s
    step(8_000);
    expect(read()).toHaveLength(before + 1);
    // The next keyframe already announces the long interval.
    now += 600_000;
    rec.tick();
    expect(read().at(-1)).toMatchObject({ t: 'k', every: 600_000 });
    while (!rec.state.limited) step(10_000);
    const recs = read();
    expect(recs.at(-1)).toMatchObject({ t: 'end', reason: 'limit' });
    step(60_000);
    now += 3_600_000;
    rec.tick();
    expect(read()).toHaveLength(recs.length);
    // Next day: writes again.
    now = new Date(2026, 9, 8, 8).getTime();
    rec.tick();
    expect(read('2026-10-08')[0]).toMatchObject({ t: 'k' });
  });

  it('disk failure does not throw: warns, waits and comes back with a keyframe', () => {
    const blocked = join(tmp.dir, 'blocked');
    writeFileSync(blocked, 'I am not a folder');
    const rec = new TimelineRecorder({ dir: join(blocked, 'timeline'), now: () => now, retryMs: 60_000 });
    expect(() => rec.ingest(snap([agent('.claude:1')]))).not.toThrow();
    expect(rec.state.failing).toBe(true);
    rmSync(blocked);
    now += 30_000;
    rec.ingest(snap([agent('.claude:1', { status: 'idle' })]));
    expect(existsSync(join(blocked, 'timeline'))).toBe(false); // still waiting
    now += 30_000;
    rec.tick();
    const recs = parseTimeline(readFileSync(join(blocked, 'timeline', '2026-10-07.jsonl'), 'utf8'));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ t: 'k', agents: [expect.objectContaining({ status: 'idle' })] });
    expect(rec.state.failing).toBe(false);
  });
});

describe('available days', () => {
  it('list with size and time of the first and the last record, from most recent to oldest', () => {
    expect(listTimelineDays(join(tmp.dir, 'does-not-exist'))).toEqual([]);
    mkdirSync(dir, { recursive: true });
    const a = join(dir, '2026-10-06.jsonl');
    writeFileSync(a, `${JSON.stringify({ t: 'k', at: 100, v: 1, every: 1, rooms: [], agents: [], accounts: [] })}\n${JSON.stringify({ t: 'd', at: 250, agents: [['x', { activity: { at: 999 } }]] })}\n`);
    // Incomplete last line (still being written): it is left out.
    appendFileSync(a, '{"t":"d","at":300,"agents":[[');
    writeFileSync(join(dir, '2026-10-07.jsonl'), `${JSON.stringify({ t: 'k', at: 500, v: 1, every: 1, rooms: [], agents: [], accounts: [] })}\n`);
    writeFileSync(join(dir, '2026-10-05.jsonl'), '');
    writeFileSync(join(dir, 'junk.jsonl'), 'x');
    const days = listTimelineDays(dir);
    expect(days.map((d) => d.day)).toEqual(['2026-10-07', '2026-10-06']);
    expect(days[1]).toMatchObject({ from: 100, to: 250 });
    expect(days[1].bytes).toBeGreaterThan(100);
    expect(days[0]).toMatchObject({ from: 500, to: 500 });
  });

  it('file path only for valid days', () => {
    expect(timelineFile('/d', '2026-10-07')).toBe(join('/d', '2026-10-07.jsonl'));
    expect(timelineFile('/d', '../etc/passwd')).toBeNull();
    expect(timelineFile('/d', '2026-10-07/../../x')).toBeNull();
  });
});
