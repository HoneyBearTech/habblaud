// Office state in the browser: receives snapshots/feed/alerts from the server over SSE
// (or from the local simulator when the URL has ?mock=1) and notifies the subscribers.
// Alternative source (the timelapse, ui/timelapse.ts): pushReplay() publishes rebuilt snapshots and the
// SSE stays connected underneath, with the live snapshots kept until stopReplay().
// It also handles reconnection: when the browser gives up on the stream (EventSource closed after an HTTP error,
// e.g. the server restarting behind a proxy), it tries again with a growing wait.
import type { AppearanceParts } from '../../../shared/appearance';
import type { Activity, AgentDetail, AgentInfo, FeedItem, Notice, OfficeSnapshot, OutboxMessage, PermissionDecision, PermissionRequestInfo, RoomInfo } from '../../../shared/types';
import { DemoSimulator } from '../../../shared/demo/simulator';
import { tr } from '../../../shared/i18n';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'mock';

export interface StoreEvents {
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notice: Notice;
  connection: ConnectionState;
  /** The server is serving another build of the client: this page is out of date. Emitted once. */
  update: { build: string; current: string };
}

/**
 * This page's build: the name of the main bundle (e.g. "main-BFqheOCa"), taken from the URL of the module itself.
 * In dev mode (source code served by Vite) there is no bundle and the result is undefined.
 */
export function pageBuild(moduleUrl: string = import.meta.url): string | undefined {
  try {
    return /\/bundle\/(main-[\w-]+)\.js$/.exec(new URL(moduleUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Listener<K extends keyof StoreEvents> = (value: StoreEvents[K]) => void;

/** The minimum of EventSource that the store uses (lets the tests inject a fake one). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StoreOptions {
  mock?: boolean;
  /** Mock mode parameters (default: the page's query string). */
  search?: string;
  /** Stream factory (default: `new EventSource(url)`). */
  eventSource?: (url: string) => EventSourceLike;
}

const FEED_LIMIT = 200;
/** EventSource.CLOSED (literal constant: EventSource does not exist in the Node of the tests). */
const ES_CLOSED = 2;
/** Wait between reconnection attempts: 2 s, 4 s, 8 s… up to 30 s. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * Simulator options from the query string (?speed=2&sessions=6). `sessions=0` is valid: empty office. For
 * screenshots: `seed=N` repeats the same office and `noquota=1` leaves the Codex account with "no quota".
 */
export function mockOptionsFrom(search: string): { speed: number; sessions: number; seed?: number; codexNoQuota?: boolean } {
  const params = new URLSearchParams(search);
  const num = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const speed = num('speed');
  const sessions = num('sessions');
  const seed = num('seed');
  return {
    speed: speed !== null && speed > 0 ? Math.min(speed, 50) : 1,
    sessions: sessions !== null && sessions >= 0 ? Math.min(Math.floor(sessions), 40) : 4,
    ...(seed !== null && seed >= 0 ? { seed: Math.floor(seed) } : {}),
    ...(params.get('noquota') === '1' ? { codexNoQuota: true } : {}),
  };
}

export class OfficeStore {
  snapshot: OfficeSnapshot | null = null;
  /** Global feed, from oldest to newest. */
  feed: FeedItem[] = [];
  connection: ConnectionState = 'connecting';
  readonly mock: boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof StoreEvents, Set<(value: any) => void>>();
  private agentIndex = new Map<string, AgentInfo>();
  private roomIndex = new Map<string, RoomInfo>();
  private source: EventSourceLike | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private readonly search: string;
  private readonly openStream: (url: string) => EventSourceLike;
  /** Reconnection: failed attempts in a row and the timer for the next one. */
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  /** Turned off on purpose (disconnect()): does not reconnect on its own. */
  private stopped = true;
  private readonly onOnline = () => {
    if (!this.stopped && this.connection === 'closed') this.reconnectNow();
  };
  /** Timelapse on: `snapshot` is the rebuilt one; the last live one stays in `live` (with the time it arrived). */
  private replay = false;
  private live: { snap: OfficeSnapshot; at: number } | null = null;

  constructor(opts: StoreOptions = {}) {
    this.mock = !!opts.mock;
    this.search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.openStream = opts.eventSource ?? ((url) => new EventSource(url));
  }

  on<K extends keyof StoreEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.mock) return this.startMock();
    this.startSSE();
  }

  disconnect(): void {
    this.stopped = true;
    if (typeof removeEventListener === 'function') removeEventListener('online', this.onOnline);
    this.clearRetry();
    this.closeSource();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  /** Reconnects immediately ("Try now" button), without waiting for the next interval. */
  reconnectNow(): void {
    if (this.mock) return;
    this.clearRetry();
    this.closeSource();
    this.stopped = false;
    this.startSSE();
  }

  /** When the next automatic reconnection attempt will be (epoch ms), or null. */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  agent(id: string): AgentInfo | undefined {
    return this.agentIndex.get(id);
  }

  room(id: string): RoomInfo | undefined {
    return this.roomIndex.get(id);
  }

  agentsInRoom(roomId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter((a) => a.roomId === roomId);
  }

  /** Long history of an agent (server). In mock mode and in the timelapse it returns the `recent`. */
  async agentHistory(id: string): Promise<Activity[]> {
    if (this.mock || this.replay) return this.agent(id)?.recent ?? [];
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
    if (!res.ok) return this.agent(id)?.recent ?? [];
    const detail = (await res.json()) as AgentDetail;
    return detail.history;
  }

  /** Turns the demo agents on/off on the server. */
  async setDemo(enabled: boolean): Promise<boolean> {
    if (this.mock) return true;
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  /** "Check now": asks the server to query GitHub (the result arrives in the snapshot). */
  async checkUpdates(): Promise<boolean> {
    if (this.mock) return false;
    const res = await fetch('/api/updates/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  }

  // ---------------------------------------------------------------- timelapse

  /** Snapshots come from an alternative source (the timelapse), not from the SSE. */
  get replaying(): boolean {
    return this.replay;
  }

  /** Last live snapshot (during the timelapse, `snapshot` is the rebuilt one). */
  get liveSnapshot(): OfficeSnapshot | null {
    return this.replay ? (this.live?.snap ?? null) : this.snapshot;
  }

  /** Publishes a snapshot from the alternative source; the first one turns on replay mode (the live one is kept). */
  pushReplay(snap: OfficeSnapshot): void {
    if (!this.replay) {
      this.replay = true;
      this.live = this.snapshot ? { snap: this.snapshot, at: Date.now() } : null;
    }
    this.setSnapshot(snap);
  }

  /** Turns off the alternative source and goes back to the last live snapshot. */
  stopReplay(): void {
    if (!this.replay) return;
    this.replay = false;
    const live = this.live;
    this.live = null;
    if (live) {
      // `serverTime` advanced by the time it was kept: the UI sets the clock by the snapshot that just arrived.
      this.setSnapshot({ ...live.snap, serverTime: live.snap.serverTime + (Date.now() - live.at) });
    } else {
      this.snapshot = null;
      this.agentIndex = new Map();
      this.roomIndex = new Map();
    }
  }

  /**
   * Detail of a permission request (with the arguments: command, diff...). The demo's requests already come
   * complete in the snapshot; the real ones come from GET /api/permissions/:id (only with local access).
   */
  async permissionDetail(agentId: string, id: string): Promise<PermissionRequestInfo | undefined> {
    const inline = this.agent(agentId)?.permission;
    if (inline?.id === id && inline.input !== undefined) return inline;
    if (this.mock) return inline?.id === id ? inline : undefined;
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}`);
    if (!res.ok) return undefined;
    return (await res.json()) as PermissionRequestInfo;
  }

  /**
   * Answers a permission request from the office. Returns undefined if it worked, or the server's error
   * message (request already answered, access that is not local...).
   */
  async decidePermission(id: string, d: PermissionDecision): Promise<string | undefined> {
    if (this.mock) {
      const sim = this.mockSim;
      if (!sim?.decidePermission(id, d)) return tr('This request has already been answered.');
      this.applySnapshot(sim.snapshot());
      return undefined;
    }
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    if (res.ok) return undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') return body.error;
    } catch {
      // Response without JSON (e.g. guard): uses the default message.
    }
    return tr("Couldn't reply (error {0}).", [res.status]);
  }

  /**
   * Saves the project's character (PUT /api/agents/:id/character). Returns undefined if it worked, or the error
   * message (name in use, access that is not local...).
   */
  async saveCharacter(id: string, body: { name: string; seed: number; parts: AppearanceParts }): Promise<string | undefined> {
    return this.characterRequest(id, 'PUT', body);
  }

  /** "Back to random": deletes the project's character (DELETE /api/agents/:id/character). */
  async resetCharacter(id: string): Promise<string | undefined> {
    return this.characterRequest(id, 'DELETE', {});
  }

  private async characterRequest(id: string, method: 'PUT' | 'DELETE', body: object): Promise<string | undefined> {
    if (this.mock || this.replay) return tr('Editing the character only works with the live office.');
    let res: Response;
    try {
      res = await fetch(`/api/agents/${encodeURIComponent(id)}/character`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return tr('No connection to Habblaud.');
    }
    if (res.ok) return undefined;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') return data.error;
    } catch {
      // Response without JSON (e.g. guard): uses the default message.
    }
    return tr("Couldn't save the character (error {0}).", [res.status]);
  }

  // ---------------------------------------------------------------- messages from the office

  /**
   * Sends a message to an agent (POST /api/messages): the created message (status `queued`) or the server's error
   * (agent that does not receive messages, full queue, access that is not local...). No connection to the server: throws.
   * In ?mock=1 the delivery is fake (the simulator puts the activity on the agent).
   */
  async sendMessage(agentId: string, text: string): Promise<{ message: OutboxMessage } | { error: string }> {
    if (this.mock) return this.mockSend(agentId, text);
    const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, text }) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Response without JSON (e.g. guard): uses the default message.
    }
    if (res.status === 201 && body && typeof body === 'object') return { message: body as OutboxMessage };
    const error = (body as { error?: unknown } | undefined)?.error;
    return { error: typeof error === 'string' ? error : tr('error {0}', [res.status]) };
  }

  /** State of a message (GET /api/messages/:id). null = the server does not know it (404). No connection: throws. */
  async messageStatus(id: string): Promise<OutboxMessage | null> {
    if (this.mock) {
      const m = this.mockOutbox.get(id);
      return m ? { ...m } : null;
    }
    const res = await fetch(`/api/messages/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(tr('error {0}', [res.status]));
    return (await res.json()) as OutboxMessage;
  }

  /** Messages of ?mock=1 (delivered by the simulator after ~1 s). */
  private mockOutbox = new Map<string, OutboxMessage>();
  private mockSeq = 0;

  private mockSend(agentId: string, text: string): { message: OutboxMessage } | { error: string } {
    const a = this.agent(agentId);
    if (!a) return { error: tr('unknown agent: has it already left the office?') };
    if (!a.canMessage || a.kind !== 'main' || a.status === 'offline') return { error: tr("this agent can't receive messages right now") };
    const now = Date.now();
    const msg: OutboxMessage = { id: `mock-${now.toString(36)}-${++this.mockSeq}`, agentId, status: 'queued', createdAt: now, updatedAt: now };
    this.mockOutbox.set(msg.id, msg);
    setTimeout(() => {
      const sim = this.mockSim;
      const ok = !!sim?.receiveMessage(agentId, text);
      Object.assign(msg, { status: ok ? 'delivered' : 'failed', updatedAt: Date.now() }, ok ? {} : { error: tr('the agent left the office') });
      if (ok && sim) this.applySnapshot(sim.snapshot());
    }, 1_000);
    return { message: { ...msg } };
  }

  // ---------------------------------------------------------------- internals

  private emit<K extends keyof StoreEvents>(event: K, value: StoreEvents[K]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(value);
      } catch (err) {
        console.error(`[store] listener for "${event}" failed`, err);
      }
    });
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit('connection', state);
  }

  private applySnapshot(snap: OfficeSnapshot): void {
    const cur = this.replay ? this.live?.snap : this.snapshot;
    if (cur && snap.rev < cur.rev && snap.meta.startedAt === cur.meta.startedAt) return;
    if (this.replay) this.live = { snap, at: Date.now() };
    else this.setSnapshot(snap);
    this.checkBuild(snap.meta.build);
  }

  private setSnapshot(snap: OfficeSnapshot): void {
    this.snapshot = snap;
    this.agentIndex = new Map(snap.agents.map((a) => [a.id, a]));
    this.roomIndex = new Map(snap.rooms.map((r) => [r.id, r]));
    this.emit('snapshot', snap);
  }

  private updateAnnounced = false;
  /** This page's build (see pageBuild); exposed for tests. */
  pageBuildId: string | undefined = pageBuild();

  /** Notifies (once) when the server has started serving another build of the client. */
  private checkBuild(serverBuild: string | undefined): void {
    if (this.updateAnnounced || this.mock || !serverBuild) return;
    const current = this.pageBuildId;
    if (!current || current === serverBuild) return;
    this.updateAnnounced = true;
    this.emit('update', { build: serverBuild, current });
  }

  private applyFeed(items: FeedItem[]): void {
    if (!items.length) return;
    const known = new Set(this.feed.map((f) => f.id));
    const fresh = items.filter((f) => !known.has(f.id));
    if (!fresh.length) return;
    this.feed = [...this.feed, ...fresh].slice(-FEED_LIMIT);
    this.emit('feed', fresh);
  }

  /** Reads the JSON of an SSE event; corrupted messages are ignored without bringing down the stream. */
  private parse<T>(ev: Event, what: string): T | null {
    try {
      return JSON.parse((ev as MessageEvent).data) as T;
    } catch (err) {
      console.warn(`[store] invalid ${what} ignored`, err);
      return null;
    }
  }

  private startSSE(): void {
    // Network back (Wi-Fi, VPN): does not wait for the next interval to reconnect.
    if (typeof addEventListener === 'function') addEventListener('online', this.onOnline);
    this.setConnection('connecting');
    let es: EventSourceLike;
    try {
      es = this.openStream('/api/stream');
    } catch (err) {
      console.error('[store] could not open the stream', err);
      this.setConnection('closed');
      this.scheduleRetry();
      return;
    }
    this.source = es;
    // Events from a stream that was already replaced (reconnection) no longer count.
    const current = () => this.source === es;
    es.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.clearRetry();
      this.setConnection('open');
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: the browser itself will try again. CLOSED: it gave up; the reconnection is up to us.
      if (es.readyState === ES_CLOSED) {
        this.setConnection('closed');
        this.scheduleRetry();
      } else {
        this.setConnection('connecting');
      }
    });
    es.addEventListener('snapshot', (ev) => {
      if (!current()) return;
      const snap = this.parse<OfficeSnapshot>(ev, 'snapshot');
      if (snap) this.applySnapshot(snap);
    });
    es.addEventListener('feed', (ev) => {
      if (!current()) return;
      const items = this.parse<FeedItem[]>(ev, 'feed');
      if (items) this.applyFeed(items);
    });
    es.addEventListener('notice', (ev) => {
      if (!current()) return;
      const n = this.parse<Notice>(ev, 'notice');
      if (n) this.emit('notice', n);
    });
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.mock || this.stopped) return;
    const delay = reconnectDelay(this.attempts);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.stopped && this.connection === 'closed') {
        this.closeSource();
        this.startSSE();
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  /** Simulator of the ?mock=1 mode (it also answers the fake permission requests). */
  private mockSim: DemoSimulator | null = null;

  private startMock(): void {
    if (this.mockTimer) return;
    this.setConnection('mock');
    const sim = new DemoSimulator(mockOptionsFrom(this.search));
    this.mockSim = sim;
    this.applySnapshot(sim.snapshot());
    this.mockTimer = setInterval(() => {
      const now = Date.now();
      const r = sim.tick(now);
      if (r.changed) this.applySnapshot(sim.snapshot(now));
      this.applyFeed(r.feed);
      r.notices.forEach((n) => this.emit('notice', n));
    }, 250);
  }
}
