// The interior of a world building as an office: rooms per floor, agents with `world:` ids, fictional accounts,
// discreet mode and off, patches and the inverted canary test (only what came from the world goes out, translated).
import { afterEach, describe, expect, it } from 'vitest';
import { hash32 } from '../hash';
import { setLocale, tr } from '../i18n';
import type { OfficeSnapshot } from '../types';
import { floorLabel } from './floor-labels';
import {
  applyBuildingPatch,
  checkBuildingRev,
  hidesAgents,
  isWorldId,
  officeFromBuilding,
  WORLD_TOOL_ACCOUNTS,
  worldId,
} from './office-from-world';
import type { WorldAgent, WorldBuildingDetail } from './protocol';
import { sampleBuildingDetail } from './visit-sample';

const T0 = 1_790_000_000_000;
const OPTS = { version: '0.12.0' };

afterEach(() => setLocale('en'));

const byName = (snap: OfficeSnapshot, name: string) => snap.agents.find((a) => a.name === name)!;

function newAgent(id: string, status: WorldAgent['status'], extra: Partial<WorldAgent> = {}): WorldAgent {
  return { id, kind: 'main', provider: 'claude', status, look: 'f', name: 'Camila', parts: { skin: '#f6cfb0' }, ...extra };
}

describe('officeFromBuilding', () => {
  it('one room per floor, in the order received, with the translated label and no path', () => {
    const d = sampleBuildingDetail();
    const s = officeFromBuilding(d, T0, OPTS);
    expect(s.rooms).toEqual([
      { id: 'f_0a1b2c3d4e', name: 'Project Ipê', path: '', slot: 0, seed: hash32('f_0a1b2c3d4e'), createdAt: T0 },
      { id: 'f_1b2c3d4e5f', name: 'Project Jade', path: '', slot: 1, seed: hash32('f_1b2c3d4e5f'), createdAt: T0 },
      { id: 'f_2c3d4e5f60', name: 'Project Aurora', path: '', slot: 2, seed: hash32('f_2c3d4e5f60'), createdAt: T0 },
    ]);
    expect(s.rev).toBe(1);
    expect(s.serverTime).toBe(T0);
  });

  it('one agent per world agent: id `world:`, no activity or tasks, zeroed statistics and times = now', () => {
    const d = sampleBuildingDetail();
    const s = officeFromBuilding(d, T0, OPTS);
    expect(s.agents).toHaveLength(6);
    const src = d.floors[0].agents[0];
    expect(byName(s, 'Marina')).toEqual({
      id: 'world:a_1f2e3d4c',
      kind: 'main',
      provider: 'claude',
      roomId: 'f_0a1b2c3d4e',
      name: 'Marina',
      look: 'f',
      role: 'Main agent',
      sessionId: 'world:a_1f2e3d4c',
      account: 'world:claude',
      status: 'working',
      recent: [],
      tasks: [],
      startedAt: T0,
      lastEventAt: T0,
      statusSince: T0,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32('a_1f2e3d4c'),
      parts: src.parts,
    });
    // subagent with the parent in the building: prefixed parentId; the orphan goes without
    expect(byName(s, 'Rafael')).toMatchObject({ kind: 'sub', role: 'Subagent', parentId: 'world:a_1f2e3d4c', roomId: 'f_0a1b2c3d4e' });
    const orphan = byName(s, 'Thiago');
    expect(orphan).toMatchObject({ kind: 'sub', provider: 'codex', status: 'shell', account: 'world:codex' });
    expect(orphan.parentId).toBeUndefined();
    for (const a of s.agents) {
      expect(isWorldId(a.id)).toBe(true);
      expect(a.sessionId).toBe(a.id);
      expect(a.activity).toBeUndefined();
      expect(a.shells).toBeUndefined();
      expect(a.title).toBeUndefined();
      expect(a.model).toBeUndefined();
    }
  });

  it('fictitious accounts, one per tool, without email, plan or usage; minimal meta, without terminal or messages', () => {
    const s = officeFromBuilding(sampleBuildingDetail(), T0, OPTS);
    expect(s.accounts).toEqual([
      { id: 'world:claude', provider: 'claude', short: 'C', name: 'Claude Code', color: WORLD_TOOL_ACCOUNTS.claude.color, configDir: '', sessions: 2, usageStatus: 'disabled' },
      { id: 'world:codex', provider: 'codex', short: 'X', name: 'Codex', color: WORLD_TOOL_ACCOUNTS.codex.color, configDir: '', sessions: 2, usageStatus: 'disabled' },
    ]);
    expect(s.meta).toEqual({
      demo: false,
      sources: [],
      startedAt: T0,
      version: '0.12.0',
      terminal: false,
      messages: false,
      world: { enabled: true, configured: true, state: 'approved' },
    });
    expect(s.ptys).toBeUndefined();
  });

  it('labels and roles in the current language; unknown floor id becomes "Project"', () => {
    setLocale('pt-BR');
    const d = sampleBuildingDetail();
    d.floors[2].label = 'new-name';
    const s = officeFromBuilding(d, T0, OPTS);
    expect(s.rooms.map((r) => r.name)).toEqual(['Projeto Ipê', 'Projeto Jade', 'Projeto']);
    expect(byName(s, 'Marina').role).toBe('Agente principal');
    expect(byName(s, 'Rafael').role).toBe('Subagente');
  });

  it('discreet mode and building off: the rooms stay, with nobody, even with agents in the packet by mistake', () => {
    for (const mode of ['discreet', 'away'] as const) {
      const d = sampleBuildingDetail(mode);
      expect(hidesAgents(d.building)).toBe(true);
      const s = officeFromBuilding(d, T0, OPTS);
      expect(s.rooms.map((r) => r.id)).toEqual(['f_0a1b2c3d4e', 'f_1b2c3d4e5f', 'f_2c3d4e5f60']);
      expect(s.agents).toEqual([]);
      // the server sent agents anyway: they do not show
      const leaky = { ...d, floors: sampleBuildingDetail().floors };
      expect(officeFromBuilding(leaky, T0, OPTS).agents).toEqual([]);
      expect(officeFromBuilding(leaky, T0, OPTS).accounts.every((a) => a.sessions === 0)).toBe(true);
    }
    expect(hidesAgents(sampleBuildingDetail().building)).toBe(false);
  });

  it('defensive: parent that is not in the building, repeated ids, new status/tool/look, invalid name and parts', () => {
    const d = sampleBuildingDetail();
    d.floors[0].agents.push(
      newAgent('a_99999999', 'working', { kind: 'sub', parentId: 'a_00000000' }), // parent outside the building
      newAgent('a_1f2e3d4c', 'idle', { name: 'Ana' }), // repeated id: the first one stays
      { ...newAgent('a_88888888', 'working'), status: 'dancing', provider: 'gemini', look: 'x', kind: 'boss', name: '‮evil' } as unknown as WorldAgent,
      newAgent('a_77777777', 'idle', { parts: { skin: 'red', hair: '#ABCDEF', hairStyle: 'moicano', topStyle: 'polo', novo: 'x' } as never }),
    );
    d.floors.push({ ...d.floors[1], agents: [] }); // repeated floor
    const s = officeFromBuilding(d, T0, OPTS);
    expect(s.rooms).toHaveLength(3);
    expect(s.agents.filter((a) => a.id === 'world:a_1f2e3d4c')).toHaveLength(1);
    expect(byName(s, 'Marina').status).toBe('working');
    expect(s.agents.find((a) => a.id === 'world:a_99999999')!.parentId).toBeUndefined();
    expect(s.agents.find((a) => a.id === 'world:a_88888888')).toMatchObject({ status: 'idle', provider: 'claude', look: 'm', kind: 'main', name: 'Agent', account: 'world:claude' });
    // a malformed part drops on its own; the others stay (color in lowercase)
    expect(s.agents.find((a) => a.id === 'world:a_77777777')!.parts).toEqual({ hair: '#abcdef', topStyle: 'polo' });
  });

  it('packet limits: at most 64 floors and 64 agents per floor', () => {
    const d = sampleBuildingDetail();
    d.floors = Array.from({ length: 70 }, (_, i) => ({
      id: `f_${String(i).padStart(10, '0')}`,
      label: 'ipe',
      agents: i === 0 ? Array.from({ length: 80 }, (_, j) => newAgent(`a_${String(j).padStart(8, '0')}`, 'idle')) : [],
    }));
    const s = officeFromBuilding(d, T0, OPTS);
    expect(s.rooms).toHaveLength(64);
    expect(s.agents).toHaveLength(64);
  });

  it('worldId/isWorldId', () => {
    expect(worldId('a_1')).toBe('world:a_1');
    expect(isWorldId('world:a_1')).toBe(true);
    expect(isWorldId('.claude:123')).toBe(false);
  });
});

describe('applyBuildingPatch', () => {
  const T1 = T0 + 60_000;

  it('swaps agents: whoever changed status gets a new statusSince; whoever did not keeps the one from before', () => {
    const base = officeFromBuilding(sampleBuildingDetail(), T0, OPTS);
    const floors = sampleBuildingDetail().floors;
    floors[1].agents[0].status = 'working'; // Beatriz: waiting -> working
    const { snapshot, rev } = applyBuildingPatch(base, { rev: 13, floors }, T1);
    expect(rev).toBe(13);
    expect(snapshot.rev).toBe(base.rev + 1);
    expect(snapshot.serverTime).toBe(T1);
    expect(byName(snapshot, 'Beatriz')).toMatchObject({ status: 'working', statusSince: T1, lastEventAt: T1, startedAt: T0 });
    expect(byName(snapshot, 'Marina')).toMatchObject({ status: 'working', statusSince: T0, lastEventAt: T0, startedAt: T0 });
    expect(snapshot.meta).toBe(base.meta);
  });

  it('a floor that disappears takes the agents; a new floor comes in after the others; the ones that stay keep their spot and createdAt', () => {
    const base = officeFromBuilding(sampleBuildingDetail(), T0, OPTS);
    const floors = sampleBuildingDetail().floors.filter((f) => f.label !== 'jade');
    floors.unshift({ id: 'f_3d4e5f6071', label: 'orion', agents: [newAgent('a_0badf00d', 'working', { name: 'Camila' })] });
    const { snapshot } = applyBuildingPatch(base, { rev: 13, floors }, T1);
    expect(snapshot.rooms.map((r) => [r.id, r.slot, r.createdAt])).toEqual([
      ['f_3d4e5f6071', 3, T1],
      ['f_0a1b2c3d4e', 0, T0],
      ['f_2c3d4e5f60', 2, T0],
    ]);
    expect(snapshot.rooms[0].name).toBe('Project Orion');
    expect(snapshot.agents.map((a) => a.name).sort()).toEqual(['Camila', 'Gustavo', 'Larissa', 'Marina', 'Rafael']);
    expect(byName(snapshot, 'Camila')).toMatchObject({ id: 'world:a_0badf00d', roomId: 'f_3d4e5f6071', statusSince: T1, startedAt: T1 });
    expect(snapshot.accounts.map((a) => a.sessions)).toEqual([3, 1]); // Marina, Larissa and Camila; Gustavo
  });

  it('only visitors (or nothing that changes the office): the same snapshot', () => {
    const base = officeFromBuilding(sampleBuildingDetail(), T0, OPTS);
    expect(applyBuildingPatch(base, { rev: 13 }, T1).snapshot).toBe(base);
    expect(applyBuildingPatch(base, { rev: 14, floors: sampleBuildingDetail().floors }, T1).snapshot).toBe(base);
    const visible = { ...sampleBuildingDetail().building };
    expect(applyBuildingPatch(base, { rev: 15, building: visible }, T1)).toEqual({ snapshot: base, rev: 15 });
  });

  it('the building became discreet or off in the middle of the visit: the rooms stay and everyone disappears', () => {
    const base = officeFromBuilding(sampleBuildingDetail(), T0, OPTS);
    for (const mode of ['discreet', 'away'] as const) {
      const { snapshot } = applyBuildingPatch(base, { rev: 13, building: sampleBuildingDetail(mode).building }, T1);
      expect(snapshot.rooms).toBe(base.rooms);
      expect(snapshot.agents).toEqual([]);
      expect(snapshot.rev).toBe(base.rev + 1);
    }
    // discreet already known by the scene: new floors arrive with nobody, even with agents by mistake
    const discreet = officeFromBuilding(sampleBuildingDetail('discreet'), T0, OPTS);
    const { snapshot } = applyBuildingPatch(discreet, { rev: 13, floors: sampleBuildingDetail().floors }, T1, sampleBuildingDetail('discreet').building);
    expect(snapshot.agents).toEqual([]);
    // and it went back to live: the patch brings the building and the floors
    const live = applyBuildingPatch(snapshot, { rev: 14, building: sampleBuildingDetail().building, floors: sampleBuildingDetail().floors }, T1);
    expect(live.snapshot.agents).toHaveLength(6);
  });

  it('checkBuildingRev: the next one applies, repeated or old is ignored, a jump asks for resync', () => {
    expect(checkBuildingRev(12, 13)).toBe('apply');
    expect(checkBuildingRev(12, 12)).toBe('stale');
    expect(checkBuildingRev(12, 3)).toBe('stale');
    expect(checkBuildingRev(12, 15)).toBe('resync');
  });
});

/** All the strings (values, not keys) of a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe('inverted canaries: the visit office only has what came from the world', () => {
  /** What is allowed: the detail's strings (and the ids with `world:`), the translated labels, the roles and the tools. */
  function allowed(d: WorldBuildingDetail): Set<string> {
    const fromDetail = strings(d);
    return new Set([
      ...fromDetail,
      ...fromDetail.map(worldId),
      ...d.floors.map((f) => floorLabel(f.label)),
      tr('Main agent'),
      tr('Subagent'),
      ...Object.values(WORLD_TOOL_ACCOUNTS).flatMap((t) => [t.name, t.short, t.color]),
      'world:claude',
      'world:codex',
      'disabled',
      'approved',
      '',
      OPTS.version,
    ]);
  }

  it('no string outside the list, even with extra fields coming from the server (path, email, title...)', () => {
    const clean = sampleBuildingDetail();
    const ok = allowed(clean);
    const dirty = structuredClone(clean) as unknown as {
      building: Record<string, unknown> & { owner: Record<string, unknown> };
      floors: Array<Record<string, unknown> & { agents: Array<Record<string, unknown> & { parts: Record<string, unknown> }> }>;
    };
    dirty.building.path = '/Users/canary/secret-project';
    dirty.building.owner.email = 'canary@company.example';
    dirty.floors[0].path = '/Users/canary/secret-project';
    dirty.floors[0].name = 'secret-project-canary';
    Object.assign(dirty.floors[0].agents[0], {
      email: 'canary@company.example',
      cwd: '/Users/canary',
      title: 'Canary session title',
      model: 'canary-model',
      gitBranch: 'feat/canary',
      activity: { text: 'Editing canary.ts' },
      tasks: [{ id: '1', title: 'Canary task', status: 'completed' }],
      statusSince: 123,
    });
    dirty.floors[0].agents[0].parts.canario = '#canary';
    for (const mode of [undefined, 'patch'] as const) {
      const d = dirty as unknown as WorldBuildingDetail;
      const s = mode ? applyBuildingPatch(officeFromBuilding(clean, T0, OPTS), { rev: 2, floors: d.floors, building: d.building }, T0 + 1).snapshot : officeFromBuilding(d, T0, OPTS);
      const out = strings(s);
      expect(out.length).toBeGreaterThan(50);
      for (const str of out) expect(ok.has(str), `unexpected string: ${JSON.stringify(str)}`).toBe(true);
      expect(JSON.stringify(s)).not.toMatch(/canary|canario|Users|@|Canary|feat\//);
      expect(byName(s, 'Marina').statusSince).not.toBe(123);
    }
  });

  it('the same in the other languages (the translated labels go into the list)', () => {
    for (const locale of ['pt-BR', 'es', 'fr'] as const) {
      setLocale(locale);
      const d = sampleBuildingDetail();
      const ok = allowed(d);
      const out = strings(officeFromBuilding(d, T0, OPTS));
      expect(out).toContain(floorLabel('ipe'));
      for (const str of out) expect(ok.has(str), `${locale}: ${str}`).toBe(true);
    }
  });
});
