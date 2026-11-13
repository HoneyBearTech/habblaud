// Integração: eventos do GitHub vindos dos transcripts viram aviso + efeito na sala só ao vivo
// (nunca na carga inicial). Transcripts SINTÉTICOS num config dir temporário.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARTY_MS } from '../../shared/github';
import type { Notice, RoomInfo } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { ClaudeWatcher, encodeCwd } from './watcher';

setQuiet(true);

const CWD = '/projects/store';

function setup() {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  let clock = Date.now();
  const now = () => clock;
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, now, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  const watcher = new ClaudeWatcher({ accounts, office, inDocker: false, now, isAlive: () => true, watch: false });
  const notices: Notice[] = [];
  const transcript = (sid: string) => join(dir, 'projects', encodeCwd(CWD), `${sid}.jsonl`);
  return {
    tmp,
    office,
    watcher,
    notices,
    transcript,
    now,
    advance(ms: number) {
      clock += ms;
    },
    openSession(pid: number, sid: string) {
      writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: CWD, startedAt: clock - 60_000, kind: 'interactive', status: 'busy' }));
    },
    subFile(sid: string, agentId: string, lines: string[]) {
      const base = join(dir, 'projects', encodeCwd(CWD), sid, 'subagents');
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Open the PR' }));
      writeLines(join(base, `agent-${agentId}.jsonl`), lines);
    },
    poll() {
      watcher.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    room(): RoomInfo | undefined {
      return office.commit().snapshot.rooms.find((r) => r.id === CWD);
    },
  };
}

type Ctx = ReturnType<typeof setup>;

const prCreate = (id: string, n: number, at: number) => [
  L.assistant([L.tool(id, 'Bash', { command: 'gh pr create --fill', description: 'Open the PR' })], { at }),
  L.result(id, `https://github.com/acme/loja/pull/${n}`, { at }),
];

describe('GitHub in the office (watcher + office)', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
  });
  afterEach(() => {
    c.watcher.stop();
    c.tmp.cleanup();
  });

  function boot(lines: string[]): string {
    writeLines(c.transcript('sess-a'), [L.prompt('Open the PR', { at: c.now() - 5_000 }), ...lines]);
    c.openSession(100, 'sess-a');
    c.watcher.boot();
    c.notices.push(...c.office.commit().notices);
    return '.claude:100';
  }

  it('initial load: an event already in the transcript goes only to the history (no notice or effect)', () => {
    const id = boot(prCreate('t1', 7, c.now() - 3_000));
    c.poll();
    expect(c.notices.filter((n) => n.text.includes('PR'))).toEqual([]);
    expect(c.room()?.effect).toBeUndefined();
    expect(c.office.detail(id)?.history.some((a) => a.tool === 'GitHub' && a.text === 'Opened PR #7')).toBe(true);
  });

  it('live: merged PR becomes a notice, an activity and a party for ~12 s', () => {
    const id = boot([]);
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('m1', 'Bash', { command: 'gh pr merge 12 --squash --delete-branch' })], { at: c.now() }),
      L.result('m1', 'Updating 1a2b3c4..5d6e7f8\nFast-forward', { at: c.now() }),
    ]);
    c.poll();
    expect(c.notices.map((n) => n.text)).toContainEqual(expect.stringMatching(/^🎉 .+ merged PR #12 in store$/));
    expect(c.office.commit().snapshot.agents.find((a) => a.id === id)?.activity).toMatchObject({ tool: 'GitHub', text: 'Merged PR #12', icon: '🎉' });
    expect(c.room()?.effect).toMatchObject({ kind: 'party', text: 'PR #12 merged!', agentId: id });
    c.advance(PARTY_MS + 100);
    c.poll();
    expect(c.room()?.effect).toBeUndefined();
  });

  it('live: red CI turns on the alarm; green CI turns it off (with a party); CI notice does not repeat', () => {
    const id = boot([]);
    const fail = 'Exit code 1\nX feat/x CI · 55\nTriggered via push about 1 minute ago';
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('w1', 'Bash', { command: 'gh run watch 55 --exit-status' })], { at: c.now() }),
      L.result('w1', fail, { at: c.now(), error: true }),
    ]);
    c.poll();
    expect(c.room()?.effect).toMatchObject({ kind: 'alarm', text: 'CI failed (feat/x)', agentId: id });
    expect(c.notices.filter((n) => n.text === '🚨 CI failed in store (feat/x)')).toHaveLength(1);
    // o mesmo vermelho visto de novo logo depois (gh run view): sem aviso repetido, alarme segue
    c.advance(20_000);
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('v1', 'Bash', { command: 'gh run view 55' })], { at: c.now() }),
      L.result('v1', 'X feat/x CI · 55', { at: c.now() }),
    ]);
    c.poll();
    expect(c.notices.filter((n) => n.text.startsWith('🚨'))).toHaveLength(1);
    c.advance(5 * 60_000);
    c.poll();
    expect(c.room()?.effect?.kind).toBe('alarm');
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('w2', 'Bash', { command: 'gh run watch 56 --exit-status' })], { at: c.now() }),
      L.result('w2', '✓ feat/x CI · 56\nTriggered via push about 2 minutes ago', { at: c.now() }),
    ]);
    c.poll();
    expect(c.room()?.effect).toMatchObject({ kind: 'party', text: 'CI green again!' });
    expect(c.notices.map((n) => n.text)).toContain('✅ CI passed in store (feat/x)');
  });

  it('old line reread (more than 2 min) does not animate or notify', () => {
    boot([]);
    appendLines(c.transcript('sess-a'), prCreate('t9', 9, c.now() - 10 * 60_000));
    c.poll();
    expect(c.notices.filter((n) => n.text.includes('PR #9'))).toEqual([]);
    expect(c.room()?.effect).toBeUndefined();
  });

  it('push only notifies (no effect in the room)', () => {
    boot([]);
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('p1', 'Bash', { command: 'git push origin main' })], { at: c.now() }),
      L.result('p1', 'To github.com:acme/loja.git\n   1a2b3c4..5d6e7f8  main -> main', { at: c.now() }),
    ]);
    c.poll();
    expect(c.notices.map((n) => n.text)).toContainEqual(expect.stringMatching(/^🚀 .+ pushed commits to main in store$/));
    expect(c.room()?.effect).toBeUndefined();
  });

  it('new subagent that opens a PR: party, with it as the one responsible', () => {
    boot([]);
    c.subFile('sess-a', 'abc123', [L.prompt('Open the PR', { at: c.now(), agentId: 'abc123' }), ...prCreate('s1', 31, c.now())]);
    c.poll();
    expect(c.room()?.effect).toMatchObject({ kind: 'party', text: 'PR #31 opened!', agentId: 'sess-a:abc123' });
  });
});
