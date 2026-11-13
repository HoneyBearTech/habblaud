// Integration: registry + transcript + subagents in a temporary config dir.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Notice } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { ClaudeWatcher, encodeCwd } from './watcher';

setQuiet(true);

const CWD = '/projects/store';

function setup(opts: { tailBytes?: number } = {}) {
  const tmp = tempDir();
  const home = tmp.dir;
  const dir = join(home, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({
    dirs: [dir],
    home,
    env: {},
    now,
    onChange: () => late.office?.markDirty(),
  });
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
  const alive = new Set<number>();
  const watcher = new ClaudeWatcher({ accounts, office, inDocker: false, now, isAlive: (pid) => alive.has(pid), watch: false, tailBytes: opts.tailBytes });
  const notices: Notice[] = [];

  const ctx = {
    tmp,
    dir,
    office,
    watcher,
    advance(ms: number) {
      clock += ms;
    },
    now,
    openSession(pid: number, sessionId: string, extra: Record<string, unknown> = {}) {
      alive.add(pid);
      writeFileSync(
        join(dir, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId, cwd: CWD, startedAt: clock - 60_000, kind: 'interactive', status: 'busy', ...extra }),
      );
    },
    closeSession(pid: number) {
      alive.delete(pid);
      rmSync(join(dir, 'sessions', `${pid}.json`));
    },
    transcript(sessionId: string) {
      return join(dir, 'projects', encodeCwd(CWD), `${sessionId}.jsonl`);
    },
    subFile(sessionId: string, agentId: string, meta: Record<string, unknown>, lines: string[], runId?: string) {
      const base = join(dir, 'projects', encodeCwd(CWD), sessionId, 'subagents', ...(runId ? ['workflows', runId] : []));
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      const path = join(base, `agent-${agentId}.jsonl`);
      writeLines(path, lines);
      return path;
    },
    poll() {
      watcher.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    notices,
  };
  return ctx;
}

type Ctx = ReturnType<typeof setup>;

describe('ClaudeWatcher', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
  });
  afterEach(() => {
    c.watcher.stop();
    c.tmp.cleanup();
  });

  function bootWithSession(pid = 100, sid = 'sess-a') {
    writeLines(c.transcript(sid), [
      L.raw('ai-title', { aiTitle: 'Shopping cart' }),
      L.prompt('Fix the cart total', { at: c.now() - 5000 }),
      L.assistant([L.tool('r1', 'Read', { file_path: `${CWD}/src/Cart.tsx` })], { at: c.now() - 4000 }),
    ]);
    c.openSession(pid, sid);
    c.watcher.boot();
    c.notices.push(...c.office.commit().notices);
    return `.claude:${pid}`;
  }

  it('boot: open session becomes a main agent with room, title and activity, without notices', () => {
    const id = bootWithSession();
    const snap = c.office.commit().snapshot;
    expect(snap.rooms).toHaveLength(1);
    expect(snap.rooms[0]).toMatchObject({ id: CWD, name: 'store', slot: 0 });
    const a = c.agent(id)!;
    expect(a).toMatchObject({ kind: 'main', status: 'working', title: 'Shopping cart', role: 'Main agent', account: '.claude', roomId: CWD });
    expect(a.activity?.text).toBe('Reading Cart.tsx');
    expect(snap.accounts[0]).toMatchObject({ id: '.claude', short: 'A', sessions: 1 });
    expect(c.notices).toEqual([]);
    expect(c.office.recentFeed(10).map((f) => f.activity.kind)).toEqual(['prompt', 'read']);
  });

  it('follows appends to the transcript and the registry status', () => {
    const id = bootWithSession();
    appendLines(c.transcript('sess-a'), [L.assistant([L.tool('e1', 'Edit', { file_path: `${CWD}/src/Cart.tsx` })])]);
    c.poll();
    expect(c.agent(id)!.activity?.text).toBe('Editing Cart.tsx');
    c.openSession(100, 'sess-a', { status: 'waiting', waitingFor: 'permission' });
    c.poll();
    expect(c.agent(id)).toMatchObject({ status: 'waiting', waitingFor: 'approve a permission' });
    expect(c.notices.at(-1)?.text).toMatch(/^✋ .+ needs you in store: approve a permission$/);
    c.openSession(100, 'sess-a', { status: 'busy' });
    c.poll();
    c.openSession(100, 'sess-a', { status: 'idle' });
    c.poll();
    const a = c.agent(id)!;
    expect(a.status).toBe('idle');
    expect(a.activity?.kind).toBe('done');
    expect(c.notices.at(-1)).toMatchObject({ level: 'success', text: `✅ ${a.name} finished in store` });
  });

  it('publishes the prompts before and after a malformed TodoWrite in the same batch', () => {
    const id = bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.prompt('Earlier prompt'),
      L.assistant([L.tool('todo-malformed', 'TodoWrite', { todos: [null] })]),
      L.prompt('Later prompt'),
    ]);
    c.poll();
    expect(c.office.recentFeed(10).filter((f) => f.activity.kind === 'prompt').map((f) => f.activity.detail)).toEqual([
      'Fix the cart total', 'Earlier prompt', 'Later prompt',
    ]);
    expect(c.agent(id)!.activity?.detail).toBe('Later prompt');
    c.poll();
    expect(c.office.recentFeed(10).filter((f) => f.activity.detail === 'Later prompt')).toHaveLength(1);
  });

  it.each(['opening', 'append'])('keeps the valid lines of the subagent with a malformed TodoWrite (%s)', (mode) => {
    bootWithSession();
    const path = c.subFile('sess-a', 'malformed', { agentType: 'Explore', description: 'Review tasks' }, [L.prompt('Started', { agentId: 'malformed' })]);
    if (mode === 'append') c.poll();
    appendLines(path, [
      L.prompt('Earlier prompt', { agentId: 'malformed' }),
      L.assistant([L.tool('todo-malformed', 'TodoWrite', { todos: [null] })], { agentId: 'malformed' }),
      L.prompt('Later prompt', { agentId: 'malformed' }),
    ]);
    c.poll();
    expect(c.agent('sess-a:malformed')?.activity?.detail).toBe('Later prompt');
    expect(c.office.recentFeed(10).filter((f) => f.activity.kind === 'prompt' && f.agentId === 'sess-a:malformed').map((f) => f.activity.detail)).toEqual([
      'Started', 'Earlier prompt', 'Later prompt',
    ]);
  });

  it.each(['main', 'opening', 'append'])('logs parse errors and publishes the other lines of the batch (%s)', (mode) => {
    const mainId = bootWithSession();
    const agentId = `error-${mode}`;
    const id = mode === 'main' ? mainId : `sess-a:${agentId}`;
    const path = mode === 'main'
      ? c.transcript('sess-a')
      : c.subFile('sess-a', agentId, { agentType: 'Explore', description: 'Review CI' }, [L.prompt('Started', { agentId })]);
    if (mode === 'append') c.poll();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setQuiet(false);
    try {
      appendLines(path, [
        L.prompt('Earlier prompt'),
        L.assistant([L.tool('checks-malformed', 'Bash', { command: 'gh pr checks --json name,bucket' })]),
        L.result('checks-malformed', '[{"bucket":{"toString":null}}]'),
        L.assistant([L.tool('checks-other', 'Bash', { command: 'gh pr checks --json name,bucket' })]),
        L.result('checks-other', '[{"bucket":{"toString":null}}]'),
        L.prompt('Later prompt'),
      ]);
      c.poll();
      expect(c.office.recentFeed(10).filter((f) => f.agentId === id && f.activity.kind === 'prompt').map((f) => f.activity.detail).slice(-2)).toEqual([
        'Earlier prompt', 'Later prompt',
      ]);
      expect(c.agent(id)!.activity?.detail).toBe('Later prompt');
      expect(warn).toHaveBeenCalledWith(`[habblaud] Transcript line from ${id} skipped: Cannot convert object to primitive value`);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      setQuiet(true);
      warn.mockRestore();
    }
  });

  it('foreground subagent: enters, works and delivers when it completes', () => {
    const mainId = bootWithSession();
    appendLines(c.transcript('sess-a'), [L.assistant([L.tool('toolu_f', 'Agent', { description: 'Map files', subagent_type: 'Explore', prompt: 'x' })])]);
    c.subFile('sess-a', 'f1', { agentType: 'Explore', description: 'Map files', toolUseId: 'toolu_f', spawnDepth: 1, requestShape: 'foreground' }, [
      L.prompt('Map the cart files', { agentId: 'f1' }),
      L.assistant([L.tool('g1', 'Grep', { pattern: 'useCart' })], { agentId: 'f1' }),
    ]);
    c.poll();
    const sub = c.agent('sess-a:f1')!;
    const main = c.agent(mainId)!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: mainId, role: 'Explore', title: 'Map files', status: 'working', account: '.claude', roomId: CWD });
    expect(sub.background).toBeUndefined();
    expect(sub.name).not.toBe(main.name);
    expect(sub.activity?.text).toBe('Searching for “useCart”');
    expect(main.stats.subagents).toBe(1);

    appendLines(c.transcript('sess-a'), [L.result('toolu_f', 'found it', { toolUseResult: { status: 'completed', agentId: 'f1' } })]);
    c.poll();
    expect(c.agent('sess-a:f1')!.status).toBe('done');
    expect(c.notices.at(-1)?.text).toBe(`📦 ${sub.name} delivered “Map files” to ${main.name}`);
    c.advance(26_000);
    c.poll();
    expect(c.agent('sess-a:f1')).toBeUndefined();
  });

  it('background subagent: the launch does not complete it; the notification does', () => {
    bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_b', 'Agent', { description: 'Research API', subagent_type: 'general-purpose', run_in_background: true })]),
      L.result('toolu_b', 'launched', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'b1' } }),
    ]);
    c.subFile('sess-a', 'b1', { agentType: 'general-purpose', description: 'Research API', toolUseId: 'toolu_b', requestShape: 'background' }, [
      L.prompt('Research the API', { agentId: 'b1' }),
      L.assistant([L.tool('w1', 'WebSearch', { query: 'api pix' })], { agentId: 'b1' }),
    ]);
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent('sess-a:b1')).toMatchObject({ status: 'working', background: true });
    appendLines(c.transcript('sess-a'), [L.notification('toolu_b', 'completed', 'Found the documentation')]);
    c.poll();
    expect(c.agent('sess-a:b1')!.status).toBe('done');
  });

  it('background fork: enters and works (the copy of the parent call does not complete it); the notification completes it', () => {
    const mainId = bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_fk', 'Agent', { description: 'New art', subagent_type: 'fork', run_in_background: true })]),
      L.result('toolu_fk', 'launched', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'fk1' } }),
    ]);
    c.subFile('sess-a', 'fk1', { agentType: 'fork', isFork: true, description: 'New art', toolUseId: 'toolu_fk', spawnDepth: 1, requestShape: 'background' }, [
      ...L.forkStart('fk1', 'toolu_fk', 'Draw the poses', { agentId: 'fk1' }),
      L.assistant([L.tool('r1', 'Read', { file_path: `${CWD}/src/art.ts` })], { agentId: 'fk1' }),
    ]);
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent('sess-a:fk1')).toMatchObject({ kind: 'sub', parentId: mainId, role: 'fork', title: 'New art', status: 'working', background: true });
    expect(c.agent('sess-a:fk1')!.activity?.text).toBe('Reading art.ts');
    expect(c.agent(mainId)!.stats.subagents).toBe(1);
    appendLines(c.transcript('sess-a'), [L.notification('toolu_fk', 'completed', 'Poses ready')]);
    c.poll();
    expect(c.agent('sess-a:fk1')!.status).toBe('done');
  });

  it('fork with a large transcript (read from the end): the inherited start does not complete it either', () => {
    c.watcher.stop();
    c.tmp.cleanup();
    c = setup({ tailBytes: 600 });
    bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_fg', 'Agent', { description: 'Big art', subagent_type: 'fork', run_in_background: true })]),
      L.result('toolu_fg', 'launched', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'fk2' } }),
    ]);
    const work = Array.from({ length: 12 }, (_, i) => L.assistant([L.tool(`g${i}`, 'Grep', { pattern: `pattern${i}` })], { agentId: 'fk2' }));
    c.subFile('sess-a', 'fk2', { agentType: 'fork', description: 'Big art', toolUseId: 'toolu_fg', requestShape: 'background' }, [
      ...L.forkStart('fk2', 'toolu_fg', 'Draw everything', { agentId: 'fk2' }),
      ...work,
    ]);
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent('sess-a:fk2')).toMatchObject({ status: 'working' });
  });

  it('subagent completes by end_turn + 5 s of silence', () => {
    bootWithSession();
    c.subFile('sess-a', 'e1', { agentType: 'Plan', description: 'Plan', toolUseId: 'toolu_x' }, [
      L.prompt('Plan it', { agentId: 'e1' }),
      L.assistant([L.text('Plan ready.')], { agentId: 'e1', stop: 'end_turn' }),
    ]);
    c.poll();
    expect(c.agent('sess-a:e1')!.status).toBe('working');
    c.advance(6_000);
    c.poll();
    expect(c.agent('sess-a:e1')!.status).toBe('done');
  });

  it('workflow agents: enter through the workflows/ folder and leave with the workflow notification', () => {
    bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_wf', 'Workflow', { scriptPath: '/x.js' })]),
      L.result('toolu_wf', 'ok', { toolUseResult: { status: 'async_launched', taskId: 'wt1', runId: 'wf_1' } }),
    ]);
    for (const [agentId, label] of [
      ['w1', 'backend'],
      ['w2', 'ui'],
    ]) {
      c.subFile('sess-a', agentId, { agentType: 'workflow-subagent', description: label, workflowPhase: 'Build', spawnDepth: 1, requestShape: 'foreground' }, [
        L.prompt('Task', { agentId }),
      ], 'wf_1');
    }
    c.poll();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => [s.role, s.title, s.status])).toEqual([
      ['Workflow', 'backend', 'working'],
      ['Workflow', 'ui', 'working'],
    ]);
    expect(c.agent('.claude:100')!.stats.subagents).toBe(2);
    // The workflow journal records the result of each agent.
    writeLines(join(c.dir, 'projects', encodeCwd(CWD), 'sess-a', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [
      JSON.stringify({ type: 'started', agentId: 'w1', label: 'backend' }),
      JSON.stringify({ type: 'result', agentId: 'w1', result: {} }),
    ]);
    c.poll();
    expect(c.agent('sess-a:w1')!.status).toBe('done');
    expect(c.agent('sess-a:w2')!.status).toBe('working');
    appendLines(c.transcript('sess-a'), [L.notification('toolu_wf', 'completed', 'Workflow completed')]);
    c.poll();
    expect(c.agents().filter((a) => a.kind === 'sub').map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('at boot only subagents written in the last 90 s and not completed enter', () => {
    writeLines(c.transcript('sess-b'), [L.prompt('hi')]);
    const old = c.subFile('sess-b', 'old', { agentType: 'Explore', toolUseId: 't-old' }, [L.prompt('old', { agentId: 'old' })]);
    const past = (c.now() - 10 * 60_000) / 1000;
    utimesSync(old, past, past);
    c.subFile('sess-b', 'new', { agentType: 'Explore', toolUseId: 't-new' }, [L.prompt('new', { agentId: 'new' })]);
    c.openSession(200, 'sess-b');
    c.watcher.boot();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => s.id)).toEqual(['sess-b:new']);
    // The old one only comes back if it is written again.
    appendLines(old, [L.assistant([L.tool('z', 'Read', { file_path: '/a/b.ts' })], { agentId: 'old' })]);
    c.poll();
    expect(c.agent('sess-b:old')?.status).toBe('working');
  });

  it('at boot (server restart) whoever is in the middle of a long command comes back, even if quiet for minutes', () => {
    writeLines(c.transcript('sess-r'), [L.prompt('hi')]);
    const quiet = (path: string, ms: number) => {
      const t = (c.now() - ms) / 1000;
      utimesSync(path, t, t);
    };
    // Bash open for 3 min (no result yet): still working.
    const busy = c.subFile('sess-r', 'busy', { agentType: 'Explore', toolUseId: 't-busy' }, [
      L.prompt('run the battery', { agentId: 'busy', at: c.now() - 200_000 }),
      L.assistant([L.tool('b1', 'Bash', { command: 'npm test' })], { agentId: 'busy', at: c.now() - 180_000, stop: 'tool_use' }),
    ]);
    quiet(busy, 180_000);
    // Finished 3 min ago: stays out.
    const ended = c.subFile('sess-r', 'ended', { agentType: 'Explore', toolUseId: 't-ended' }, [
      L.assistant([L.text('done')], { agentId: 'ended', at: c.now() - 180_000, stop: 'end_turn' }),
    ]);
    quiet(ended, 180_000);
    // Tool pending for 12 min: past the limit, stays out.
    const stuck = c.subFile('sess-r', 'stuck', { agentType: 'Explore', toolUseId: 't-stuck' }, [
      L.assistant([L.tool('s1', 'Bash', { command: 'sleep 999' })], { agentId: 'stuck', at: c.now() - 720_000, stop: 'tool_use' }),
    ]);
    quiet(stuck, 720_000);
    // Workflow: journal says it started and did not finish (no pending tool, quiet for 100 s).
    const wf = c.subFile('sess-r', 'wf1', { agentType: 'workflow-subagent' }, [L.prompt('task', { agentId: 'wf1', at: c.now() - 100_000 })], 'run-1');
    writeFileSync(join(wf, '..', 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'wf1', label: 'Reviewer' })}\n`);
    quiet(wf, 100_000);
    c.openSession(400, 'sess-r');
    c.watcher.boot();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => s.id).sort()).toEqual(['sess-r:busy', 'sess-r:wf1']);
    expect(c.agent('sess-r:busy')).toMatchObject({ status: 'working', activity: { kind: 'test' } });
  });

  it('question that already arrives answered becomes "Got your answer"; an open one stays a question', () => {
    const id = bootWithSession(500, 'sess-q');
    const q = { questions: [{ question: 'Which database to use?', options: [] }] };
    appendLines(c.transcript('sess-q'), [
      L.assistant([L.tool('q1', 'AskUserQuestion', q)], { at: c.now() - 2_000, stop: 'tool_use' }),
      L.result('q1', 'Postgres', { at: c.now() - 1_000 }),
    ]);
    c.poll();
    expect(c.agent(id)!.activity).toMatchObject({ kind: 'ask', text: 'Got your answer', detail: 'Which database to use?' });
    appendLines(c.transcript('sess-q'), [L.assistant([L.tool('q2', 'AskUserQuestion', q)], { stop: 'tool_use' })]);
    c.poll();
    expect(c.agent(id)!.activity).toMatchObject({ kind: 'ask', text: 'Asking you a question' });
  });

  it('closed session: main agent leaves (offline), subagents leave with it, room disappears', () => {
    const id = bootWithSession();
    c.subFile('sess-a', 's1', { agentType: 'Explore', toolUseId: 't1' }, [L.prompt('x', { agentId: 's1' })]);
    c.poll();
    c.closeSession(100);
    c.poll();
    // A momentary disappearance from the registry does not close the session...
    expect(c.agent(id)!.status).toBe('working');
    c.advance(2_000);
    c.poll();
    // ...but a disappearance that persists does.
    expect(c.agent(id)!.status).toBe('offline');
    expect(c.agent('sess-a:s1')!.status).toBe('done');
    expect(c.notices.at(-1)?.text).toMatch(/^🚪 .+ ended the session$/);
    c.advance(21_000);
    c.poll();
    const snap = c.office.commit().snapshot;
    expect(snap.agents).toEqual([]);
    expect(snap.rooms).toEqual([]);
  });

  it('dead PID with the file still there = session ended', () => {
    const id = bootWithSession();
    c.closeSession(100);
    writeFileSync(join(c.dir, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'sess-a', cwd: CWD, status: 'idle' }));
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent(id)!.status).toBe('offline');
  });

  it('/clear: same process, new session — same character, tasks reset', () => {
    writeLines(c.transcript('sess-a'), [L.assistant([L.tool('t', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] })])]);
    c.openSession(100, 'sess-a');
    c.watcher.boot();
    const before = c.agent('.claude:100')!;
    expect(before.tasks).toHaveLength(1);
    writeLines(c.transcript('sess-c'), [L.prompt('Starting over')]);
    c.openSession(100, 'sess-c');
    c.poll();
    const after = c.agent('.claude:100')!;
    expect(after).toMatchObject({ name: before.name, sessionId: 'sess-c', tasks: [] });
    expect(after.recent.map((r) => r.kind)).toContain('compact');
    expect(after.activity?.kind).toBe('prompt');
  });

  it('new session after boot generates an arrival notice and a new room notice', () => {
    c.watcher.boot();
    writeLines(c.transcript('sess-n'), [L.prompt('Hello')]);
    c.openSession(300, 'sess-n', { agent: 'frinus' });
    c.poll();
    const a = c.agent('.claude:300')!;
    expect(a.role).toBe('Agent frinus');
    const texts = c.notices.map((n) => n.text);
    expect(texts).toContain('🏗️ New room: store');
    expect(texts).toContain(`👋 ${a.name} arrived in store (Account A)`);
  });
});

describe('ClaudeWatcher with a transcript larger than the boot window', () => {
  it('the long timeline gets the activities from the start of the file (without going to the feed)', async () => {
    const c = setup({ tailBytes: 1_500 });
    try {
      const t0 = c.now() - 600_000;
      const lines = Array.from({ length: 30 }, (_, i) => L.assistant([L.tool(`r${i}`, 'Read', { file_path: `${CWD}/src/file${i}.ts` })], { at: t0 + i * 1_000 }));
      writeLines(c.transcript('sess-h'), lines);
      c.openSession(600, 'sess-h');
      c.watcher.boot();
      const before = c.office.detail('.claude:600')!.history.length;
      expect(before).toBeLessThan(30);
      await c.watcher.idle();
      const history = c.office.detail('.claude:600')!.history;
      expect(history).toHaveLength(30);
      expect(history.map((a) => a.text)).toEqual(Array.from({ length: 30 }, (_, i) => `Reading file${i}.ts`));
      expect(c.office.recentFeed(100).filter((f) => f.agentId === '.claude:600')).toHaveLength(before);
    } finally {
      c.watcher.stop();
      c.tmp.cleanup();
    }
  });
});

describe('ClaudeWatcher — waiting for the shell', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
  });
  afterEach(() => {
    c.watcher.stop();
    c.tmp.cleanup();
  });

  const SUITE = { command: 'vendor/bin/phpunit --group cms', description: 'Run the complete suite', run_in_background: true };

  /** Turn that leaves a background Bash running and ends. */
  function backgroundTurn(at: number, id = 'toolu_bg', taskId = 'bo0ov3q3l', input: Record<string, unknown> = SUITE): string[] {
    return [
      L.prompt('Run the whole suite', { at: at - 2_000 }),
      L.assistant([L.tool(id, 'Bash', input)], { at, stop: 'tool_use' }),
      L.bgLaunched(id, taskId, { at: at + 500 }),
      L.assistant([L.text('I left the suite running; I will let you know when it finishes.')], { at: at + 1_000, stop: 'end_turn' }),
      L.system('turn_duration', { durationMs: 3_000 }, { at: at + 1_100 }),
    ];
  }

  it('registry "shell": stays waiting with the job, speech bubble and notice; the queue ends it with ShellDone and the delivery does not remove the ShellDone from the speech bubble', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-s'), backgroundTurn(t0 - 10_000));
    c.openSession(700, 'sess-s', { status: 'busy' });
    c.watcher.boot();
    const id = '.claude:700';
    expect(c.agent(id)!.shells).toEqual([
      { id: 'bo0ov3q3l', label: 'Run the complete suite', command: 'vendor/bin/phpunit --group cms', startedAt: t0 - 9_500, background: true, kind: 'shell' },
    ]);

    c.openSession(700, 'sess-s', { status: 'shell' });
    c.poll();
    let a = c.agent(id)!;
    expect(a.status).toBe('shell');
    expect(a.activity).toMatchObject({ kind: 'wait', icon: '⏳', text: 'Waiting on shell: Run the complete suite', tool: 'ShellWait' });
    expect(c.notices.map((n) => n.text)).toEqual([`⏳ ${a.name} is waiting on the shell in store: Run the complete suite`]);
    expect(c.office.recentFeed(1)[0].activity.tool).toBe('ShellWait');

    // Time passes; nothing changes (no new notices, no new speech bubble).
    c.advance(60_000);
    c.poll();
    expect(c.notices).toHaveLength(1);

    // The shell ends: the queue records the notification; the agent wakes up and receives the message.
    appendLines(c.transcript('sess-s'), [
      L.shellNotification('queue', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "Run the complete suite" completed (exit code 0)' }, { at: c.now() }),
      L.shellNotification('message', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed' }, { at: c.now() + 10 }),
    ]);
    c.openSession(700, 'sess-s', { status: 'busy' });
    c.poll();
    a = c.agent(id)!;
    expect(a.status).toBe('working');
    expect(a.shells).toBeUndefined();
    expect(a.activity).toMatchObject({ tool: 'ShellDone', icon: '✅', text: 'Shell finished: Run the complete s… (1min 10s)', durationMs: 69_500 });
    expect(a.activity!.error).toBeUndefined();
    expect(c.notices.at(-1)).toMatchObject({ level: 'success', text: `✅ ${a.name}: shell finished in store — Run the complete suite` });
    expect(c.office.recentFeed(2).map((f) => f.activity.text)).toEqual(['Shell finished: Run the complete s… (1min 10s)', 'Got a background result']);
    // No "finished" along the way: the end of the turn became a wait for the shell.
    expect(c.notices.some((n) => n.text.includes(`${a.name} finished`))).toBe(false);
  });

  it('boot in "shell": speech bubble without notice; only the message (without queue) ends it; failure => error and yellow alert notice', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-f'), backgroundTurn(t0 - 30_000, 'toolu_m', 'bmig1', { command: 'php artisan migrate', description: 'Database migration', run_in_background: true }));
    c.openSession(710, 'sess-f', { status: 'shell' });
    c.watcher.boot();
    c.notices.push(...c.office.commit().notices);
    const id = '.claude:710';
    expect(c.agent(id)).toMatchObject({ status: 'shell', activity: { text: 'Waiting on shell: Database migration' } });
    expect(c.notices).toEqual([]);
    appendLines(c.transcript('sess-f'), [
      L.shellNotification('message', { taskId: 'bmig1', status: 'failed', summary: 'Background command "Database migration" failed with exit code 1' }, { at: c.now() }),
    ]);
    c.openSession(710, 'sess-f', { status: 'busy' });
    c.poll();
    const a = c.agent(id)!;
    expect(a.activity).toMatchObject({ tool: 'ShellDone', icon: '❌', text: 'Shell failed: Database migration', error: true });
    expect(a.activity!.detail).toBe('Exit code 1 — php artisan migrate');
    expect(c.notices.at(-1)).toMatchObject({ level: 'warn', text: `❌ ${a.name}: shell failed in store — Database migration` });
  });

  it('old CLI: registry "idle" + background Bash without notification = shell; KillShell ends it as interrupted (without notice)', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-o'), backgroundTurn(t0 - 5_000, 'toolu_o', 'bold1'));
    c.openSession(720, 'sess-o', { status: 'idle' });
    c.watcher.boot();
    const id = '.claude:720';
    expect(c.agent(id)).toMatchObject({ status: 'shell', activity: { tool: 'ShellWait' } });
    appendLines(c.transcript('sess-o'), [
      L.prompt('Stop this test', { at: c.now() }),
      L.assistant([L.tool('k1', 'KillShell', { shell_id: 'bold1' })], { at: c.now() + 1_000 }),
      L.result('k1', 'Shell bold1 killed', { at: c.now() + 1_200 }),
    ]);
    c.poll();
    const a = c.agent(id)!;
    expect(a.status).toBe('idle');
    expect(a.shells).toBeUndefined();
    expect(a.recent.find((x) => x.tool === 'ShellDone')).toMatchObject({ icon: '🛑', text: 'Shell interrupted: Run the complete suite', error: true });
    expect(c.notices.filter((n) => n.text.includes('shell'))).toEqual([]);
  });

  it('version that writes "shell": "idle" is the final word (no fallback) and, after 30 s, clears the job that missed its end', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-v'), backgroundTurn(t0 - 5_000, 'toolu_v', 'blost'));
    c.openSession(725, 'sess-v', { status: 'idle', version: '2.1.292' });
    c.watcher.boot();
    const id = '.claude:725';
    expect(c.agent(id)!.status).toBe('idle');
    expect(c.agent(id)!.shells).toHaveLength(1);
    c.advance(31_000);
    c.poll();
    expect(c.agent(id)!.shells).toBeUndefined();
    expect(c.agent(id)!.recent.some((x) => x.tool === 'ShellDone')).toBe(false);
  });

  it('learns the version: an older session writing "shell" starts to count as the reference', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-w1'), backgroundTurn(t0 - 5_000, 'w1', 'bw1'));
    writeLines(c.transcript('sess-w2'), backgroundTurn(t0 - 5_000, 'w2', 'bw2'));
    c.openSession(726, 'sess-w1', { status: 'shell', version: '2.1.250' });
    c.openSession(727, 'sess-w2', { status: 'idle', version: '2.1.260' });
    c.watcher.boot();
    expect(c.agent('.claude:726')!.status).toBe('shell');
    // 2.1.260 >= 2.1.250 (which records "shell"): "idle" with no fallback.
    expect(c.agent('.claude:727')!.status).toBe('idle');
  });

  it('the fallback ignores an old shell (> 12 h) and a shell from before the current process (resumed session)', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-r'), [...backgroundTurn(t0 - 13 * 3_600_000, 'old', 'bold'), ...backgroundTurn(t0 - 120_000, 'previous', 'bprev')]);
    // The process started 60 s ago (fixture): the shell from 2 min ago died with the previous process.
    c.openSession(730, 'sess-r', { status: 'idle', startedAt: t0 - 60_000 });
    c.watcher.boot();
    expect(c.agent('.claude:730')).toMatchObject({ status: 'idle' });
    expect(c.agent('.claude:730')!.shells).toBeUndefined();
  });

  it('foreground: enters shells (background false) and leaves on the result; pending approval hides the command', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-p'), [
      L.prompt('Install everything', { at: t0 - 40_000 }),
      L.assistant([L.tool('fg1', 'Bash', { command: 'npm ci', description: 'Install the dependencies' })], { at: t0 - 30_000, stop: 'tool_use' }),
    ]);
    c.openSession(740, 'sess-p', { status: 'waiting', waitingFor: 'permission' });
    c.watcher.boot();
    const id = '.claude:740';
    expect(c.agent(id)!.shells).toBeUndefined();
    c.advance(5_000);
    c.openSession(740, 'sess-p', { status: 'busy' });
    c.poll();
    // The command's clock starts when the approval ends.
    expect(c.agent(id)!.shells).toEqual([{ id: 'fg1', label: 'Install the dependencies', command: 'npm ci', startedAt: t0, background: false, kind: 'shell' }]);
    c.advance(30_000);
    c.poll();
    // 30 s with nothing new in the transcript: keeps showing the command (not "Thinking…").
    expect(c.agent(id)).toMatchObject({ status: 'working', activity: { kind: 'run', text: 'Installing dependencies' } });
    appendLines(c.transcript('sess-p'), [L.result('fg1', 'added 812 packages', { at: c.now() })]);
    c.poll();
    expect(c.agent(id)!.shells).toBeUndefined();
    // A foreground command does not generate ShellDone.
    expect(c.agent(id)!.recent.some((x) => x.tool === 'ShellDone')).toBe(false);
  });

  it('boot: the end of the file rebuilds what is running and shows what already finished (in the feed, without notice)', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-b'), [
      ...backgroundTurn(t0 - 40_000, 'b1', 'bdone'),
      L.shellNotification('queue', { taskId: 'bdone', toolUseId: 'b1', status: 'completed', summary: 'x (exit code 0)' }, { at: t0 - 20_000 }),
      L.shellNotification('message', { taskId: 'bdone', toolUseId: 'b1', status: 'completed' }, { at: t0 - 20_000 }),
      ...backgroundTurn(t0 - 15_000, 'b2', 'brunning', { command: 'npm run build', description: 'Production build', run_in_background: true }),
    ]);
    c.openSession(750, 'sess-b', { status: 'shell' });
    c.watcher.boot();
    c.notices.push(...c.office.commit().notices);
    const a = c.agent('.claude:750')!;
    expect(a.shells?.map((j) => [j.id, j.label])).toEqual([['brunning', 'Production build']]);
    expect(a.activity?.text).toBe('Waiting on shell: Production build');
    expect(c.office.recentFeed(50).filter((f) => f.activity.tool === 'ShellDone').map((f) => f.activity.text)).toEqual(['Shell finished: Run the complete suite (20s)']);
    expect(c.notices).toEqual([]);
  });

  it('subagent: its background Bash, notified in the transcript of the main agent', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-u'), [L.prompt('Delegating', { at: t0 - 5_000 })]);
    c.openSession(760, 'sess-u', { status: 'busy' });
    c.watcher.boot();
    c.subFile('sess-u', 'sub1', { agentType: 'general-purpose', toolUseId: 'toolu_sub' }, [
      L.prompt('Run the tests', { agentId: 'sub1', at: t0 - 1_000 }),
      L.assistant([L.tool('toolu_sb', 'Bash', { command: 'pytest -q', description: 'Run the tests', run_in_background: true })], { agentId: 'sub1', at: t0 }),
      L.bgLaunched('toolu_sb', 'bsub1', { agentId: 'sub1', at: t0 + 100 }),
    ]);
    c.poll();
    expect(c.agent('sess-u:sub1')!.shells?.map((j) => j.id)).toEqual(['bsub1']);
    expect(c.agent('.claude:760')!.shells).toBeUndefined();
    appendLines(c.transcript('sess-u'), [L.shellNotification('queue', { taskId: 'bsub1', toolUseId: 'toolu_sb', status: 'completed' }, { at: c.now() + 5_000 })]);
    c.poll();
    const sub = c.agent('sess-u:sub1')!;
    expect(sub.shells).toBeUndefined();
    expect(sub.activity).toMatchObject({ tool: 'ShellDone', text: 'Shell finished: Run the tests (5s)' });
  });

  it('/clear and ended session clear the shells', () => {
    const t0 = c.now();
    writeLines(c.transcript('sess-c1'), backgroundTurn(t0 - 5_000));
    c.openSession(770, 'sess-c1', { status: 'shell' });
    c.watcher.boot();
    expect(c.agent('.claude:770')!.shells).toHaveLength(1);
    writeLines(c.transcript('sess-c2'), [L.prompt('Starting over')]);
    c.openSession(770, 'sess-c2', { status: 'idle' });
    c.poll();
    expect(c.agent('.claude:770')!.shells).toBeUndefined();
    writeLines(c.transcript('sess-c3'), backgroundTurn(c.now() - 1_000, 'b3', 'b3x'));
    c.openSession(770, 'sess-c3', { status: 'shell' });
    c.poll();
    expect(c.agent('.claude:770')!.shells).toHaveLength(1);
    c.closeSession(770);
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent('.claude:770')).toMatchObject({ status: 'offline' });
    expect(c.agent('.claude:770')!.shells).toBeUndefined();
  });
});

describe('ClaudeWatcher — shell launched at the start of a transcript larger than the boot window', () => {
  it('enters when the start of the file is read; what finished inside the window does not come back', async () => {
    const c = setup({ tailBytes: 3_000 });
    try {
      const t0 = c.now() - 600_000;
      const lines = [
        L.assistant([L.tool('early', 'Bash', { command: 'npm run e2e', description: 'End-to-end tests', run_in_background: true })], { at: t0 }),
        L.bgLaunched('early', 'bearly', { at: t0 + 100 }),
        L.assistant([L.tool('end', 'Bash', { command: 'npm run build', description: 'Build', run_in_background: true })], { at: t0 + 200 }),
        L.bgLaunched('end', 'bend', { at: t0 + 300 }),
        ...Array.from({ length: 30 }, (_, i) => L.assistant([L.tool(`r${i}`, 'Read', { file_path: `${CWD}/src/file${i}.ts` })], { at: t0 + 1_000 + i * 1_000 })),
        L.shellNotification('queue', { taskId: 'bend', toolUseId: 'end', status: 'completed' }, { at: t0 + 50_000 }),
        L.assistant([L.text('Done.')], { at: t0 + 51_000, stop: 'end_turn' }),
      ];
      writeLines(c.transcript('sess-g'), lines);
      c.openSession(800, 'sess-g', { status: 'shell', startedAt: t0 - 60_000 });
      c.watcher.boot();
      expect(c.agent('.claude:800')!.shells).toBeUndefined();
      await c.watcher.idle();
      c.poll();
      const a = c.agent('.claude:800')!;
      expect(a.shells?.map((j) => [j.id, j.label, j.startedAt])).toEqual([['bearly', 'End-to-end tests', t0 + 100]]);
      expect(a.activity?.text).toBe('Waiting on shell: End-to-end tests');
    } finally {
      c.watcher.stop();
      c.tmp.cleanup();
    }
  });
});
