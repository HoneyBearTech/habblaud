// UI presentation model: grouping rooms -> agents -> subagents, filters, counters and labels.
// Pure functions (no DOM), tested in ui/model.test.ts.
import type { AccountInfo, Activity, AgentInfo, AgentStatus, OfficeSnapshot, RoomInfo, ShellJob, TaskItem } from '../../../shared/types';
import { formatElapsed, normalizeSearch } from './format';
import { tr } from '../../../shared/i18n';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: tr('Working'),
  waiting: tr('Needs you'),
  shell: tr('Waiting on shell'),
  idle: tr('Idle'),
  done: tr('Done'),
  offline: tr('Leaving'),
};

/** Urgency order (lower = more urgent), used to highlight who needs attention. */
const STATUS_URGENCY: Record<AgentStatus, number> = { waiting: 0, shell: 1, working: 2, idle: 3, done: 4, offline: 5 };

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABEL[status];
}

/** Text of the activity line when the agent has none yet (e.g. newly opened session, no request). */
export function activityFallback(agent: Pick<AgentInfo, 'status' | 'waitingFor'>): string {
  switch (agent.status) {
    case 'working':
      return tr('Working…');
    case 'waiting':
      return agent.waitingFor ? tr('Needs you: {0}', [agent.waitingFor]) : tr('Needs you');
    case 'shell':
      return tr('Waiting for the shell to finish');
    case 'done':
      return tr('Finished the task');
    case 'offline':
      return tr('Leaving the office');
    default:
      return tr('Waiting for instructions');
  }
}

/** Role badge: "Main agent" or the subagent's type ("Explore", "Plan"...). */
export function roleLabel(agent: Pick<AgentInfo, 'kind' | 'role'>): string {
  if (agent.kind === 'main') return agent.role || tr('Main agent');
  return agent.role || tr('Subagent');
}

/** Agent still "present" (not on its way out). */
export function isPresent(agent: Pick<AgentInfo, 'status'>): boolean {
  return agent.status !== 'offline';
}

export interface Counters {
  rooms: number;
  /** Present agents (main agents + subagents, except the ones that are leaving). */
  agents: number;
  /** Agents processing a request (not counting whoever is stopped waiting for a long command). */
  working: number;
  /** Active subagents (neither done nor leaving). */
  subagents: number;
  waiting: number;
  /** Shells that some agent is waiting to finish (background and long foreground commands). */
  shells: number;
}

/** `now` (server clock) decides when a foreground command already counts as a wait. */
export function computeCounters(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null, now = Date.now()): Counters {
  const c: Counters = { rooms: 0, agents: 0, working: 0, subagents: 0, waiting: 0, shells: 0 };
  if (!snap) return c;
  c.rooms = snap.rooms.length;
  for (const a of snap.agents) {
    if (!isPresent(a)) continue;
    c.agents++;
    const wait = shellWaitIn(a, snap.agents, now);
    if (wait) c.shells += Math.max(1, wait.jobs.length);
    else if (a.status === 'working') c.working++;
    if (a.status === 'waiting') c.waiting++;
    if (a.kind === 'sub' && a.status !== 'done') c.subagents++;
  }
  return c;
}

/** Agents waiting for the user, from the one waiting longest to the most recent. */
export function waitingAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.status === 'waiting').sort((a, b) => a.statusSince - b.statusSince);
}

// ---------------------------------------------------------------- waiting on shell

/** A foreground command only counts as "waiting on shell" after this time (the same threshold as the world). */
export const FOREGROUND_WAIT_MS = 10_000;
/** In the drawer, foreground commands only show up after this time (quick commands do not make the list flicker). */
export const FOREGROUND_SHOW_MS = 2_000;

export interface ShellWait {
  /** Commands the agent is waiting for, from oldest to most recent. */
  jobs: ShellJob[];
  /** Command that drives the time and the phase of the wait (the oldest shell); absent if the server does not know the commands yet. */
  main?: ShellJob;
  /** Since when it has been waiting (epoch ms). */
  since: number;
  /** true = stopped on a long foreground command (status 'working'); false = ended the turn (status 'shell'). */
  foreground: boolean;
}

const byStart = (a: ShellJob, b: ShellJob) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Is the agent waiting for some shell to finish? Applies to the 'shell' status (ended the turn with background shells)
 * and to 'working' stopped on a foreground command for more than FOREGROUND_WAIT_MS. Returns null otherwise.
 * The time is that of the oldest shell (Bash); monitors only count if there is no shell.
 */
export function shellWait(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): ShellWait | null {
  const all = agent.shells ?? [];
  let jobs: ShellJob[];
  if (agent.status === 'shell') jobs = all.slice().sort(byStart);
  else if (agent.status === 'working') jobs = all.filter((j) => !j.background && now - j.startedAt >= FOREGROUND_WAIT_MS).sort(byStart);
  else return null;
  if (agent.status === 'working' && jobs.length === 0) return null;
  const main = jobs.find((j) => j.kind === 'shell') ?? jobs[0];
  return { jobs, main, since: Math.min(main?.startedAt ?? agent.statusSince, now), foreground: agent.status === 'working' };
}

/** Background shells started by an agent's subagents (and their subagents). */
function descendantShells(id: string, agents: readonly AgentInfo[]): ShellJob[] {
  const out: ShellJob[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const a of agents) {
      if (a.parentId !== parent || seen.has(a.id)) continue;
      seen.add(a.id);
      queue.push(a.id);
      for (const j of a.shells ?? []) if (j.background) out.push(j);
    }
  }
  return out;
}

/**
 * Like `shellWait`, looking at the whole office: an agent in 'shell' with no known shells of its own may be
 * waiting for a command that one of its subagents left running in the background (the server does the same in the
 * speech bubble).
 */
export function shellWaitIn(agent: AgentInfo, agents: readonly AgentInfo[], now: number): ShellWait | null {
  if (agent.status === 'shell' && !agent.shells?.length) {
    const inherited = descendantShells(agent.id, agents);
    if (inherited.length) return shellWait({ status: agent.status, statusSince: agent.statusSince, shells: inherited }, now);
  }
  return shellWait(agent, now);
}

/** Status shown in the interface: whoever is stopped waiting for a long command shows as "Waiting on shell". */
export function displayStatus(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): AgentStatus {
  return shellWait(agent, now) ? 'shell' : agent.status;
}

/** Commands listed in the drawer ("Running shells"): all of them, except the just-started foreground ones. */
export function visibleShells(agent: Pick<AgentInfo, 'shells'>, now: number): ShellJob[] {
  return (agent.shells ?? []).filter((j) => j.background || j.kind === 'monitor' || now - j.startedAt >= FOREGROUND_SHOW_MS).sort(byStart);
}

/** Agents waiting on shells, from the one waiting longest to the most recent ("⏳ N shells" button). */
export function shellWaitingAgents(agents: readonly AgentInfo[], now: number): AgentInfo[] {
  return agents
    .filter((a) => isPresent(a))
    .map((a) => ({ a, w: shellWaitIn(a, agents, now) }))
    .filter((x): x is { a: AgentInfo; w: ShellWait } => !!x.w)
    .sort((x, y) => x.w.since - y.w.since || byArrival(x.a, y.a))
    .map((x) => x.a);
}

/** Is there any shell running? (The interface starts updating the stopwatch every second.) */
export function hasRunningShells(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => isPresent(a) && (a.status === 'shell' || (a.shells?.length ?? 0) > 0));
}

/** Badge of the command type. */
export function shellKindLabel(job: Pick<ShellJob, 'kind' | 'background'>): string {
  if (job.kind === 'monitor') return 'monitor';
  return job.background ? tr('background') : tr('foreground');
}

export interface ShellLine {
  /** Label of the main shell (or a generic text). */
  label: string;
  /** Stopwatch: "0:42", "12:31", "1:02:10". */
  time: string;
  /** "×2" when it is waiting for more than one command; "" with only one. */
  count: string;
  /** Full sentence for tooltips and screen readers: "⏳ Run the suite · 12:31 (2 shells)". */
  text: string;
}

/** Activity line of whoever is waiting on a shell: "⏳ <label> · <time>" (and "×N" if several). */
export function shellLine(wait: ShellWait, now: number): ShellLine {
  const label = wait.main?.label?.trim() || (wait.foreground ? tr('Waiting for the command to finish') : tr('Waiting for the shell to finish'));
  const time = formatElapsed(now - wait.since);
  const n = wait.jobs.length;
  const count = n > 1 ? `×${n}` : '';
  return { label, time, count, text: `⏳ ${label} · ${time}${n > 1 ? ` (${n} shells)` : ''}` };
}

/** Text of the "Waiting on shell" box. */
export function shellBoxText(wait: Pick<ShellWait, 'foreground' | 'jobs'>): string {
  if (wait.foreground) return tr('Stuck on a terminal command, waiting for it to finish to continue the turn.');
  const n = wait.jobs.length;
  return n > 1
    ? tr('Finished the turn and is waiting for {0} shells to finish. As each one finishes, the agent gets its result.', [n])
    : tr('Finished the turn and is waiting for the shell to finish. When it does, the agent gets the result.');
}

export type ShellStage = 'popcorn' | 'spin' | 'cobweb' | 'nap';

export interface ShellStageInfo {
  stage: ShellStage;
  /** From how much waiting time the phase starts (ms). */
  from: number;
  emoji: string;
  /** Short phrase for what the character is doing. */
  text: string;
  /** Explanation for the help. */
  help: string;
}

const MIN = 60_000;

/** The phases of the wait in the office (the "comic escalation"), by the age of the oldest shell. */
export const SHELL_STAGES: readonly ShellStageInfo[] = [
  {
    stage: 'popcorn',
    from: 0,
    emoji: '🍿',
    text: tr('Eating popcorn and watching the terminal'),
    help: tr('Up to 3 min: leans back in the chair with a bucket of popcorn and watches the terminal like a movie.'),
  },
  {
    stage: 'spin',
    from: 3 * MIN,
    emoji: '🪑',
    text: tr('Out of popcorn: spinning in the chair'),
    help: tr('From 3 to 10 min: the popcorn runs out; arms crossed, fingers tapping and, now and then, a full spin in the chair.'),
  },
  {
    stage: 'cobweb',
    from: 10 * MIN,
    emoji: '🕸️',
    text: tr("There's a cobweb on the chair already"),
    help: tr('After 10 min: a cobweb appears on the chair (it grows after 20 min) and a yawn slips out.'),
  },
  {
    stage: 'nap',
    from: 25 * MIN,
    emoji: '😴',
    text: tr('Dozed off waiting on the shell'),
    help: tr('After 25 min: naps at the desk, covered in cobwebs.'),
  },
];

/** Phase of the wait for a shell running for `ms`, and how long until the next one (null on the last). */
export function shellStage(ms: number): ShellStageInfo & { nextIn: number | null } {
  const v = Math.max(0, ms);
  let i = 0;
  while (i + 1 < SHELL_STAGES.length && v >= SHELL_STAGES[i + 1].from) i++;
  const next = SHELL_STAGES[i + 1];
  return { ...SHELL_STAGES[i], nextIn: next ? next.from - v : null };
}

/** Server marker for the end of a shell (Activity with tool 'ShellDone'; error = failed or was interrupted). */
export function shellDoneKind(activity: Pick<Activity, 'tool' | 'error'> | undefined): 'ok' | 'fail' | null {
  if (activity?.tool !== 'ShellDone') return null;
  return activity.error ? 'fail' : 'ok';
}

export interface TaskProgress {
  completed: number;
  inProgress: number;
  total: number;
}

export function taskProgress(tasks: readonly Pick<TaskItem, 'status'>[]): TaskProgress {
  const p: TaskProgress = { completed: 0, inProgress: 0, total: tasks.length };
  for (const t of tasks) {
    if (t.status === 'completed') p.completed++;
    else if (t.status === 'in_progress') p.inProgress++;
  }
  return p;
}

/** Adds up the tasks of several agents (aggregate progress of a room). */
export function aggregateTasks(agents: readonly Pick<AgentInfo, 'tasks'>[]): TaskProgress {
  return taskProgress(agents.flatMap((a) => a.tasks));
}

// ---------------------------------------------------------------- grouping and filters

export interface AgentFilter {
  /** Free text: name, role, title, room, path or account. */
  query: string;
  /** Hidden accounts (AccountInfo.id). */
  hiddenAccounts: ReadonlySet<string>;
}

export interface AgentNode {
  agent: AgentInfo;
  /** Visible subagents (after filters), sorted by arrival. */
  subs: AgentInfo[];
  /** Total subagents present in the snapshot (regardless of the filter). */
  subTotal: number;
}

export interface RoomGroup {
  room: RoomInfo;
  /** Accounts present in the room (ids, in the order of the snapshot's `accounts`). */
  accounts: string[];
  nodes: AgentNode[];
  /** All the agents in the room (no filter). */
  agents: AgentInfo[];
  tasks: TaskProgress;
  /** How many agents in the room pass the filter. */
  matches: number;
}

function accountText(account: AccountInfo | undefined): string {
  if (!account) return '';
  // The tool goes into the search: "codex" finds the Codex agents.
  return [account.short, account.name, account.email ?? '', account.id, account.provider === 'codex' ? 'Codex' : ''].join(' ');
}

/** True if the agent matches the text search (no accents, case-insensitive). */
export function matchesQuery(agent: AgentInfo, room: RoomInfo | undefined, account: AccountInfo | undefined, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(
    [
      agent.name,
      roleLabel(agent),
      agent.title ?? '',
      room?.name ?? '',
      room?.path ?? '',
      accountText(account),
      agent.activity?.text ?? '',
      // Whoever is waiting on a shell also shows up when searching for "shell" (or by the command's label).
      agent.status === 'shell' ? STATUS_LABEL.shell : '',
      ...(agent.shells ?? []).map((j) => `shell ${j.label}`),
    ].join(' \u0001 '),
  );
  return q.split(/\s+/).every((term) => hay.includes(term));
}

const byArrival = (a: AgentInfo, b: AgentInfo) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Groups the snapshot into rooms (sorted by slot) -> main agents -> subagents.
 * Subagents whose parent is not in the same room become top-level items.
 * With a filter: a main agent shows if it or some subagent matches; if the main agent matches, all the subs show.
 * Rooms with no visible agent are omitted (except with no active filter).
 */
export function groupRooms(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'> | null, filter?: AgentFilter): RoomGroup[] {
  if (!snap) return [];
  const accounts = new Map(snap.accounts.map((a) => [a.id, a]));
  const accountOrder = new Map(snap.accounts.map((a, i) => [a.id, i]));
  const query = filter?.query.trim() ?? '';
  const hidden = filter?.hiddenAccounts ?? new Set<string>();
  const filtering = query.length > 0 || hidden.size > 0;

  const byRoom = new Map<string, AgentInfo[]>();
  for (const a of snap.agents) {
    let list = byRoom.get(a.roomId);
    if (!list) byRoom.set(a.roomId, (list = []));
    list.push(a);
  }

  const groups: RoomGroup[] = [];
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const agents = (byRoom.get(room.id) ?? []).slice().sort(byArrival);
    const visible = (a: AgentInfo) => !hidden.has(a.account) && matchesQuery(a, room, accounts.get(a.account), query);
    const ids = new Set(agents.map((a) => a.id));
    const subsOf = new Map<string, AgentInfo[]>();
    const top: AgentInfo[] = [];
    for (const a of agents) {
      if (a.kind === 'sub' && a.parentId && ids.has(a.parentId)) {
        let list = subsOf.get(a.parentId);
        if (!list) subsOf.set(a.parentId, (list = []));
        list.push(a);
      } else {
        top.push(a);
      }
    }

    const nodes: AgentNode[] = [];
    let matches = 0;
    for (const a of top) {
      const subs = subsOf.get(a.id) ?? [];
      const selfVisible = visible(a);
      const visibleSubs = selfVisible ? subs.filter((s) => !hidden.has(s.account)) : subs.filter(visible);
      if (!selfVisible && visibleSubs.length === 0) continue;
      matches += (selfVisible ? 1 : 0) + visibleSubs.length;
      nodes.push({ agent: a, subs: visibleSubs, subTotal: subs.length });
    }
    if (filtering && nodes.length === 0) continue;

    const present = [...new Set(agents.map((a) => a.account))].sort((x, y) => (accountOrder.get(x) ?? 99) - (accountOrder.get(y) ?? 99));
    groups.push({ room, accounts: present, nodes, agents, tasks: aggregateTasks(agents), matches });
  }
  return groups;
}

/** Distinct accounts present in a list of agents, in the order of the snapshot's accounts. */
export function accountsOf(agents: readonly Pick<AgentInfo, 'account'>[], accounts: readonly Pick<AccountInfo, 'id'>[]): string[] {
  const present = new Set(agents.map((a) => a.account));
  const ordered = accounts.map((a) => a.id).filter((id) => present.has(id));
  for (const id of present) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** Sorts by urgency and then by arrival (for subagent lists in the drawer). */
export function sortByUrgency(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.slice().sort((a, b) => STATUS_URGENCY[a.status] - STATUS_URGENCY[b.status] || byArrival(a, b));
}

/** Shell shortcuts for the empty state text: ["c", "d"] -> "shortcuts c or d". */
export function shortcutHint(accounts: readonly Pick<AccountInfo, 'short'>[]): string {
  const keys = accounts.map((a) => a.short.toLowerCase()).filter((s) => /^[a-z0-9]{1,3}$/.test(s));
  if (keys.length === 0) return '';
  if (keys.length === 1) return tr('shortcut {0}', [keys[0]]);
  return tr('shortcuts {0} or {1}', [keys.slice(0, -1).join(', '), keys[keys.length - 1]]);
}

/**
 * Merges long history (server) with the recent activities, without duplicating, from oldest to most recent.
 * `until` (replay instant) discards what happened after — on rewinding, the drawer is not left with the future.
 */
export function mergeHistory<T extends { id: string; at: number }>(history: readonly T[], recent: readonly T[], limit = 200, until?: number): T[] {
  const seen = new Map<string, T>();
  const keep = (a: T) => until === undefined || a.at <= until;
  for (const a of history) if (keep(a)) seen.set(a.id, a);
  for (const a of recent) if (keep(a)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-limit);
}
