import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Activity } from '../../shared/types';
import { nameKey } from '../../shared/appearance';
import { hash32 } from '../../shared/hash';
import { NAME_POOL } from '../../shared/names';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { NameStore } from './names';
import { DONE_GRACE_MS, Office, OFFLINE_GRACE_MS, SNAPSHOT_RECENT } from './office';
import { normalizeCwd, roomDisplayNames, SlotAllocator } from './rooms';

setQuiet(true);

describe('SlotAllocator', () => {
  it('lowest free slot, stable while the room exists', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b', 'c'], 0);
    expect(['a', 'b', 'c'].map((id) => s.slotOf(id))).toEqual([0, 1, 2]);
    s.sync(['c', 'a', 'b'], 1);
    expect(s.slotOf('c')).toBe(2);
  });

  it('a freed slot is only used again after the cooldown', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b'], 0);
    s.sync(['b'], 1_000);
    s.sync(['b', 'c'], 2_000);
    expect(s.slotOf('c')).toBe(2);
    s.sync(['b', 'c', 'd'], 31_000);
    expect(s.slotOf('d')).toBe(0);
  });
});

describe('rooms', () => {
  it('normalizes the cwd', () => {
    expect(normalizeCwd('/a//b/')).toBe('/a/b');
    expect(normalizeCwd('/')).toBe('/');
  });

  it('disambiguates repeated basenames with the parent directory', () => {
    const names = roomDisplayNames(
      new Map([
        ['1', '/p/company/applications/app'],
        ['2', '/p/other/app'],
        ['3', '/p/habblaud'],
      ]),
    );
    expect([...names.values()]).toEqual(['applications/app', 'other/app', 'habblaud']);
  });
});

describe('NameStore', () => {
  it('names unique among those present and persisted across restarts', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'data', 'names.json');
      const a = new NameStore(file);
      const used = new Set<string>();
      const first = a.assign('sess-1', used);
      used.add(first.name);
      const second = a.assign('sess-2', used);
      expect(second.name).not.toBe(first.name);
      expect(NAME_POOL.some((p) => p.name === first.name && p.look === first.look)).toBe(true);
      a.flush();
      expect(JSON.parse(readFileSync(file, 'utf8')).names['sess-1'].name).toBe(first.name);

      const b = new NameStore(file);
      b.load();
      expect(b.assign('sess-1', new Set()).name).toBe(first.name);
      // Se o nome persistido colidir com alguém presente, escolhe outro.
      expect(b.assign('sess-1', new Set([first.name])).name).not.toBe(first.name);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('NameStore: character of each room', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  it('saves, reloads, returns copies and reservedNames leaves its own room out', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      const a = new NameStore(file, { now: () => NOW });
      a.setCharacter('/p/api', { name: 'Ana', look: 'f', seed: 7, parts: { hairStyle: 'bob' } });
      a.setCharacter('/p/web', { name: 'Bia', look: 'f', seed: 8 });
      a.flush();
      expect(JSON.parse(readFileSync(file, 'utf8')).rooms['/p/api']).toEqual({ name: 'Ana', look: 'f', seed: 7, parts: { hairStyle: 'bob' }, at: NOW });

      const b = new NameStore(file, { now: () => NOW });
      b.load();
      expect(b.character('/p/api')).toEqual({ name: 'Ana', look: 'f', seed: 7, parts: { hairStyle: 'bob' }, at: NOW });
      expect([...b.reservedNames('/p/api')]).toEqual([['Bia', '/p/web']]);
      expect(b.reservedNames().size).toBe(2);
      b.character('/p/api')!.parts!.hairStyle = 'long';
      expect(b.character('/p/api')!.parts).toEqual({ hairStyle: 'bob' });
      b.clearCharacter('/p/api');
      expect(b.character('/p/api')).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });

  it('names.json that is old or has invalid rooms: the names carry on and only what is no good is discarded', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      const names = { s1: { name: 'Marina', look: 'f', at: NOW } };
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          names,
          rooms: {
            '/ok': { name: ' Ana   Paula ', look: 'f', seed: 1, at: NOW },
            '/color': { name: 'Bia', look: 'f', seed: 1, parts: { skin: 'red' }, at: NOW },
            '/seed': { name: 'Caio', look: 'm', seed: -1, at: NOW },
            '/look': { name: 'Davi', look: 'x', seed: 1, at: NOW },
            '/name': { name: '', look: 'm', seed: 1, at: NOW },
            '/junk': 'x',
          },
        }),
      );
      const s = new NameStore(file, { now: () => NOW });
      s.load();
      expect(s.assign('s1', new Set()).name).toBe('Marina');
      expect(s.character('/ok')?.name).toBe('Ana Paula');
      for (const r of ['/color', '/seed', '/look', '/name', '/junk']) expect(s.character(r)).toBeUndefined();

      for (const rooms of ['x', [1], null]) {
        writeFileSync(file, JSON.stringify({ version: 1, names, rooms }));
        const t = new NameStore(file, { now: () => NOW });
        t.load();
        expect(t.assign('s1', new Set()).name).toBe('Marina');
        expect(t.reservedNames().size).toBe(0);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('owner: claimCharacter changes the owner and it is saved; an owner outside the format is discarded without losing the entry', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      const base = { look: 'f', seed: 1, at: NOW } as const;
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          names: {},
          rooms: {
            '/ok': { ...base, name: 'Ana', owner: 'sess-1' },
            '/limit': { ...base, name: 'Bia', owner: 'x'.repeat(200) },
            '/number': { ...base, name: 'Caio', owner: 5 },
            '/empty': { ...base, name: 'Davi', owner: '' },
            '/long': { ...base, name: 'Eva', owner: 'x'.repeat(201) },
          },
        }),
      );
      const s = new NameStore(file, { now: () => NOW });
      s.load();
      expect(s.character('/ok')).toEqual({ ...base, name: 'Ana', owner: 'sess-1' });
      expect(s.character('/limit')?.owner).toBe('x'.repeat(200));
      for (const [r, name] of [['/number', 'Caio'], ['/empty', 'Davi'], ['/long', 'Eva']]) {
        expect(s.character(r), r).toEqual({ ...base, name });
      }
      s.claimCharacter('/number', 'sess-2');
      s.flush();
      expect(JSON.parse(readFileSync(file, 'utf8')).rooms['/number']).toEqual({ ...base, name: 'Caio', owner: 'sess-2' });
    } finally {
      tmp.cleanup();
    }
  });

  it('a character unused for 60 days goes away on the flush; using it renews the deadline', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      let clock = NOW;
      const s = new NameStore(file, { now: () => clock });
      s.setCharacter('/old', { name: 'Otto', look: 'm', seed: 1 });
      s.setCharacter('/used', { name: 'Nina', look: 'f', seed: 2 });
      clock += 59 * DAY;
      s.claimCharacter('/used', 's1');
      clock += 2 * DAY;
      s.flush();
      expect(s.character('/old')).toBeUndefined();
      const r = new NameStore(file, { now: () => clock });
      r.load();
      expect(r.character('/old')).toBeUndefined();
      expect(r.character('/used')?.name).toBe('Nina');
    } finally {
      tmp.cleanup();
    }
  });
});

function makeOffice(names = new NameStore(null)) {
  let clock = 1_000_000;
  const office = new Office({
    names,
    version: 't',
    startedAt: clock,
    accounts: (s) => [{ id: 'acc', short: 'C', name: 'Account C', color: '#f08a3c', configDir: '/x', sessions: s.get('acc') ?? 0, usageStatus: 'disabled' }],
    sources: () => [],
    accountName: () => 'Account C',
    now: () => clock,
  });
  return { office, names, advance: (ms: number) => (clock += ms), now: () => clock };
}

const act = (id: string, at: number, kind: Activity['kind'] = 'read'): Activity => ({ id, at, kind, icon: '📖', text: 'Reading x' });

describe('Office', () => {
  it('notices with a 10 s dedupe and feed in a batch', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/store/', role: 'Main agent', startedAt: now(), status: 'working' });
    const name = office.get('acc:1')!.name;
    office.addActivity('acc:1', act('a1', now()), true);
    let r = office.commit();
    expect(r.changed).toBe(true);
    expect(r.notices.map((n) => n.text)).toEqual(['🏗️ New room: store', `👋 ${name} arrived in store (Account C)`]);
    expect(r.feed.map((f) => f.id)).toEqual(['a1']);
    expect(r.snapshot.accounts[0].sessions).toBe(1);
    office.setStatus('acc:1', 'waiting', 'approve a permission');
    office.setStatus('acc:1', 'working');
    office.setStatus('acc:1', 'waiting', 'approve a permission');
    r = office.commit();
    expect(r.notices.filter((n) => n.level === 'alert')).toHaveLength(1);
    advance(11_000);
    office.setStatus('acc:1', 'working');
    office.setStatus('acc:1', 'waiting', 'approve a permission');
    expect(office.commit().notices.filter((n) => n.level === 'alert')).toHaveLength(1);
  });

  it('feed brings the account of the agent; snapshot carries only the latest activities (full history in the detail)', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    for (let i = 0; i < 20; i++) {
      advance(1_000);
      office.addActivity('acc:1', act(`a${i}`, now()), true);
    }
    const r = office.commit();
    expect(r.feed.every((f) => f.account === 'acc')).toBe(true);
    const snap = r.snapshot.agents[0];
    expect(snap.recent.map((a) => a.id)).toEqual(Array.from({ length: SNAPSHOT_RECENT }, (_, i) => `a${20 - SNAPSHOT_RECENT + i}`));
    expect(snap.activity?.id).toBe('a19');
    expect(office.detail('acc:1')!.history).toHaveLength(20);
    // Atividades antigas (começo do transcript) entram só no histórico, em ordem e sem duplicar.
    office.mergeHistory('acc:1', [act('old-1', 10), act('old-2', 20), act('a0', now())]);
    const h = office.detail('acc:1')!.history;
    expect(h.slice(0, 3).map((a) => a.id)).toEqual(['old-1', 'old-2', 'a0']);
    expect(h).toHaveLength(22);
    expect(office.commit().feed).toEqual([]);
  });

  it('boot with the agent waiting for you: "Needs you" speech bubble with no notice or feed', () => {
    const { office, now } = makeOffice();
    office.beginBoot();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'waiting', waitingFor: 'answer a question' });
    office.addActivity('acc:1', { ...act('w1', now()), kind: 'delegate', text: 'Orchestrating a workflow' }, true);
    office.endBoot();
    const r = office.commit();
    expect(r.snapshot.agents[0].activity).toMatchObject({ kind: 'wait', text: 'Needs you: answer a question' });
    expect(r.notices).toEqual([]);
    // O feed do boot vai para quem conectar (recentFeed), sem a espera sintetizada.
    expect(office.recentFeed(10).map((f) => f.id)).toEqual(['w1']);
    // Respondeu: volta a mostrar o que fazia.
    office.setStatus('acc:1', 'working');
    expect(office.get('acc:1')!.activity?.id).toBe('w1');
  });

  it('counted boot: several sources booting, the office is only ready when the last one finishes', () => {
    const { office, advance, now } = makeOffice();
    expect(office.isBooting()).toBe(false);
    office.beginBoot(); // fonte A (ex.: Claude Code)
    office.beginBoot(); // fonte B (ex.: Codex, assíncrona)
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', act('a-late', now() - 1_000), true);
    office.endBoot(); // A terminou, B ainda não
    expect(office.isBooting()).toBe(true);
    // Ainda bootando: nada de avisos nem de feed ao vivo; o que chega entra no feed do boot.
    office.addMain({ id: '.codex:t1', provider: 'codex', account: '.codex', sessionId: 't1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'waiting', waitingFor: 'approve a command' });
    office.addActivity('.codex:t1', act('b-early', now() - 5_000), true);
    let r = office.commit();
    expect(r.notices).toEqual([]);
    expect(r.feed).toEqual([]);
    expect(office.recentFeed(10)).toEqual([]);
    office.endBoot(); // B terminou: pronto
    expect(office.isBooting()).toBe(false);
    // O feed das duas fontes sai em ordem cronológica; quem espera ganha o balão (sem aviso).
    expect(office.recentFeed(10).map((f) => f.id)).toEqual(['b-early', 'a-late']);
    r = office.commit();
    expect(r.notices).toEqual([]);
    expect(r.snapshot.agents.find((a) => a.id === '.codex:t1')?.activity).toMatchObject({ kind: 'wait' });
    expect(r.snapshot.agents.find((a) => a.id === '.codex:t1')?.provider).toBe('codex');
    expect(r.snapshot.agents.find((a) => a.id === 'acc:1')).not.toHaveProperty('provider');
    // endBoot a mais é ignorado (não deixa o contador negativo).
    office.endBoot();
    office.beginBoot();
    expect(office.isBooting()).toBe(true);
    office.endBoot();
    expect(office.isBooting()).toBe(false);
    // Depois do boot, avisos voltam.
    advance(1_000);
    office.setStatus('acc:1', 'waiting', 'approve a permission');
    expect(office.commit().notices.length).toBeGreaterThan(0);
  });

  it('subagent inherits the tool of the main agent', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: '.codex:t1', provider: 'codex', account: '.codex', sessionId: 't1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    expect(office.addSub({ id: '.codex:t2', parentId: '.codex:t1', sessionId: 't2', role: 'worker', background: false, startedAt: now() })).toBe(true);
    expect(office.get('.codex:t2')).toMatchObject({ provider: 'codex', account: '.codex', parentId: '.codex:t1' });
    // 'claude' explícito fica ausente (ausente = 'claude').
    office.addMain({ id: 'acc:9', provider: 'claude', account: 'acc', sessionId: 's9', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    expect(office.get('acc:9')).not.toHaveProperty('provider');
  });

  it('rev only changes when something changed', () => {
    const { office } = makeOffice();
    const r1 = office.commit();
    const r2 = office.commit();
    expect(r2.changed).toBe(false);
    expect(r2.snapshot.rev).toBe(r1.snapshot.rev);
  });

  it('"Done" from the transcript replaces the one synthesized by the status change', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', act('a1', now()), true);
    advance(30_000);
    office.setStatus('acc:1', 'idle');
    const synth = office.get('acc:1')!.activity!;
    expect(synth).toMatchObject({ kind: 'done', durationMs: 30_000 });
    office.addActivity('acc:1', { ...act('real', now(), 'done'), text: 'Done in 29s', durationMs: 29_000 }, true);
    const a = office.get('acc:1')!;
    expect(a.activity).toMatchObject({ id: synth.id, text: 'Done in 29s' });
    expect(a.recent.filter((x) => x.kind === 'done')).toHaveLength(1);
  });

  it('busy with the speech bubble still on an old "Done": shows that it is following the subagents (outside the feed)', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', { ...act('end', now(), 'done'), text: 'Done in 3s' }, true);
    office.commit();
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.id).toBe('end');
    advance(20_000);
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Workflow', background: false, startedAt: now() });
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity).toMatchObject({ kind: 'delegate', text: 'Keeping an eye on subagents' });
    expect(office.commit().feed).toEqual([]);
  });

  it('foreground command pending: the "Thinking…" filler does not cover the wait for the command', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', { ...act('end', now(), 'done'), text: 'Done in 3s' }, true);
    office.setShells('acc:1', [{ id: 'fg', label: 'Install the dependencies', startedAt: now(), background: false, kind: 'shell' }]);
    advance(20_000);
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.id).toBe('end');
    office.setShells('acc:1', []);
    expect(office.get('acc:1')!.shells).toBeUndefined();
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.text).toBe('Thinking…');
  });

  it('status shell: "Waiting on shell" speech bubble in place of "Done", notice at most every 10 min; ShellDone with a notice', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/store', role: 'x', startedAt: now(), status: 'working' });
    const name = office.get('acc:1')!.name;
    office.commit();
    const job = { id: 'b1', label: 'Production build', command: 'npm run build', startedAt: now(), background: true, kind: 'shell' as const };
    office.setShells('acc:1', [job, { ...job, id: 'b2', label: 'Migration', startedAt: now() + 5 }]);
    advance(1_000);
    office.setStatus('acc:1', 'shell');
    office.fillShellActivity('acc:1');
    expect(office.get('acc:1')!.activity).toMatchObject({ text: 'Waiting on 2 shells: Production build', detail: 'npm run build', tool: 'ShellWait' });
    // O "Concluiu" do transcript chega depois: o balão continua na espera.
    advance(500);
    office.addActivity('acc:1', { ...act('end', now(), 'done'), text: 'Done in 3s' }, true);
    office.fillShellActivity('acc:1');
    expect(office.get('acc:1')!.activity!.tool).toBe('ShellWait');
    let r = office.commit();
    expect(r.notices.map((n) => n.text)).toEqual([`⏳ ${name} is waiting on the shell in store: Production build`]);
    expect(r.feed.map((f) => f.activity.text)).toEqual(['Waiting on 2 shells: Production build', 'Done in 3s']);
    expect(r.notices.some((n) => n.text.includes('finished'))).toBe(false);
    // Volta a trabalhar e a esperar dentro de 10 min: sem aviso repetido.
    office.setStatus('acc:1', 'working');
    advance(60_000);
    office.setStatus('acc:1', 'shell');
    expect(office.commit().notices).toEqual([]);
    // Fim de um dos shells.
    office.shellDone('acc:1', job, 'ok', now() + 1_000);
    r = office.commit();
    expect(r.snapshot.agents[0].activity).toMatchObject({ tool: 'ShellDone', text: 'Shell finished: Production build (1min 3s)' });
    expect(r.notices.map((n) => [n.level, n.text])).toEqual([['success', `✅ ${name}: shell finished in store — Production build`]]);
    // Releitura não duplica; outro shell no mesmo segundo ainda avisa.
    office.shellDone('acc:1', job, 'ok', now() + 1_000);
    office.shellDone('acc:1', { ...job, id: 'b2', label: 'Migration' }, 'failed', now() + 1_000);
    r = office.commit();
    expect(r.notices.map((n) => [n.level, n.text])).toEqual([['warn', `❌ ${name}: shell failed in store — Migration`]]);
    expect(office.detail('acc:1')!.history.filter((a) => a.tool === 'ShellDone')).toHaveLength(2);
  });

  it('subagent: finishing or closing the session clears the shells', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Explore', background: false, startedAt: now() });
    const job = { id: 'fg', label: 'x', startedAt: now(), background: false, kind: 'shell' as const };
    office.setShells('acc:1', [job]);
    office.setShells('s1:x', [job]);
    office.completeSub('s1:x');
    expect(office.get('s1:x')!.shells).toBeUndefined();
    office.setShells('s1:x', [job]);
    expect(office.get('s1:x')!.shells).toBeUndefined();
    office.closeMain('acc:1');
    expect(office.get('acc:1')!.shells).toBeUndefined();
  });

  it('a finished subagent stays 25 s; an offline main agent stays 20 s and takes the room along', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Explore', title: 'Map', background: false, startedAt: now() });
    office.addSub({ id: 's1:y', parentId: 'acc:1', sessionId: 's1', role: 'Plan', background: true, startedAt: now() });
    office.completeSub('s1:x');
    expect(office.commit().notices.at(-1)?.text).toMatch(/delivered “Map” to/);
    advance(DONE_GRACE_MS + 1);
    office.tick();
    expect(office.has('s1:x')).toBe(false);
    office.closeMain('acc:1');
    expect(office.get('s1:y')!.status).toBe('done');
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    const snap = office.commit().snapshot;
    expect(snap.agents).toEqual([]);
    expect(snap.rooms).toEqual([]);
  });

  it('mixed demo: rooms in the same allocator, its own accounts and on/off', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/real', role: 'x', startedAt: now(), status: 'idle' });
    office.setDemo(true);
    const snap = office.commit().snapshot;
    expect(snap.meta.demo).toBe(true);
    const slots = snap.rooms.map((r) => r.slot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(snap.rooms.find((r) => r.id === '/p/real')!.slot).toBe(0);
    expect(snap.agents.some((a) => a.id.startsWith('demo:'))).toBe(true);
    expect(snap.accounts.map((a) => a.short)).toEqual(['C', 'X', 'Y', 'Z']);
    const demoAgent = snap.agents.find((a) => a.id.startsWith('demo:'))!;
    expect(office.detail(demoAgent.id)?.agent.id).toBe(demoAgent.id);
    office.setDemo(false);
    const off = office.commit().snapshot;
    expect(off.meta.demo).toBe(false);
    expect(off.agents.map((a) => a.id)).toEqual(['acc:1']);
  });

  it('meta.terminal: only with the terminal on', () => {
    expect(makeOffice().office.commit().snapshot.meta.terminal).toBe(false);
    const deps = { names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined };
    expect(new Office({ ...deps, terminal: true }).commit().snapshot.meta.terminal).toBe(true);
    expect(new Office({ ...deps, terminal: false }).commit().snapshot.meta.terminal).toBe(false);
  });

  it('canMessage: only present main agents that the message registry sees connected; meta.messages with the feature on', () => {
    const reach = new Set<string>();
    const deps = { names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined };
    const office = new Office({ ...deps, messages: () => reach });
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'Main agent', startedAt: 0, status: 'idle' });
    office.addMain({ id: 'acc:2', account: 'acc', sessionId: 's2', cwd: '/p/a', role: 'Main agent', startedAt: 0, status: 'working' });
    office.addSub({ id: 's1:sub', parentId: 'acc:1', sessionId: 's1', role: 'Explore', background: false, startedAt: 0 });
    reach.add('acc:1').add('s1:sub');
    office.markDirty();
    const snap = office.commit().snapshot;
    expect(snap.meta.messages).toBe(true);
    expect(snap.agents.filter((a) => a.canMessage).map((a) => a.id)).toEqual(['acc:1']);
    // Quem encerrou a sessão não recebe, mesmo que o registro ainda não tenha notado.
    office.closeMain('acc:1');
    expect(office.commit().snapshot.agents.filter((a) => a.canMessage)).toEqual([]);
    // Sem o registro (recurso desligado): meta.messages falso e os principais do demo também não recebem.
    const off = new Office(deps);
    off.setDemo(true);
    const offSnap = off.commit().snapshot;
    expect(offSnap.meta.messages).toBe(false);
    expect(offSnap.agents.some((a) => a.canMessage)).toBe(false);
    const on = new Office({ ...deps, messages: () => new Set() });
    on.setDemo(true);
    expect(on.commit().snapshot.agents.filter((a) => a.canMessage).every((a) => a.kind === 'main' && a.id.startsWith('demo:'))).toBe(true);
    expect(on.commit().snapshot.agents.some((a) => a.canMessage)).toBe(true);
  });
});

describe('Office: project character', () => {
  const main = (id: string, sessionId: string, cwd: string, now: number) =>
    ({ id, account: 'acc', sessionId, cwd, role: 'Main agent', startedAt: now, status: 'working' }) as const;
  const parts = { skin: '#5a3623', hairStyle: 'bob' } as const;

  it('setCharacter saves for the room, applies right away and notifies; the next session in the room is born with it', () => {
    const { office, names, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api/', now()));
    office.commit();
    const before = office.get('acc:1')!.name;
    expect(office.setCharacter('acc:1', { name: 'Zé Backend', seed: 42, parts })).toEqual({ result: 'ok' });
    expect(office.get('acc:1')).toMatchObject({ name: 'Zé Backend', seed: 42, parts, custom: true });
    expect(names.character('/p/api')).toMatchObject({ name: 'Zé Backend', look: office.get('acc:1')!.look, seed: 42, parts });
    expect(office.commit().notices.map((n) => n.text)).toContain(`✏️ ${before} is now Zé Backend in api`);
    expect(office.setCharacter('acc:1', { name: 'Zé Backend', seed: 43, parts: {} })).toEqual({ result: 'ok' });
    expect(office.get('acc:1')!.parts).toBeUndefined();
    expect(office.commit().notices.map((n) => n.text)).toContain('✏️ Zé Backend got a new look in api');
  });

  it('reopening the session right after closing (the old one still leaving): the character comes back', () => {
    const { office, advance, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.setCharacter('acc:1', { name: 'Zé Backend', seed: 42, parts });
    office.closeMain('acc:1');
    advance(5_000);
    office.addMain(main('acc:2', 's2', '/p/api', now()));
    expect(office.get('acc:2')).toMatchObject({ name: 'Zé Backend', seed: 42, parts, custom: true });
  });

  it('a second session at the same time in the same room falls to the random pick', () => {
    const { office, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.setCharacter('acc:1', { name: 'Zé Backend', seed: 42, parts });
    office.addMain(main('acc:2', 's2', '/p/api', now()));
    const b = office.get('acc:2')!;
    expect(b.name).not.toBe('Zé Backend');
    expect(b.custom).toBeUndefined();
    expect(b.parts).toBeUndefined();
    expect(b.seed).toBe(hash32('acc:2'));
  });

  it('a chosen name stays reserved: the random pick does not give it to another session (not even as its saved name, nor in another letter case)', () => {
    const { office, names, advance, now } = makeOffice();
    names.remember('s9', { name: 'Ana', look: 'f' });
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    expect(office.setCharacter('acc:1', { name: 'ana', seed: 1, parts: {} })).toEqual({ result: 'ok' });
    office.closeMain('acc:1');
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    office.addMain(main('acc:9', 's9', '/p/web', now()));
    expect(nameKey(office.get('acc:9')!.name)).not.toBe('ana');
  });

  it('conflicts: someone in the office (case-insensitive), a character from another room and the demo', () => {
    const { office, advance, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.addMain(main('acc:2', 's2', '/p/web', now()));
    const other = office.get('acc:2')!.name;
    expect(office.setCharacter('acc:1', { name: other.toUpperCase(), seed: 1, parts: {} })).toEqual({
      result: 'conflict',
      message: `${other} is already in the office, in web`,
    });
    expect(office.setCharacter('acc:2', { name: 'Zé', seed: 1, parts: {} })).toEqual({ result: 'ok' });
    office.closeMain('acc:2');
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    expect(office.setCharacter('acc:1', { name: 'zé', seed: 1, parts: {} })).toEqual({ result: 'conflict', message: "Zé is already web's character" });
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:'))!;
    expect(office.setCharacter('acc:1', { name: demo.name, seed: 1, parts: {} })).toMatchObject({ result: 'conflict' });
  });

  it('conflict also between Unicode forms: "Júlia" in NFD is the same as the NFC one reserved for another room', () => {
    const { office, advance, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.addMain(main('acc:2', 's2', '/p/web', now()));
    expect(office.setCharacter('acc:2', { name: 'Júlia', seed: 1, parts: {} })).toEqual({ result: 'ok' });
    office.closeMain('acc:2');
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    expect(office.setCharacter('acc:1', { name: 'Júlia', seed: 1, parts: {} })).toEqual({
      result: 'conflict',
      message: "Júlia is already web's character",
    });
  });

  it('subagent, demo, someone who is leaving and unknown id: not-found', () => {
    const { office, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.addSub({ id: 's1:sub', parentId: 'acc:1', sessionId: 's1', role: 'Explore', background: false, startedAt: now() });
    office.setDemo(true);
    const demo = office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:'))!;
    for (const id of ['s1:sub', demo.id, 'does-not-exist']) {
      expect(office.setCharacter(id, { name: 'Zé', seed: 1, parts: {} })).toEqual({ result: 'not-found' });
      expect(office.resetCharacter(id)).toBe('not-found');
    }
    office.closeMain('acc:1');
    expect(office.setCharacter('acc:1', { name: 'Zé', seed: 1, parts: {} })).toEqual({ result: 'not-found' });
  });

  it('resetCharacter goes back to the randomly picked name of the session and to the seed of the id; the room loses the character', () => {
    const { office, names, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    const drawn = { name: office.get('acc:1')!.name, look: office.get('acc:1')!.look, seed: office.get('acc:1')!.seed };
    office.setCharacter('acc:1', { name: 'Zé', seed: 9, parts });
    expect(office.resetCharacter('acc:1')).toBe('ok');
    const a = office.get('acc:1')!;
    expect(a).toMatchObject({ ...drawn, seed: hash32('acc:1') });
    expect(a.parts).toBeUndefined();
    expect(a.custom).toBeUndefined();
    expect(names.character('/p/api')).toBeUndefined();
  });

  it('/clear keeps the character and does not save the chosen name as the name of the new session', () => {
    const { office, names, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.setCharacter('acc:1', { name: 'Zé', seed: 9, parts });
    office.switchSession('acc:1', 's2');
    expect(office.get('acc:1')).toMatchObject({ name: 'Zé', seed: 9, parts, custom: true, sessionId: 's2' });
    expect(names.get('s2')).toBeUndefined();
  });

  describe('Habblaud restart (names.json in a file)', () => {
    /** Grava o names.json e sobe um NameStore e um Office novos lendo o mesmo arquivo. */
    const restart = (before: NameStore, file: string) => {
      before.flush();
      const names = new NameStore(file);
      names.load();
      return makeOffice(names);
    };

    /** A (s1) edita o personagem da sala; B (s2), aberta ao mesmo tempo, fica com o nome sorteado. */
    const ownerAndOther = (file: string) => {
      const env = makeOffice(new NameStore(file));
      env.office.addMain(main('acc:1', 's1', '/p/api', env.now()));
      env.office.setCharacter('acc:1', { name: 'Zé Backend', seed: 42, parts });
      env.office.addMain(main('acc:2', 's2', '/p/api', env.now()));
      return { ...env, drawn: env.office.get('acc:2')!.name };
    };

    it('the owner and another session open, and the other one arrives first: each comes back with its own', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const { names, drawn } = ownerAndOther(file);
        const after = restart(names, file);
        after.office.addMain(main('acc:2', 's2', '/p/api', after.now()));
        after.office.addMain(main('acc:1', 's1', '/p/api', after.now()));
        expect(after.office.get('acc:2')).toMatchObject({ name: drawn, seed: hash32('acc:2') });
        expect(after.office.get('acc:2')!.custom).toBeUndefined();
        expect(after.office.get('acc:1')).toMatchObject({ name: 'Zé Backend', seed: 42, parts, custom: true });
        expect(after.names.character('/p/api')?.owner).toBe('s1');
        after.names.flush();
      } finally {
        tmp.cleanup();
      }
    });

    it('the owner left and only the other one remains: it does not change character in the middle of the session', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const { office, names, advance, drawn } = ownerAndOther(file);
        office.closeMain('acc:1');
        advance(OFFLINE_GRACE_MS + 1);
        office.tick();
        const after = restart(names, file);
        after.office.addMain(main('acc:2', 's2', '/p/api', after.now()));
        expect(after.office.get('acc:2')).toMatchObject({ name: drawn, seed: hash32('acc:2') });
        expect(after.office.get('acc:2')!.custom).toBeUndefined();
        expect(after.names.character('/p/api')?.owner).toBe('s1');
        after.names.flush();
      } finally {
        tmp.cleanup();
      }
    });

    it('new session (with no saved name) in an empty room: gets the character and becomes the owner', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const { office, names, advance } = ownerAndOther(file);
        for (const id of ['acc:1', 'acc:2']) office.closeMain(id);
        advance(OFFLINE_GRACE_MS + 1);
        office.tick();
        const after = restart(names, file);
        after.office.addMain(main('acc:3', 's3', '/p/api', after.now()));
        expect(after.office.get('acc:3')).toMatchObject({ name: 'Zé Backend', seed: 42, parts, custom: true });
        expect(after.names.character('/p/api')?.owner).toBe('s3');
        after.names.flush();
      } finally {
        tmp.cleanup();
      }
    });

    it('old entry, with no owner: it goes to whoever arrives first, who becomes the owner', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const at = Date.now();
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            names: { s2: { name: 'Marina', look: 'f', at } },
            rooms: { '/p/api': { name: 'Zé Backend', look: 'm', seed: 42, at } },
          }),
        );
        const names = new NameStore(file);
        names.load();
        const { office, now } = makeOffice(names);
        office.addMain(main('acc:2', 's2', '/p/api', now()));
        expect(office.get('acc:2')).toMatchObject({ name: 'Zé Backend', seed: 42, custom: true });
        expect(names.character('/p/api')?.owner).toBe('s2');
        names.flush();
      } finally {
        tmp.cleanup();
      }
    });

    it('/clear by the owner: the character passes to the new session, which gets it after the restart', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const { office, names, drawn } = ownerAndOther(file);
        office.switchSession('acc:1', 's1b');
        expect(names.character('/p/api')?.owner).toBe('s1b');
        const after = restart(names, file);
        after.office.addMain(main('acc:2', 's2', '/p/api', after.now()));
        after.office.addMain(main('acc:1', 's1b', '/p/api', after.now()));
        expect(after.office.get('acc:2')!.name).toBe(drawn);
        expect(after.office.get('acc:1')).toMatchObject({ name: 'Zé Backend', custom: true });
        after.names.flush();
      } finally {
        tmp.cleanup();
      }
    });

    it('one got the character on arriving and another session in the room saves another: after the restart each comes back as who it was', () => {
      const tmp = tempDir();
      try {
        const file = join(tmp.dir, 'names.json');
        const { office, names, advance, now } = makeOffice(new NameStore(file));
        office.addMain(main('acc:0', 's0', '/p/api', now()));
        office.setCharacter('acc:0', { name: 'Zé', seed: 9, parts });
        office.closeMain('acc:0');
        advance(OFFLINE_GRACE_MS + 1);
        office.tick();
        office.addMain(main('acc:1', 's1', '/p/api', now()));
        expect(office.get('acc:1')).toMatchObject({ name: 'Zé', custom: true });
        office.addMain(main('acc:2', 's2', '/p/api', now()));
        expect(office.setCharacter('acc:2', { name: 'Bia', seed: 3, parts: {} })).toEqual({ result: 'ok' });
        expect(office.get('acc:1')!.name).toBe('Zé');
        expect(office.get('acc:1')!.custom).toBeUndefined();
        const after = restart(names, file);
        after.office.addMain(main('acc:1', 's1', '/p/api', after.now()));
        after.office.addMain(main('acc:2', 's2', '/p/api', after.now()));
        expect(after.office.get('acc:1')!.name).toBe('Zé');
        expect(after.office.get('acc:2')).toMatchObject({ name: 'Bia', custom: true });
        after.names.flush();
      } finally {
        tmp.cleanup();
      }
    });
  });

  it('"Back to random" by someone who is not the owner does not delete the character that another session in the room saved', () => {
    const { office, names, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.setCharacter('acc:1', { name: 'Zé', seed: 9, parts });
    office.addMain(main('acc:2', 's2', '/p/api', now()));
    office.setCharacter('acc:2', { name: 'Bia', seed: 3, parts: {} });
    expect(office.resetCharacter('acc:1')).toBe('ok');
    expect(names.character('/p/api')).toMatchObject({ name: 'Bia', owner: 's2' });
    expect(office.get('acc:2')).toMatchObject({ name: 'Bia', custom: true });
  });

  it('the name of someone who just left (and may reopen the session) cannot be chosen', () => {
    const { office, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.addMain(main('acc:2', 's2', '/p/web', now()));
    const leaving = office.get('acc:2')!.name;
    office.closeMain('acc:2');
    expect(office.setCharacter('acc:1', { name: leaving, seed: 1, parts: {} })).toMatchObject({ result: 'conflict' });
  });

  it('/clear by someone who is not the owner (another agent in the room saved later) does not touch the owner', () => {
    const { office, names, now } = makeOffice();
    office.addMain(main('acc:1', 's1', '/p/api', now()));
    office.setCharacter('acc:1', { name: 'Zé', seed: 9, parts });
    office.addMain(main('acc:2', 's2', '/p/api', now()));
    office.setCharacter('acc:2', { name: 'Bia', seed: 3, parts: {} });
    expect(names.character('/p/api')?.owner).toBe('s2');
    office.switchSession('acc:1', 's1b');
    expect(names.character('/p/api')?.owner).toBe('s2');
    office.switchSession('acc:2', 's2b');
    expect(names.character('/p/api')?.owner).toBe('s2b');
  });
});
