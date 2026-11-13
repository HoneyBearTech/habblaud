// Wallets of the characters (fictional coins 🪙). Whoever arrives at the office already comes in with a
// balance; earns more with each completed task and loses or wins in the bets with coworkers.
//
// It stays in the browser (localStorage), per agent: each browser has its own economy (the bets are
// drawn in the local simulation). Without localStorage (tests, blocked private tab), only in memory.
// The agents of a visited world building (`world:` ids, shared/world/office-from-world.ts) stay under a separate
// key (WORLD_STORAGE_KEY), deleted on leaving the visit: the visit does not touch the local office's economy.
import { tr } from '../../../../shared/i18n';
import { isWorldId } from '../../../../shared/world/office-from-world';

/** Balance of whoever arrives at the office. */
export const START_COINS: Readonly<Record<'main' | 'sub', number>> = { main: 100, sub: 30 };
/** Task list item completed. */
export const TASK_REWARD = 10;
/** Subagent delivered the result to the agent that called it (its task). */
export const DELIVERY_REWARD = 15;
/** User request handled (end of turn). */
export const TURN_REWARD = 5;

const STORAGE_KEY = 'habblaud.wallets.v1';
/** Wallets of the visit to a world building (`world:` ids). */
export const WORLD_STORAGE_KEY = 'habblaud:world-wallet';
const LEDGER_MAX = 12;
const PAID_MAX = 300;
/** Wallets of agents that have not appeared for longer than this are forgotten. */
const FORGET_MS = 3 * 24 * 3_600_000;
const MAX_WALLETS = 400;

export interface LedgerEntry {
  at: number;
  delta: number;
  icon: string;
  text: string;
}

export interface WalletEntry {
  name: string;
  coins: number;
  /** Total earned working (starting balance, tasks, deliveries, requests). */
  earned: number;
  wins: number;
  losses: number;
  /** Record per opponent (id): [wins, losses]. */
  vs: Record<string, [number, number]>;
  /** Tasks already paid ("id|title"). */
  paid: string[];
  /** Statement: most recent transactions first. */
  ledger: LedgerEntry[];
  createdAt: number;
  seenAt: number;
}

/** The minimum of AgentInfo that the wallet uses. */
export interface WalletAgent {
  id: string;
  name: string;
  kind: 'main' | 'sub';
  tasks: readonly { id: string; title: string; status: string }[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Which economy the wallet belongs to: the local office's or that of the visit to a world building. */
type Part = 'office' | 'world';
const PARTS: readonly Part[] = ['office', 'world'];
const KEYS: Readonly<Record<Part, string>> = { office: STORAGE_KEY, world: WORLD_STORAGE_KEY };
const partOf = (id: string): Part => (isWorldId(id) ? 'world' : 'office');

/**
 * Deletes the visit's wallets kept in the browser (on leaving the building). Call it after discarding the visit's
 * `Sim`: it saves the wallets when it is swapped.
 */
export function clearWorldWallets(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    if (storage.removeItem) storage.removeItem(WORLD_STORAGE_KEY);
    else storage.setItem(WORLD_STORAGE_KEY, '');
  } catch {
    // blocked: what is left is forgotten by the prune (FORGET_MS)
  }
}

/** localStorage, if it exists and works (private/blocked tab throws on access). */
export function browserStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) return null;
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}

function taskKey(t: { id: string; title: string }): string {
  return `${t.id}|${t.title}`;
}

export class Wallets {
  private map = new Map<string, WalletEntry>();
  /** What changed since the last save, per economy: each one only rewrites its own key. */
  private dirty: Record<Part, boolean> = { office: false, world: false };

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  get(id: string): WalletEntry | undefined {
    return this.map.get(id);
  }

  coins(id: string): number {
    return this.map.get(id)?.coins ?? 0;
  }

  /**
   * Ensures the agent's wallet. The first time: starting balance and the tasks that were already
   * completed paid silently (whoever already worked before the page opened does not lose what they did).
   */
  ensure(a: WalletAgent, now: number): { entry: WalletEntry; created: boolean } {
    let w = this.map.get(a.id);
    if (w) {
      if (w.name !== a.name) w.name = a.name;
      if (now - w.seenAt > 60_000) {
        w.seenAt = now;
        this.touch(a.id);
      }
      return { entry: w, created: false };
    }
    const start = START_COINS[a.kind] ?? START_COINS.main;
    w = { name: a.name, coins: start, earned: start, wins: 0, losses: 0, vs: {}, paid: [], ledger: [], createdAt: now, seenAt: now };
    this.map.set(a.id, w);
    this.log(w, { at: now, delta: start, icon: '🏢', text: tr('Arrived at the office') });
    const done = a.tasks.filter((t) => t.status === 'completed');
    if (done.length) {
      for (const t of done) w.paid.push(taskKey(t));
      const v = done.length * TASK_REWARD;
      w.coins += v;
      w.earned += v;
      this.log(w, { at: now, delta: v, icon: '✅', text: done.length === 1 ? tr('1 task already done') : tr('{0} tasks already done', [done.length]) });
    }
    this.touch(a.id);
    return { entry: w, created: true };
  }

  /** Pays the completed tasks that have not been paid yet. Returns how much it paid now. */
  payTasks(a: WalletAgent, now: number): number {
    const w = this.map.get(a.id);
    if (!w) return 0;
    let total = 0;
    for (const t of a.tasks) {
      if (t.status !== 'completed') continue;
      const k = taskKey(t);
      if (w.paid.includes(k)) continue;
      w.paid.push(k);
      if (w.paid.length > PAID_MAX) w.paid.splice(0, w.paid.length - PAID_MAX);
      w.coins += TASK_REWARD;
      w.earned += TASK_REWARD;
      total += TASK_REWARD;
      this.log(w, { at: now, delta: TASK_REWARD, icon: '✅', text: tr('Task done: {0}', [t.title]) });
    }
    if (total) this.touch(a.id);
    return total;
  }

  /** Credit for work (handled request, subagent delivery). */
  credit(id: string, amount: number, icon: string, text: string, now: number): number {
    const w = this.map.get(id);
    if (!w || amount <= 0) return 0;
    w.coins += amount;
    w.earned += amount;
    this.log(w, { at: now, delta: amount, icon, text });
    this.touch(id);
    return amount;
  }

  /**
   * Bet paid: takes up to `amount` from whoever lost (never leaves it negative) and gives it to whoever won.
   * Returns the amount that actually changed hands.
   */
  transfer(fromId: string, toId: string, amount: number, icon: string, what: string, now: number): number {
    const from = this.map.get(fromId);
    const to = this.map.get(toId);
    if (!from || !to || fromId === toId) return 0;
    const v = Math.max(0, Math.min(Math.floor(amount), from.coins));
    if (!v) return 0;
    from.coins -= v;
    to.coins += v;
    this.log(from, { at: now, delta: -v, icon, text: tr('Lost {0} to {1}', [what, to.name]) });
    this.log(to, { at: now, delta: v, icon, text: tr('Won {0} against {1}', [what, from.name]) });
    this.touch(fromId);
    this.touch(toId);
    return v;
  }

  /** Score of a match/bet (also counts with no money at stake). */
  recordMatch(winnerId: string, loserId: string): void {
    const w = this.map.get(winnerId);
    const l = this.map.get(loserId);
    if (!w || !l) return;
    w.wins++;
    l.losses++;
    (w.vs[loserId] ??= [0, 0])[0]++;
    (l.vs[winnerId] ??= [0, 0])[1]++;
    this.touch(winnerId);
    this.touch(loserId);
  }

  /**
   * Saves to the browser what changed (called at low frequency), each economy under its own key: the visit to a
   * world building never rewrites the office's (not even with an old copy of it) and vice versa.
   */
  save(now: number): void {
    for (const part of PARTS) {
      if (!this.dirty[part]) continue;
      this.dirty[part] = false;
      this.prune(now, part);
      if (!this.storage) continue;
      const wallets = Object.fromEntries([...this.map].filter(([id]) => partOf(id) === part));
      try {
        this.storage.setItem(KEYS[part], JSON.stringify({ v: 1, wallets }));
      } catch {
        // quota full/blocked: goes on in memory only
      }
    }
  }

  /** Forgets wallets of whoever has not appeared for days (and limits the total of each economy). */
  prune(now: number, only?: Part): void {
    for (const part of only ? [only] : PARTS) {
      const entries = [...this.map].filter(([id]) => partOf(id) === part);
      for (const [id, w] of entries) if (now - w.seenAt > FORGET_MS) this.map.delete(id);
      const left = entries.filter(([id]) => this.map.has(id));
      if (left.length <= MAX_WALLETS) continue;
      const old = left.sort((a, b) => a[1].seenAt - b[1].seenAt);
      for (const [id] of old.slice(0, left.length - MAX_WALLETS)) this.map.delete(id);
    }
  }

  private touch(id: string): void {
    this.dirty[partOf(id)] = true;
  }

  private log(w: WalletEntry, e: LedgerEntry): void {
    w.ledger.unshift(e);
    if (w.ledger.length > LEDGER_MAX) w.ledger.length = LEDGER_MAX;
  }

  private load(): void {
    for (const part of PARTS) this.loadPart(part);
  }

  private loadPart(part: Part): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(KEYS[part]);
      if (!raw) return;
      const j = JSON.parse(raw) as { v?: number; wallets?: Record<string, Partial<WalletEntry>> };
      for (const [id, w] of Object.entries(j.wallets ?? {})) {
        if (partOf(id) !== part) continue; // each key only with its own economy
        if (!w || typeof w.coins !== 'number' || !Number.isFinite(w.coins)) continue;
        this.map.set(id, {
          name: typeof w.name === 'string' ? w.name : id,
          coins: Math.max(0, Math.floor(w.coins)),
          earned: typeof w.earned === 'number' ? w.earned : w.coins,
          wins: typeof w.wins === 'number' ? w.wins : 0,
          losses: typeof w.losses === 'number' ? w.losses : 0,
          vs: w.vs && typeof w.vs === 'object' ? w.vs : {},
          paid: Array.isArray(w.paid) ? w.paid.filter((p): p is string => typeof p === 'string') : [],
          ledger: Array.isArray(w.ledger) ? w.ledger.slice(0, LEDGER_MAX) : [],
          createdAt: typeof w.createdAt === 'number' ? w.createdAt : 0,
          seenAt: typeof w.seenAt === 'number' ? w.seenAt : 0,
        });
      }
    } catch {
      // unreadable: starts from scratch
    }
  }
}
