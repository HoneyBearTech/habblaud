import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotHome, E, ev, sessionId } from '../../test/copilot-fixtures';
import { tempDir } from '../../test/fixtures';
import { CopilotHistory, lineTime, readEventsSummary } from './history';

const S = sessionId(1);
const OLD = sessionId(2);
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(open: Record<string, string> = {}) {
  const home = copilotHome();
  cleanups.push(home.cleanup);
  const history = new CopilotHistory({ accounts: () => [{ id: '.copilot', dir: home.dir }], openAgentOf: (acc, sid) => open[`${acc}:${sid}`] });
  return { home, history };
}

describe('Copilot history', () => {
  it('lists the recent sessions with project, title, times and whether they are open', async () => {
    const now = Date.now();
    const ctx = setup({ [`.copilot:${S}`]: `.copilot:${S}` });
    ctx.home.session(S, [E.start(S, { at: now - 60_000, cwd: '/home/user/fallback' }), E.user('memory', now - 59_000, { source: 'memory' }), E.user('Write the docs', now - 58_000), E.turnEnd(now - 1_000)], {
      cwd: '/home/user/project',
    });
    ctx.home.session(OLD, [E.start(OLD, { at: now - 30 * 86_400_000 })], { mtime: now - 30 * 86_400_000 });
    const list = await ctx.history.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      account: '.copilot',
      provider: 'copilot',
      sessionId: S,
      project: '/home/user/project',
      title: 'Write the docs',
      firstAt: now - 60_000,
      lastAt: now - 1_000,
      open: true,
      agentId: `.copilot:${S}`,
    });
    expect(ctx.history.hasAccount('.copilot')).toBe(true);
    expect(ctx.history.hasAccount('.codex')).toBe(false);
  });

  it('resolve: validates the id and the account and returns the real events path', () => {
    const ctx = setup();
    const path = ctx.home.session(S, [E.start(S, { at: Date.now() })]);
    expect(ctx.history.resolve('.copilot', '../x')).toMatchObject({ status: 400 });
    expect(ctx.history.resolve('other', S)).toMatchObject({ status: 404 });
    expect(ctx.history.resolve('.copilot', sessionId(7))).toMatchObject({ status: 404 });
    const r = ctx.history.resolve('.copilot', S);
    expect('path' in r && r.path).toBe(realpathSync(path));
    expect('createParser' in r && r.createParser().push(E.user('hello', Date.now()))[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });

  it('a session whose events file links outside the Copilot folder is refused', () => {
    const ctx = setup();
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(join(outside.dir, 'events.jsonl'), `${E.start(S, { at: Date.now() })}\n`);
    mkdirSync(join(ctx.home.dir, 'session-state', S));
    symlinkSync(join(outside.dir, 'events.jsonl'), join(ctx.home.dir, 'session-state', S, 'events.jsonl'));
    expect(ctx.history.resolve('.copilot', S)).toMatchObject({ status: 404 });
  });

  it('the list never takes a session whose events file links outside the Copilot folder, even an open one', async () => {
    const ctx = setup({ [`.copilot:${S}`]: `.copilot:${S}` });
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(join(outside.dir, 'events.jsonl'), `${E.start(S, { at: Date.now() })}\n`);
    mkdirSync(join(ctx.home.dir, 'session-state', S));
    symlinkSync(join(outside.dir, 'events.jsonl'), join(ctx.home.dir, 'session-state', S, 'events.jsonl'));
    expect(await ctx.history.list()).toEqual([]);
  });

  it('last activity comes from each line\'s top-level timestamp, never from one nested in data', async () => {
    const now = Date.now();
    const ctx = setup();
    const nested = ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'ok', timestamp: new Date(now + 86_400_000).toISOString() } }, now - 2_000);
    const raw = JSON.stringify({ type: 'tool.execution_complete', data: { timestamp: new Date(now + 86_400_000).toISOString() }, id: 'x' });
    const path = ctx.home.session(S, [E.start(S, { at: now - 60_000 }), E.user('Go', now - 59_000), nested, raw], { cwd: '/home/user/project' });
    expect(lineTime(nested)).toBe(new Date(now - 2_000).getTime());
    expect(lineTime(raw)).toBeUndefined();
    expect(lineTime('{"timestamp":"' + new Date(now).toISOString() + '"')).toBeUndefined();
    expect(lineTime(JSON.stringify({ timestamp: new Date(now).toISOString(), pad: 'x'.repeat(20_000) }))).toBeUndefined();
    const summary = await readEventsSummary(realpathSync(path), statSync(path).size);
    expect(summary.lastAt).toBe(now - 2_000);
    expect((await ctx.history.list())[0]?.lastAt).toBe(now - 2_000);
  });
});
