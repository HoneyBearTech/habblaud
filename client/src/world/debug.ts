// World debug API (console: `habblaud.world.debug`), used in visual tests to
// force scenarios: simulated sessions arriving/leaving, rooms closing, time of day, camera and the
// shell wait (shells running, aging the wait, finishing with success/failure).
import type { Activity, AgentInfo, AgentStatus, RoomInfo, ShellJob } from '../../../shared/types';
import { SPECIAL, type ShellOutcome } from '../../../shared/activity';
import { hash32 } from '../../../shared/hash';
import { TILE } from '../art/api';
import type { Camera } from './camera';
import type { Renderer } from './render/renderer';
import { oldestShell } from './sim/shell';
import type { Sim } from './sim/sim';
import type { GatherKind } from './social/gathering';

/** A shell for the debug scenarios: optional ShellJob fields + relative age. */
export interface ShellJobInput extends Partial<ShellJob> {
  /** How many minutes ago the command started (ignored if `startedAt` is given). */
  ageMinutes?: number;
  ageSeconds?: number;
}

export interface SpawnOptions {
  /** Project name (room). Default: a new name; if the room exists, reuses it. */
  project?: string;
  name?: string;
  /** Account id (AccountInfo.id). */
  account?: string;
  status?: AgentStatus;
  /** How many subagents (working) to start along with it. */
  subs?: number;
  /**
   * Starts out already waiting for shell(s): status 'shell' (or 'working' with `background: false`, a
   * long command in the foreground). `count` > 1 creates several (the hourglass "×N").
   */
  shell?: { label?: string; command?: string; ageMinutes?: number; count?: number; background?: boolean; kind?: 'shell' | 'monitor' };
}

export interface WorldDebug {
  /** State summary: rooms (phase, light) and characters (mode, step, position). */
  state(): unknown;
  /** Opens a simulated session (new room if needed). Returns the main agent's id. */
  spawnSession(opts?: SpawnOptions): string;
  /** Changes the status of a simulated session (e.g. 'waiting', 'idle') or of a simulated subagent. */
  setStatus(agentId: string, status: AgentStatus, waitingFor?: string): void;
  /** Ends a simulated session (the agent disappears from the snapshot; the subagents too). */
  endSession(agentId: string): void;
  /** Simulates the end of a real session (it leaves; if it is the last one, turns off the light). */
  closeSession(agentId: string): void;
  /** Simulates the end of all sessions in a room: everyone leaves and the room disappears from the "snapshot". */
  closeRoom(roomId: string): void;
  /** Undoes the simulated endings and removes the simulated sessions. */
  reset(): void;
  /** Forces the time of day (0–24) for the day/night cycle; null goes back to local time. */
  setHour(hour: number | null): void;
  /** Centers the camera on a point (tiles) with optional zoom, without animation. */
  lookAt(tx: number, ty: number, zoom?: number): void;
  /** Centers the camera on a room (id or name). */
  lookAtRoom(idOrName: string, zoom?: number): void;
  /** Advances all behaviors to their destination (as when coming back from a hidden tab). */
  fastForward(): void;
  /** Makes everyone who is idle go out for a walk now. */
  wanderNow(): void;
  /**
   * Starts a hangout now with whoever is idle/waiting for a shell (or with `ids`): everyone goes back to
   * the desk right away and they leave together. Returns the participants' names or null.
   */
  socialize(kind: GatherKind, ids?: string[]): string[] | null;
  /** Hangouts in progress: kind, phase, participants, score and bet. */
  gatherings(): unknown;
  /** Adds coins to (or takes them from) an agent's wallet. Returns the balance. */
  coins(agentId: string, delta: number): number;
  /**
   * Sets the shells an agent waits for (simulated session or real agent; the real one stays overlaid
   * until reset()). Any in the background -> status 'shell'; only in the foreground -> 'working';
   * empty list -> 'idle' (if it was in 'shell').
   */
  setShells(agentId: string, jobs: ShellJobInput[]): void;
  /** Ages the shells (all sessions with shells, or just one agent) by `minutes` — to see the stages. */
  ageShells(minutes: number, agentId?: string): void;
  /**
   * Finishes the oldest shell (or all, `opts.all`) of an agent: records the 'ShellDone' Activity
   * (error on 'failed'/'killed'), which triggers the confetti or the rain. With no background shells
   * left, the status becomes `opts.then` (default 'working': the agent wakes up with the notification).
   */
  finishShell(agentId: string, result?: 'completed' | 'failed' | 'killed', opts?: { all?: boolean; then?: AgentStatus }): void;
  /**
   * Turns on the party (~12 s) or the alarm (until turned off with `null`) of a room (id or name), like a
   * GitHub event; `agentId` = the one responsible (star at the party, "!" speech bubble at the alarm).
   */
  roomEffect(idOrName: string, kind: 'party' | 'alarm' | null, opts?: { text?: string; agentId?: string }): void;
  readonly sim: Sim;
  readonly camera: Camera;
}

const NAMES = ['Lia', 'Otávio', 'Bruna', 'Caio', 'Iara', 'Rui', 'Nina', 'Davi', 'Tais', 'Ivo'];

export function createDebug(sim: Sim, renderer: Renderer, camera: Camera, onCameraMoved: () => void): WorldDebug {
  let seq = 0;
  const now = () => Date.now();
  const reapply = () => sim.reapply(now());

  const freeSlot = (): number => {
    const used = new Set<number>([...sim.rooms.values()].map((r) => r.slot));
    for (const r of sim.injected.rooms) used.add(r.slot);
    let s = 0;
    while (used.has(s)) s++;
    return s;
  };

  const makeAgent = (base: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'name' | 'roomId' | 'kind' | 'account' | 'sessionId'>): AgentInfo => {
    const t = now();
    return {
      look: seq % 2 ? 'f' : 'm',
      role: base.kind === 'main' ? 'Main agent' : 'Explore',
      status: 'working',
      recent: [],
      tasks: base.kind === 'main' ? [{ id: '1', title: 'Test the world', status: 'in_progress' }, { id: '2', title: 'Review', status: 'pending' }] : [],
      startedAt: t,
      lastEventAt: t,
      statusSince: t,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32(base.id),
      activity: { id: `dbg-act-${++seq}`, kind: 'edit', icon: '✏️', text: 'Editing world.ts', at: t },
      ...base,
    };
  };

  const makeJobs = (jobs: readonly ShellJobInput[]): ShellJob[] =>
    jobs.map((j) => ({
      id: j.id ?? `bdbg${(++seq).toString(36)}`,
      label: j.label ?? 'Run the test suite',
      command: j.command ?? 'npm test',
      startedAt: j.startedAt ?? now() - (j.ageMinutes ?? 0) * 60_000 - (j.ageSeconds ?? 0) * 1000,
      background: j.background ?? true,
      kind: j.kind ?? 'shell',
    }));

  /** Status consistent with the shells: background -> 'shell'; foreground only -> 'working'. */
  const statusFor = (cur: AgentStatus, shells: readonly ShellJob[]): AgentStatus => {
    if (cur === 'waiting' || cur === 'offline' || cur === 'done') return cur;
    if (shells.some((j) => j.background)) return 'shell';
    if (shells.length) return 'working';
    return cur === 'shell' ? 'idle' : cur;
  };

  /**
   * Edits an agent as a new snapshot would (changed copy): simulated sessions directly;
   * real agents by overlay (sim.agentPatches) until reset().
   */
  const editAgent = (id: string, fn: (a: AgentInfo) => void): boolean => {
    const i = sim.injected.agents.findIndex((x) => x.id === id);
    if (i >= 0) {
      const a: AgentInfo = { ...sim.injected.agents[i] };
      fn(a);
      sim.injected.agents[i] = a;
      return true;
    }
    const ch = sim.chars.get(id);
    if (!ch) return false;
    const a: AgentInfo = { ...ch.info };
    fn(a);
    const patch: Partial<AgentInfo> = { ...sim.agentPatches.get(id) };
    for (const k of ['status', 'statusSince', 'shells', 'activity'] as const) if (a[k] !== ch.info[k]) Object.assign(patch, { [k]: a[k] });
    sim.agentPatches.set(id, patch);
    return true;
  };

  const applyShells = (a: AgentInfo, shells: ShellJob[]) => {
    const status = statusFor(a.status, shells);
    if (status !== a.status) a.statusSince = now();
    a.status = status;
    a.shells = shells;
    // like the server: the 'shell' status counts from the start of the wait
    const oldest = oldestShell(shells, false);
    if (status === 'shell' && oldest) a.statusSince = Math.min(a.statusSince, oldest.startedAt);
  };

  return {
    state: () => ({
      cols: sim.building.cols,
      camera: { x: Math.round(camera.x), y: Math.round(camera.y), zoom: camera.zoom },
      rooms: [...sim.rooms.values()].map((r) => ({
        id: r.id,
        name: r.info.name,
        slot: r.slot,
        phase: r.phase,
        listed: r.listed,
        lightOn: r.lightOn,
        light: Math.round(r.light(now()) * 100) / 100,
        occupants: sim.occupants(r),
      })),
      chars: [...sim.chars.values()].map((c) => ({
        id: c.id,
        name: c.info.name,
        kind: c.info.kind,
        status: c.info.status,
        mode: c.mode,
        step: c.step?.t ?? null,
        queue: c.queue.map((s) => s.t),
        tile: [c.tx, c.ty],
        room: c.roomId,
        spot: c.atSpot,
        leaving: c.leaving,
        pose: c.pose,
        held: c.held,
        dir: c.dir,
        icon: c.icon,
        shell: c.mode === 'shell' ? { stage: c.shellStage, count: c.shellCount, label: c.shellLabel, ageMin: Math.round(((now() - c.shellSince) / 60_000) * 10) / 10 } : null,
      })),
    }),

    spawnSession: (opts = {}) => {
      const project = opts.project ?? `test-project-${seq + 1}`;
      let room: RoomInfo | undefined = [...sim.rooms.values()].map((r) => r.info).find((r) => r.name === project) ?? sim.injected.rooms.find((r) => r.name === project);
      if (!room) {
        const id = `/debug/${project}`;
        room = { id, name: project, path: id, slot: freeSlot(), seed: hash32(id), createdAt: now() };
        sim.injected.rooms.push(room);
      }
      const n = ++seq;
      const sessionId = `dbg-sess-${n}`;
      const account = opts.account ?? [...sim.accounts.keys()][n % Math.max(1, sim.accounts.size)] ?? '.claude';
      const main = makeAgent({
        id: `dbg:${n}`,
        kind: 'main',
        name: opts.name ?? NAMES[n % NAMES.length],
        roomId: room.id,
        account,
        sessionId,
        status: opts.status ?? 'working',
        title: `Test session ${n}`,
      });
      if (opts.shell) {
        const sh = opts.shell;
        const n = Math.max(1, Math.floor(sh.count ?? 1));
        const jobs: ShellJobInput[] = [];
        for (let i = 0; i < n; i++) {
          jobs.push({
            label: i === 0 ? sh.label : `${sh.label ?? 'Run the test suite'} (${i + 1})`,
            command: sh.command,
            // the others started after the first
            ageMinutes: Math.max(0, (sh.ageMinutes ?? 0) - i * 0.5),
            background: sh.background ?? true,
            kind: sh.kind,
          });
        }
        applyShells(main, makeJobs(jobs));
        main.activity = { id: `dbg-act-${++seq}`, kind: 'run', icon: '💻', text: 'Running in the background', tool: 'Bash', at: now() };
      }
      sim.injected.agents.push(main);
      for (let i = 0; i < (opts.subs ?? 0); i++) {
        const k = ++seq;
        sim.injected.agents.push(
          makeAgent({ id: `${sessionId}:sub${k}`, kind: 'sub', parentId: main.id, name: NAMES[k % NAMES.length], roomId: room.id, account, sessionId, title: 'Investigate the bug' }),
        );
      }
      reapply();
      return main.id;
    },

    setStatus: (id, status, waitingFor) => {
      const i = sim.injected.agents.findIndex((x) => x.id === id);
      if (i < 0) return;
      // new copy (like a real snapshot), so the world notices the change
      const a: AgentInfo = { ...sim.injected.agents[i] };
      sim.injected.agents[i] = a;
      a.status = status;
      a.statusSince = now();
      a.waitingFor = status === 'waiting' ? (waitingFor ?? 'approve a permission') : undefined;
      a.activity = {
        id: `dbg-act-${++seq}`,
        kind: status === 'idle' || status === 'done' ? 'done' : status === 'waiting' ? 'wait' : 'run',
        icon: status === 'idle' || status === 'done' ? '✅' : status === 'waiting' ? '✋' : '💻',
        text: status === 'idle' || status === 'done' ? 'Done' : status === 'waiting' ? 'Needs you' : 'Running tests',
        at: now(),
      };
      reapply();
    },

    endSession: (id) => {
      const main = sim.injected.agents.find((x) => x.id === id);
      sim.injected.agents = sim.injected.agents.filter((x) => x.id !== id && x.parentId !== id);
      if (main && !sim.injected.agents.some((x) => x.roomId === main.roomId)) sim.injected.rooms = sim.injected.rooms.filter((r) => r.id !== main.roomId);
      reapply();
    },

    closeSession: (id) => {
      sim.forcedOffline.add(id);
      for (const c of sim.chars.values()) if (c.info.parentId === id) sim.forcedOffline.add(c.id);
      reapply();
    },

    closeRoom: (roomId) => {
      for (const c of sim.chars.values()) if (c.roomId === roomId) sim.forcedOffline.add(c.id);
      sim.hiddenRooms.add(roomId);
      reapply();
    },

    reset: () => {
      sim.agentPatches.clear();
      sim.forcedOffline.clear();
      sim.hiddenRooms.clear();
      sim.injected.agents = [];
      sim.injected.rooms = [];
      reapply();
    },

    setHour: (h) => {
      renderer.hourOverride = h;
    },

    lookAt: (tx, ty, zoom) => {
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = tx * TILE;
      camera.y = ty * TILE;
      if (zoom) camera.zoom = zoom;
      camera.clamp();
    },

    lookAtRoom: (idOrName, zoom = 2.5) => {
      const room = [...sim.rooms.values()].find((r) => r.id === idOrName || r.info.name === idOrName);
      if (!room) return;
      const r = room.layout.rect;
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = (r.x + r.w / 2) * TILE;
      camera.y = (r.y + r.h / 2) * TILE;
      camera.zoom = zoom;
      camera.clamp();
    },

    fastForward: () => sim.fastForward(now()),

    wanderNow: () => {
      for (const c of sim.chars.values()) c.nextOutingAt = 1;
    },

    socialize: (kind, ids) => {
      sim.fastForward(now());
      return sim.social.force(kind, now(), ids);
    },

    gatherings: () =>
      [...sim.social.gatherings].map((g) => ({
        kind: g.kind,
        phase: g.phase,
        program: g.program,
        bet: g.bet,
        score: g.score,
        members: g.members.map((m) => ({ name: sim.chars.get(m.id)?.info.name ?? m.id, role: m.role, arrived: m.arrived, left: m.left, pose: m.pose })),
      })),

    coins: (id, delta) => {
      const w = sim.social.wallets.get(id);
      if (!w) return 0;
      if (delta > 0) sim.social.wallets.credit(id, delta, '🛠️', 'Adjustment (debug)', now());
      else w.coins = Math.max(0, w.coins + delta);
      return w.coins;
    },

    setShells: (id, jobs) => {
      if (editAgent(id, (a) => applyShells(a, makeJobs(jobs)))) reapply();
    },

    ageShells: (minutes, agentId) => {
      const ms = minutes * 60_000;
      if (!Number.isFinite(ms) || !ms) return;
      const ids = agentId ? [agentId] : [...sim.injected.agents.map((a) => a.id), ...sim.agentPatches.keys()];
      for (const id of ids) {
        editAgent(id, (a) => {
          if (!a.shells?.length) return;
          a.shells = a.shells.map((j) => ({ ...j, startedAt: j.startedAt - ms }));
          if (a.status === 'shell') a.statusSince -= ms;
        });
      }
      reapply();
    },

    finishShell: (id, result = 'completed', opts = {}) => {
      const ok = result === 'completed';
      const done = editAgent(id, (a) => {
        const shells = [...(a.shells ?? [])].sort((x, y) => x.startedAt - y.startedAt);
        const ended = opts.all ? shells : shells.slice(0, 1);
        const rest = opts.all ? [] : shells.slice(1);
        const t = now();
        const ms = ended[0] ? t - ended[0].startedAt : undefined;
        // same texts as the server ("Shell finished: <label> (<duration>)", "Shell failed: …")
        const outcome: ShellOutcome = ok ? 'ok' : result === 'killed' ? 'killed' : 'failed';
        const detail = ended.map((j) => j.command ?? j.label).join(' | ') || undefined;
        const activity: Activity = { id: `dbg-act-${++seq}`, at: t, ...SPECIAL.shellDone(ended[0]?.label, outcome, ms, detail) };
        if (ok && ms !== undefined) activity.durationMs = ms;
        a.activity = activity;
        a.recent = [...(a.recent ?? []), activity].slice(-30);
        a.shells = rest;
        const next = rest.some((j) => j.background) ? 'shell' : rest.length ? 'working' : (opts.then ?? 'working');
        if (next !== a.status) {
          a.status = next;
          a.statusSince = t;
        }
      });
      if (done) reapply();
    },

    roomEffect: (idOrName, kind, opts = {}) => {
      const room = [...sim.rooms.values()].find((r) => r.id === idOrName || r.info.name === idOrName);
      if (!room) return;
      if (!kind) {
        sim.roomFx.active.delete(room.id);
        return;
      }
      const t = now();
      const text = opts.text ?? (kind === 'party' ? 'PR #12 merged!' : 'CI failed (main)');
      const agentId = opts.agentId ?? [...sim.chars.values()].find((c) => c.roomId === room.id && !c.leaving)?.id;
      const end = t + (kind === 'party' ? 12_000 : 3_600_000);
      sim.roomFx.active.set(room.id, { roomId: room.id, kind, text, agentId, key: t, start: t, end, cheered: new Set(), sticky: true });
    },

    sim,
    camera,
  };
}
