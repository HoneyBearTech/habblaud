// Real-time streaming (Server-Sent Events) on GET /api/stream.
// Named events: snapshot | feed | notice (the `data` is the protocol JSON in shared/types.ts).
// Snapshots go out throttled (~200 ms); feed and notices go in a batch right after the snapshot.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OfficeSnapshot } from '../../shared/types';
import type { Office } from '../model/office';
import { isLoopbackHost } from './guard';

/** A client that is too slow (buffer piled up above this) is disconnected; the EventSource reconnects. */
const MAX_BUFFERED = 8 * 1024 * 1024;

export class Hub {
  private clients = new Set<ServerResponse>();
  /** Clients that opened the page through a local Host (the only ones that can answer permission requests). */
  private local = new WeakSet<ServerResponse>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastFlush = 0;
  private unsubscribe: (() => void) | null = null;
  private snapshotCbs = new Set<(snap: OfficeSnapshot) => void>();
  private readonly throttleMs: number;
  private readonly pingMs: number;
  /** Who can answer for the office; default: local Host. The remote port (http/remote.ts) changes the rule. */
  private readonly canAnswer: (req: IncomingMessage) => boolean;

  constructor(
    private readonly office: Office,
    opts: { throttleMs?: number; pingMs?: number; canAnswer?: (req: IncomingMessage) => boolean } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 200;
    this.pingMs = opts.pingMs ?? 15_000;
    this.canAnswer = opts.canAnswer ?? ((req) => isLoopbackHost(req.headers.host));
  }

  start(): void {
    this.unsubscribe = this.office.onChange(() => this.schedule());
    this.pinger = setInterval(() => this.writeAll(': ping\n\n'), this.pingMs);
    this.pinger.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Notified on each new snapshot streamed (e.g. the timeline recorder). */
  onSnapshot(cb: (snap: OfficeSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => void this.snapshotCbs.delete(cb);
  }

  /** Pages connected through a local Host (localhost/127.x): who can answer for the office. */
  get localSize(): number {
    let n = 0;
    for (const c of this.clients) if (this.local.has(c) && !c.destroyed && !c.writableEnded) n++;
    return n;
  }

  /** Connects a client: full snapshot + last 50 feed items, then the live stream. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const snapshot = this.current();
    res.write('retry: 2000\n\n');
    res.write(frame('snapshot', snapshot));
    res.write(frame('feed', this.office.recentFeed(50)));
    this.clients.add(res);
    if (this.canAnswer(req)) this.local.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /** Closes the revision now and streams whatever there is. Returns the current snapshot. */
  flush(): OfficeSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastFlush = Date.now();
    const r = this.office.commit();
    if (r.changed) {
      this.writeAll(frame('snapshot', r.snapshot));
      for (const cb of this.snapshotCbs) {
        try {
          cb(r.snapshot);
        } catch {
          // listeners don't get in the way of the stream
        }
      }
    }
    if (r.feed.length) this.writeAll(frame('feed', r.feed));
    for (const n of r.notices) this.writeAll(frame('notice', n));
    return r.snapshot;
  }

  /** Current snapshot (after streaming whatever is pending), with `serverTime` of now. */
  current(): OfficeSnapshot {
    return { ...this.flush(), serverTime: Date.now() };
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastFlush + this.throttleMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private writeAll(chunk: string): void {
    for (const c of this.clients) {
      if (c.destroyed || c.writableEnded) {
        this.clients.delete(c);
        continue;
      }
      if (c.writableLength > MAX_BUFFERED) {
        this.clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  }
}

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
