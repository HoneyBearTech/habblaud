// Histórico do terminal: listagem das sessões recentes (pastas temporárias com JSONLs sintéticos), ordem,
// janela de 7 dias, limite, cache por mtime, aberta vs. encerrada, leitura só do começo e do fim, e a
// validação de conta/id/caminho de resolve().
import { appendFileSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { L, symlinkOrSkip, tempDir, writeLines } from '../test/fixtures';
import { HEAD_BYTES, HISTORY_MAX_AGE_MS, isSessionId, openMainAgent, SessionHistory, TAIL_BYTES, type HistoryAccount } from './history';
import { encodeCwd } from './watcher';

setQuiet(true);

const NOW = Date.UTC(2026, 9, 8, 15, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Linha de conversa com o cwd do projeto (como o Claude Code grava). */
const withCwd = (line: string, cwd: string) => JSON.stringify({ ...JSON.parse(line), cwd });

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(): { root: string; acc: (name: string) => HistoryAccount } {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  return { root: tmp.dir, acc: (name) => ({ id: name, dir: join(tmp.dir, name) }) };
}

/** Escreve o transcript <conta>/projects/<cwd codificado>/<sessionId>.jsonl com o mtime dado. */
function session(acc: HistoryAccount, cwd: string, id: string, lines: string[], mtime: number): string {
  const path = join(acc.dir, 'projects', encodeCwd(cwd), `${id}.jsonl`);
  writeLines(path, lines);
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

function history(accounts: HistoryAccount[], extra: Partial<ConstructorParameters<typeof SessionHistory>[0]> = {}): SessionHistory {
  return new SessionHistory({ accounts: () => accounts, openAgentOf: () => undefined, now: () => NOW, ...extra });
}

describe('SessionHistory.list', () => {
  it('sessions from the last 7 days, from the most recent to the oldest, with project, title and times', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const d = acc('.claude-b');
    session(c, '/projects/store', sid(1), [withCwd(L.prompt('Fix the cart', { at: NOW - 3 * HOUR }), '/projects/store'), L.raw('ai-title', { aiTitle: 'Shopping cart' })], NOW - 3 * HOUR);
    session(d, '/projects/api', sid(2), [withCwd(L.prompt('Create the login route', { at: NOW - 2 * HOUR }), '/projects/api'), withCwd(L.assistant([L.text('Done.')], { at: NOW - HOUR }), '/projects/api')], NOW - HOUR);
    // Fora da janela, nome que não é UUID e transcript de subagente: nada disso entra.
    session(c, '/projects/old', sid(3), [L.prompt('old', { at: NOW - 8 * 24 * HOUR })], NOW - HISTORY_MAX_AGE_MS - HOUR);
    session(c, '/projects/store', 'notes', [L.prompt('x', { at: NOW - HOUR })], NOW - HOUR);
    writeLines(join(c.dir, 'projects', encodeCwd('/projects/store'), sid(1), 'subagents', 'agent-a1.jsonl'), [L.prompt('sub', { at: NOW - MIN })]);

    const list = await history([c, d]).list();
    expect(list.map((s) => s.sessionId)).toEqual([sid(2), sid(1)]);
    expect(list[0]).toMatchObject({
      account: '.claude-b',
      project: '/projects/api',
      projectDir: encodeCwd('/projects/api'),
      // Sem título no transcript: o primeiro prompt.
      title: 'Create the login route',
      firstAt: NOW - 2 * HOUR,
      lastAt: NOW - HOUR,
      open: false,
    });
    expect(list[0].size).toBeGreaterThan(0);
    expect(list[0].agentId).toBeUndefined();
    expect(list[1]).toMatchObject({ account: '.claude', title: 'Shopping cart', project: '/projects/store' });
  });

  it('title: custom-title.json of the session; with no time at the end, lastAt = mtime', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const path = session(c, '/p', sid(1), [L.raw('ai-title', { aiTitle: 'Automatic' })], NOW - 2 * HOUR);
    // Uma linha com horário no começo (senão a sessão nem entra) e nada com horário no fim do arquivo.
    writeFileSync(path, `${L.prompt('hi', { at: NOW - 5 * HOUR })}\n${L.raw('ai-title', { aiTitle: 'Automatic' })}\n`);
    utimesSync(path, (NOW - 2 * HOUR) / 1000, (NOW - 2 * HOUR) / 1000);
    mkdirSync(path.replace(/\.jsonl$/, ''), { recursive: true });
    writeFileSync(join(path.replace(/\.jsonl$/, ''), 'custom-title.json'), JSON.stringify({ customTitle: 'Renamed' }));
    const [s] = await history([c]).list();
    expect(s.title).toBe('Renamed');
    expect(s.lastAt).toBe(NOW - 5 * HOUR);
    expect(s.firstAt).toBe(NOW - 5 * HOUR);
    // O cwd que as linhas sintéticas trazem.
    expect(s.project).toBe('/projects/demo');
  });

  it('limit: only the N last modified', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    for (let i = 1; i <= 5; i++) session(c, `/p${i}`, sid(i), [L.prompt(`p${i}`, { at: NOW - i * HOUR })], NOW - i * HOUR);
    const list = await history([c], { limit: 3 }).list();
    expect(list.map((s) => s.title)).toEqual(['p1', 'p2', 'p3']);
  });

  it('cache by mtime: the file that did not change is not reread; the one that changed is', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const a = session(c, '/a', sid(1), [L.prompt('first', { at: NOW - 2 * HOUR })], NOW - 2 * HOUR);
    session(c, '/b', sid(2), [L.prompt('second', { at: NOW - 3 * HOUR })], NOW - 3 * HOUR);
    const h = history([c]);
    await h.list();
    expect(h.reads).toBe(2);
    await h.list();
    expect(h.reads).toBe(2);
    appendFileSync(a, `${L.raw('ai-title', { aiTitle: 'New title' })}\n`);
    utimesSync(a, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
    const list = await h.list();
    expect(h.reads).toBe(3);
    expect(list[0]).toMatchObject({ sessionId: sid(1), title: 'New title' });
  });

  it('open (with the office agent) vs. ended; without a conversation it only gets in if it is open', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    session(c, '/a', sid(1), [L.prompt('open', { at: NOW - MIN })], NOW - MIN);
    session(c, '/b', sid(2), [L.prompt('ended', { at: NOW - HOUR })], NOW - HOUR);
    // Só metadados, sem horário: a sessão recém-aberta entra; a encerrada sem conversa, não.
    session(c, '/c', sid(3), [L.raw('permission-mode', { permissionMode: 'default' })], NOW - 2 * MIN);
    session(c, '/d', sid(4), [L.raw('permission-mode', { permissionMode: 'default' })], NOW - 3 * MIN);
    const open = new Map([[sid(1), '.claude:100'], [sid(3), '.claude:300']]);
    const list = await history([c], { openAgentOf: (account, id) => (account === '.claude' ? open.get(id) : undefined) }).list();
    expect(list.map((s) => [s.sessionId, s.open, s.agentId])).toEqual([
      [sid(1), true, '.claude:100'],
      [sid(3), true, '.claude:300'],
      [sid(2), false, undefined],
    ]);
  });

  it('large file: reads only the beginning and the end (the title in the middle is not seen)', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const filler = (n: number) => Array.from({ length: n }, (_, i) => L.assistant([L.text(`${'x'.repeat(900)} ${i}`)], { at: NOW - 3 * HOUR + i }));
    const lines = [
      withCwd(L.prompt('Start', { at: NOW - 4 * HOUR }), '/projects/big'),
      ...filler(200),
      L.raw('custom-title', { customTitle: 'From the middle' }),
      ...filler(200),
      L.raw('ai-title', { aiTitle: 'From the end' }),
      L.assistant([L.text('bye')], { at: NOW - HOUR }),
    ];
    session(c, '/projects/big', sid(1), lines, NOW - HOUR);
    const [s] = await history([c]).list();
    expect(s.size).toBeGreaterThan(HEAD_BYTES + TAIL_BYTES + 100_000);
    expect(s).toMatchObject({ project: '/projects/big', title: 'From the end', firstAt: NOW - 4 * HOUR, lastAt: NOW - HOUR });
  });

  it('title before a huge result at the end: searches a larger stretch', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const lines = [
      L.prompt('Start', { at: NOW - 4 * HOUR }),
      ...Array.from({ length: 100 }, (_, i) => L.assistant([L.text(`${'y'.repeat(900)} ${i}`)], { at: NOW - 3 * HOUR + i })),
      L.raw('ai-title', { aiTitle: 'Before the result' }),
      L.result('t1', 'z'.repeat(TAIL_BYTES + 10_000), { at: NOW - HOUR }),
    ];
    session(c, '/p', sid(1), lines, NOW - HOUR);
    const [s] = await history([c]).list();
    expect(s.title).toBe('Before the result');
  });

  it('account without projects/ or unreadable folder: empty list, no error', async () => {
    const { acc } = setup();
    expect(await history([acc('.claude-nothing')]).list()).toEqual([]);
  });
});

describe('SessionHistory.resolve', () => {
  it('known account + UUID id + file inside projects/', () => {
    const { root, acc } = setup();
    const c = acc('.claude');
    const path = session(c, '/projects/store', sid(1), [L.prompt('hi')], NOW);
    const h = history([c]);
    const ok = h.resolve('.claude', sid(1));
    expect('path' in ok && ok.path.endsWith(join(encodeCwd('/projects/store'), `${sid(1)}.jsonl`))).toBe(true);
    expect(path.endsWith(`${sid(1)}.jsonl`)).toBe(true);

    for (const bad of ['../../etc/passwd', '..', `${sid(1)}/../${sid(1)}`, `${sid(1)}.jsonl`, 'x', '', `${sid(1)} `]) {
      expect(h.resolve('.claude', bad)).toEqual({ status: 400, error: 'invalid session id' });
    }
    for (const account of ['.claude/..', '..', '.claude-other', '', join(root, '.claude')]) {
      expect(h.resolve(account, sid(1))).toEqual({ status: 404, error: 'unknown account' });
    }
    expect(h.resolve('.claude', sid(9))).toEqual({ status: 404, error: 'session not found' });
  });

  it('link inside projects/ pointing outside is not accepted', ({ skip }) => {
    const { root, acc } = setup();
    const c = acc('.claude');
    session(c, '/p', sid(1), [L.prompt('hi')], NOW);
    // Pasta de projeto que é um link para fora (junction: no Windows não pede privilégio).
    mkdirSync(join(root, 'other'), { recursive: true });
    writeFileSync(join(root, 'other', `${sid(3)}.jsonl`), `${L.prompt('secret')}\n`);
    symlinkSync(join(root, 'other'), join(c.dir, 'projects', 'link'), 'junction');
    const h = history([c]);
    expect(h.resolve('.claude', sid(3))).toEqual({ status: 404, error: 'session not found' });
    expect('path' in h.resolve('.claude', sid(1))).toBe(true);
    // Arquivo que é um link para fora também não.
    const outside = join(root, 'outside.jsonl');
    writeFileSync(outside, `${L.prompt('secret')}\n`);
    symlinkOrSkip(skip, outside, join(c.dir, 'projects', encodeCwd('/p'), `${sid(2)}.jsonl`));
    expect(h.resolve('.claude', sid(2))).toEqual({ status: 404, error: 'session not found' });
  });

  it('account without projects/: 404', () => {
    const { acc } = setup();
    expect(history([acc('.claude')]).resolve('.claude', sid(1))).toEqual({ status: 404, error: 'session not found' });
  });
});

describe('utilities', () => {
  it('isSessionId: only the UUID format', () => {
    expect(isSessionId(sid(1))).toBe(true);
    expect(isSessionId('7F3C2A10-0B1D-4E2F-9A8B-0123456789AB')).toBe(true);
    for (const v of ['', 'abc', `${sid(1)}x`, `../${sid(1)}`, sid(1).replace(/-/g, '')]) expect(isSessionId(v)).toBe(false);
  });

  it('openMainAgent: main agent of the account and of the session, still in the office', () => {
    const a = (p: Partial<AgentInfo>) => ({ id: 'x', kind: 'main', account: '.claude', sessionId: 's1', status: 'idle', ...p }) as AgentInfo;
    const agents = [a({ id: '.claude:1' }), a({ id: 's1:sub', kind: 'sub' }), a({ id: '.claude:2', sessionId: 's2', status: 'offline' }), a({ id: '.b:3', account: '.b', sessionId: 's3' })];
    expect(openMainAgent(agents, '.claude', 's1')).toBe('.claude:1');
    expect(openMainAgent(agents, '.claude', 's2')).toBeUndefined();
    expect(openMainAgent(agents, '.claude', 's3')).toBeUndefined();
    expect(openMainAgent(agents, '.b', 's3')).toBe('.b:3');
  });
});
