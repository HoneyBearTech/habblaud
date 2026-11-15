// Copilot source integration: a temporary Copilot folder (synthetic events), the AccountsService and the Office.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { copilotHome, E, sessionId } from '../../test/copilot-fixtures';
import { QUIET_WINDOW_MS, STALE_OPEN_MS, WAITING_QUIET_MS, CopilotSource } from './source';

setQuiet(true);

const S = sessionId(1);
const KEY = `.copilot:${S}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(opts: { tailBytes?: number; watch?: boolean } = {}) {
  const home = copilotHome();
  cleanups.push(home.cleanup);
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: home.home, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new CopilotSource({ accounts, office, dirs: [home.dir], env: {}, home: home.home, now, watch: opts.watch ?? false, tailBytes: opts.tailBytes });
  cleanups.unshift(() => source.stop());
  return {
    home,
    accounts,
    office,
    source,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
      office.tick();
      office.commit();
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
}

describe('Copilot source: presence and status', () => {
  it('listed session: main agent in the workspace.yaml room, with title, model, tokens and status', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.session(
      S,
      [
        E.start(S, { at: t0 - 60_000, cwd: '/home/user/fallback', model: 'model-a' }),
        E.user('Add a dark theme', t0 - 50_000),
        E.turnStart(t0 - 49_000),
        E.usage({ input: 1_200, output: 80, model: 'model-a', at: t0 - 48_000 }),
        E.message('', t0 - 47_000, [{ toolCallId: 'c1', name: 'bash' }]),
        E.toolStart('c1', 'bash', { command: 'npm test' }, t0 - 46_000),
      ],
      { cwd: '/home/user/project' },
    );
    ctx.home.open([S]);
    ctx.source.boot();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'copilot',
      account: '.copilot',
      sessionId: S,
      roomId: '/home/user/project',
      role: 'Main agent (Copilot)',
      status: 'working',
      title: 'Add a dark theme',
      model: 'model-a',
    });
    expect(a.stats).toMatchObject({ tokensIn: 1_200, tokensOut: 80, toolCalls: 1 });
    expect(a.activity?.text).toBe('Running tests');
    expect(ctx.source.sources()).toEqual([{ label: '.copilot', provider: 'copilot', path: ctx.home.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBe(realpathSync(path));
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.copilot', provider: 'copilot', name: 'Copilot' });

    // Permission prompt: needs you; then approved, the final answer makes it idle.
    ctx.advance(1_000);
    ctx.home.append(path, [E.permission('r1', { kind: 'shell', fullCommandText: 'rm -rf build' }, ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'approve a command' });
    ctx.advance(1_000);
    ctx.home.append(path, [E.permissionDone('r1', ctx.now()), E.toolEnd('c1', ctx.now() + 1), E.turnEnd(ctx.now() + 2)]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.home.append(path, [E.turnStart(ctx.now() + 3), E.message('Done: dark theme added.', ctx.now() + 4), E.turnEnd(ctx.now() + 5)]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');

    // Shutdown is authoritative, even with the session still listed as open.
    ctx.advance(1_000);
    ctx.home.append(path, [E.shutdown(ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('a stale open-sessions entry never brings back a session that already shut down', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - 5_000 }), E.user('hi', t0 - 4_000), E.shutdown(t0 - 1_000)], { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
  });

  it('not listed: present while the events file changed within the quiet window', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - 5_000 }), E.user('hi', t0 - 4_000), E.turnStart(t0 - 3_000), E.message('Hello!', t0 - 2_000), E.turnEnd(t0 - 1_000)], {
      cwd: '/home/user/project',
    });
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(QUIET_WINDOW_MS + 11_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('listed but quiet for longer than STALE_OPEN_MS: taken as a crash, it does not come in', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - STALE_OPEN_MS - 10_000 })], { cwd: '/home/user/project', mtime: t0 - STALE_OPEN_MS - 10_000 });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
  });

  it('room from session.start when there is no workspace.yaml; a folder without events.jsonl is skipped', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - 1_000, cwd: '/home/user/other' })]);
    const empty = sessionId(2);
    mkdirSync(join(ctx.home.dir, 'session-state', empty));
    ctx.home.open([S, empty]);
    ctx.source.boot();
    expect(ctx.agent()?.roomId).toBe('/home/user/other');
    expect(ctx.agent(`.copilot:${empty}`)).toBeUndefined();
    expect(ctx.source.sources()[0].sessions).toBe(1);
  });

  it('a session whose folder disappears leaves', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - 1_000 })], { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    rmSync(join(ctx.home.dir, 'session-state', S), { recursive: true });
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('large file: the end window at once and the start (tokens, title) in the background', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('The very first prompt', t0 - 99_000)];
    for (let i = 0; i < 60; i++) lines.push(E.usage({ input: 100, output: 10, at: t0 - 90_000 + i }));
    lines.push(E.turnStart(t0 - 1_000));
    ctx.home.session(S, lines, { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.stats.tokensIn).toBeLessThan(6_000);
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()).toMatchObject({ title: 'The very first prompt', status: 'working' });
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 6_000, tokensOut: 600 });
  });

  /** Filler after the given lines, so that a 2 KB end window starts after them. */
  const filler = (t0: number) => Array.from({ length: 60 }, (_, i) => E.usage({ input: 100, output: 10, at: t0 - 90_000 + i }));
  const NO_CREATED_AT = `id: ${S}\ncwd: /home/user/project\n`;

  it('large file: a turn started before the window is working once the start is read', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('Build it', t0 - 99_000), E.turnStart(t0 - 98_000), E.toolStart('c1', 'bash', { command: 'npm run build' }, t0 - 97_000), ...filler(t0)];
    ctx.home.session(S, lines, { workspace: NO_CREATED_AT });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()?.status).toBe('working');
  });

  it('large file: a permission prompt opened before the window is waiting once the start is read, until completed', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('Deploy', t0 - 99_000), E.turnStart(t0 - 98_000), E.permission('r1', { kind: 'shell', fullCommandText: 'deploy' }, t0 - 97_000), ...filler(t0)];
    const path = ctx.home.session(S, lines, { workspace: NO_CREATED_AT });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'approve a command' });
    ctx.home.append(path, [E.permissionDone('r1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
  });

  it('large file: newer events in the window win over the start (the turn ended, the prompt was answered)', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('Fix it', t0 - 99_000), E.turnStart(t0 - 98_000), E.permission('r1', { kind: 'shell' }, t0 - 97_000), ...filler(t0)];
    lines.push(E.permissionDone('r1', t0 - 3_000), E.turnStart(t0 - 2_500), E.message('Fixed.', t0 - 2_000), E.turnEnd(t0 - 1_500));
    ctx.home.session(S, lines, { workspace: NO_CREATED_AT });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.waitingFor).toBeUndefined();
  });

  it('large file: once the start is read, the first prompt is the title and session.start is the start time', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('The very first prompt', t0 - 99_000), ...filler(t0), E.user('A later prompt', t0 - 1_000)];
    ctx.home.session(S, lines, { workspace: NO_CREATED_AT });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()?.title).toBe('A later prompt');
    expect(ctx.agent()?.startedAt).toBeGreaterThan(t0 - 100_000);
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()).toMatchObject({ title: 'The very first prompt', startedAt: t0 - 100_000 });
  });

  it('large file without session.start in the start: the workspace.yaml created_at stays the start time', async () => {
    const ctx = setup({ tailBytes: 2_000 });
    const t0 = ctx.now();
    const lines = [E.user('The very first prompt', t0 - 99_000), ...filler(t0), E.user('A later prompt', t0 - 1_000)];
    ctx.home.session(S, lines, { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    const created = Date.parse('2026-11-01T10:00:00.000Z');
    expect(ctx.agent()?.startedAt).toBe(created);
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()).toMatchObject({ title: 'The very first prompt', startedAt: created });
  });
});

describe('Copilot source: the "needs you" line', () => {
  it('after permission.completed the character works again and the line goes back to what it was doing', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.session(S, [E.start(S, { at: t0 - 10_000 }), E.user('Clean up', t0 - 9_000), E.turnStart(t0 - 8_000), E.toolStart('c1', 'bash', { command: 'rm -rf build', description: 'Removing the build' }, t0 - 7_000)], { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    const before = ctx.agent()!.activity?.text;
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    ctx.home.append(path, [E.permission('r1', { kind: 'shell', fullCommandText: 'rm -rf build' }, ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', activity: { text: 'Needs you: approve a command' } });
    ctx.advance(1_000);
    ctx.home.append(path, [E.permissionDone('r1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent()?.activity?.text).toBe(before);
    expect(ctx.agent()?.activity?.text).not.toContain('Needs you');
  });
});

describe('Copilot source: a killed process', () => {
  const waitingSession = (ctx: ReturnType<typeof setup>) => {
    const t0 = ctx.now();
    ctx.home.session(S, [E.start(S, { at: t0 - 10_000 }), E.user('Deploy', t0 - 9_000), E.turnStart(t0 - 8_000), E.permission('r1', { kind: 'shell', fullCommandText: 'deploy' }, t0 - 7_000)], { cwd: '/home/user/project' });
  };

  it('waiting with no write for an hour (no shutdown, still listed): the "needs you" goes, the character stays idle', () => {
    const ctx = setup();
    waitingSession(ctx);
    ctx.home.open([S]);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'approve a command' });
    ctx.advance(WAITING_QUIET_MS - 60_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('waiting');
    ctx.advance(2 * 60_000);
    ctx.poll();
    const a = ctx.agent()!;
    expect(a.status).toBe('idle');
    expect(a.waitingFor).toBeUndefined();
    expect(a.activity?.text ?? '').not.toContain('Needs you');
  });

  it('an open-sessions refreshedAt newer than the last write counts as activity; an older one does not', () => {
    const ctx = setup();
    waitingSession(ctx);
    ctx.home.open([S]);
    ctx.source.boot();
    ctx.advance(50 * 60_000);
    ctx.home.open([S], { refreshedAt: ctx.now() });
    ctx.poll();
    ctx.advance(30 * 60_000); // 80 min since the write, 30 since the refresh
    ctx.poll();
    expect(ctx.agent()?.status).toBe('waiting');
    ctx.advance(31 * 60_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });
});

describe('Copilot source: after session.shutdown', () => {
  type Internals = { sessions: Map<string, { watcher?: unknown; backlog: unknown[]; prefixEnd?: number }> };
  const tracker = (ctx: ReturnType<typeof setup>) => (ctx.source as unknown as Internals).sessions.get(KEY)!;

  it('no watch, no backlog and no read of the start; new events (resumed) bring them back', async () => {
    const ctx = setup({ tailBytes: 2_000, watch: true });
    const t0 = ctx.now();
    const lines = [E.start(S, { at: t0 - 100_000 }), E.user('The very first prompt', t0 - 99_000)];
    for (let i = 0; i < 60; i++) lines.push(E.usage({ input: 100, output: 10, at: t0 - 90_000 + i }));
    lines.push(E.user('A later prompt', t0 - 2_000), E.shutdown(t0 - 1_000));
    const path = ctx.home.session(S, lines, { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    await ctx.source.idle();
    expect(ctx.agent()).toBeUndefined();
    expect(tracker(ctx).watcher).toBeUndefined();
    expect(tracker(ctx).backlog).toEqual([]);
    expect(tracker(ctx).prefixEnd).toBeGreaterThan(0);

    ctx.advance(1_000);
    ctx.home.append(path, [E.user('Back again', ctx.now())]);
    ctx.poll();
    await ctx.source.idle();
    ctx.office.tick();
    expect(ctx.agent()).toMatchObject({ status: 'working', title: 'The very first prompt' });
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 6_000, tokensOut: 600 });
    expect(tracker(ctx).watcher).toBeDefined();
    expect(tracker(ctx).prefixEnd).toBeUndefined();
  });

  it('a live shutdown closes the watch and a later resume opens it again', () => {
    const ctx = setup({ watch: true });
    const t0 = ctx.now();
    const path = ctx.home.session(S, [E.start(S, { at: t0 - 5_000 }), E.user('hi', t0 - 4_000)], { cwd: '/home/user/project' });
    ctx.home.open([S]);
    ctx.source.boot();
    expect(tracker(ctx).watcher).toBeDefined();
    ctx.advance(1_000);
    ctx.home.append(path, [E.shutdown(ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(tracker(ctx).watcher).toBeUndefined();
    expect(tracker(ctx).backlog).toEqual([]);
    ctx.advance(1_000);
    ctx.home.append(path, [E.user('again', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(tracker(ctx).watcher).toBeDefined();
  });
});
