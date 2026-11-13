// Terminal (Server-Sent Events) on GET /api/agents/:id/terminal: the session's conversation
// (prompts, answers, tools and results) rebuilt from the JSONL transcript by sources/terminal.ts.
// Named events: init | append (the `data` is that of TerminalMessage in shared/types.ts). The route
// (http/app.ts) already checked that the feature is on and that the access is local.
//
// Each connection has its own FileTail and its own parser (the one of the agent's tool: SourceSet.parserFor;
// Claude Code's by default): on connect, it reads the end of the transcript (≈4 MB, last 500 entries) and sends
// `init`; after that, ~400 ms polling sends `append` with whatever is new.
// Transcript truncated/replaced (or swapped by /clear in the same process) = new parser and `init`
// again. Demo agents have no transcript: the fictional conversation comes from demoTerminalEntries every ~500 ms.
// History sessions (GET /api/sessions/:conta/:sessionId/terminal, http/sessions.ts) use the same
// reader over the transcript already validated by the route, with more widely spaced polling (~2 s).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { demoTerminalEntries } from '../../shared/demo/terminal';
import type { Activity, AgentInfo, TerminalEntry, TerminalInit } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import { FileTail } from '../sources/tail';
import { createTerminalParser, type TerminalParser } from '../sources/terminal';
import { sendJson } from './app';
import { frame } from './sse';
import { tr } from '../../shared/i18n';

/** Terminals open at the same time (each one reads the transcript on its own). */
export const MAX_STREAMS = 8;
/** How much of the end of the transcript is read for the `init`. */
export const INIT_TAIL_BYTES = 4 * 1024 * 1024;
/** Entries sent in the `init` (the most recent ones). */
export const INIT_ENTRIES = 500;
export const POLL_MS = 400;
export const DEMO_POLL_MS = 500;
/** History session: almost always ended (the polling only catches a resume with /resume). */
export const SESSION_POLL_MS = 2_000;
const PING_MS = 15_000;
/** A client that is too slow (buffer piled up above this) is disconnected; the EventSource reconnects. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** Reads (of up to 8 MB each) per polling cycle: the rest is left for the next one. */
const READS_PER_POLL = 4;
const MAX_INIT_READS = 64;
/** Prefix of the demo agents' ids (see Office.setDemo). */
const DEMO_PREFIX = 'demo:';

export interface TerminalOptions {
  office: Office;
  /** Transcript path of a real agent (SourceSet.transcriptPathOf). */
  transcriptPathOf: (agentId: string) => string | undefined;
  /**
   * Parser of a real agent's conversation (SourceSet.parserFor): a NEW one on each call. Absent, or undefined,
   * = createParser.
   */
  parserFor?: (agentId: string) => TerminalParser | undefined;
  /** Factory of the default parser (tests); default: createTerminalParser (Claude Code's). */
  createParser?: () => TerminalParser;
  /** Fictional conversation of the demo agents (tests); default: demoTerminalEntries. */
  demoEntries?: (agent: AgentInfo, history: Activity[]) => TerminalEntry[];
  maxStreams?: number;
  initTailBytes?: number;
  initEntries?: number;
  pollMs?: number;
  demoPollMs?: number;
  sessionPollMs?: number;
  pingMs?: number;
}

/** What changed since the last cycle: `init` replaces everything; `stop` = there is nothing left to follow. */
interface PollResult {
  init?: TerminalInit;
  append?: TerminalEntry[];
  stop?: boolean;
}

/** Where a connection's conversation comes from. */
interface ConversationSource {
  readonly intervalMs: number;
  /** Recent conversation, for the `init`. */
  load(): TerminalInit;
  poll(): PollResult;
}

/** Runs the lines through the parser; a line that makes it fail is skipped without losing the rest of the batch. */
function parseInto(parser: TerminalParser, lines: readonly string[], out: TerminalEntry[]): void {
  for (const line of lines) {
    let entries: TerminalEntry[];
    try {
      entries = parser.push(line);
    } catch (err) {
      log.warnOnce(`terminal-parse:${errMsg(err)}`, tr('Terminal: transcript line ignored ({0}).', [errMsg(err)]));
      continue;
    }
    for (const e of entries) out.push(e);
  }
}

/**
 * Real agent (or history session): reads the JSONL transcript with its own FileTail. `transcriptPathOf`
 * reports the main agent's change of transcript (/clear); in a history session it never changes.
 */
class TranscriptSource implements ConversationSource {
  private tail: FileTail;
  /** Created in load(), which always runs before the first poll(). */
  private parser!: TerminalParser;

  constructor(
    private readonly agentId: string,
    path: string,
    private readonly o: Required<Pick<TerminalOptions, 'transcriptPathOf' | 'createParser' | 'initTailBytes' | 'initEntries'>>,
    readonly intervalMs: number,
  ) {
    this.tail = new FileTail(path);
  }

  load(): TerminalInit {
    this.parser = this.o.createParser();
    const offset = this.tail.seekTail(this.o.initTailBytes);
    const keep = this.o.initEntries;
    let entries: TerminalEntry[] = [];
    let dropped = false;
    for (let i = 0; i < MAX_INIT_READS; i++) {
      const r = this.tail.read();
      parseInto(this.parser, r.lines, entries);
      // Drops the excess along the way (transcript with many small entries).
      if (entries.length > keep * 2) {
        entries = entries.slice(-keep);
        dropped = true;
      }
      if (!r.more) break;
    }
    if (entries.length > keep) {
      entries = entries.slice(-keep);
      dropped = true;
    }
    return { agentId: this.agentId, entries, truncated: offset > 0 || dropped };
  }

  poll(): PollResult {
    // /clear or /resume in the same process: the main agent stays the same, the transcript is another one.
    const path = this.o.transcriptPathOf(this.agentId);
    if (path && path !== this.tail.path) {
      this.tail = new FileTail(path);
      return { init: this.load() };
    }
    const fresh: TerminalEntry[] = [];
    for (let i = 0; i < READS_PER_POLL; i++) {
      // File gone: `missing`, no lines; it keeps trying on the next cycles.
      const r = this.tail.read();
      if (r.reset) return { init: this.load() };
      parseInto(this.parser, r.lines, fresh);
      if (!r.more) break;
    }
    return { append: fresh };
  }
}

/** Demo agent: fictional conversation built from the title and the simulated activities. */
class DemoSource implements ConversationSource {
  /** Ids of the last generated list (what the client already has). */
  private sent = new Set<string>();

  constructor(
    private readonly agentId: string,
    private readonly o: { office: Office; demoEntries: NonNullable<TerminalOptions['demoEntries']>; initEntries: number },
    readonly intervalMs: number,
  ) {}

  private list(): TerminalEntry[] | undefined {
    const d = this.o.office.detail(this.agentId);
    return d ? this.o.demoEntries(d.agent, d.history) : undefined;
  }

  load(): TerminalInit {
    const all = this.list() ?? [];
    this.sent = new Set(all.map((e) => e.id));
    const entries = all.slice(-this.o.initEntries);
    return { agentId: this.agentId, entries, truncated: entries.length < all.length };
  }

  poll(): PollResult {
    const all = this.list();
    if (!all) return { stop: true };
    const fresh = all.filter((e) => !this.sent.has(e.id));
    this.sent = new Set(all.map((e) => e.id));
    return { append: fresh };
  }
}

interface Stream {
  res: ServerResponse;
  timer: ReturnType<typeof setInterval> | null;
}

export class TerminalStreams {
  private streams = new Set<Stream>();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private readonly createParser: () => TerminalParser;
  private readonly demoEntries: NonNullable<TerminalOptions['demoEntries']>;
  private readonly maxStreams: number;
  private readonly initTailBytes: number;
  private readonly initEntries: number;
  private readonly pollMs: number;
  private readonly demoPollMs: number;
  private readonly sessionPollMs: number;
  private readonly pingMs: number;

  constructor(private readonly opts: TerminalOptions) {
    this.createParser = opts.createParser ?? createTerminalParser;
    this.demoEntries = opts.demoEntries ?? demoTerminalEntries;
    this.maxStreams = opts.maxStreams ?? MAX_STREAMS;
    this.initTailBytes = opts.initTailBytes ?? INIT_TAIL_BYTES;
    this.initEntries = opts.initEntries ?? INIT_ENTRIES;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.demoPollMs = opts.demoPollMs ?? DEMO_POLL_MS;
    this.sessionPollMs = opts.sessionPollMs ?? SESSION_POLL_MS;
    this.pingMs = opts.pingMs ?? PING_MS;
  }

  get size(): number {
    return this.streams.size;
  }

  stop(): void {
    for (const s of [...this.streams]) {
      this.drop(s);
      s.res.end();
    }
  }

  /**
   * Opens an agent's terminal: `init` with the recent conversation, then `append` with the news.
   * Before the stream, errors answer JSON `{error}`: 404 (unknown agent or transcript),
   * 429 (too many open terminals) or 500 (unreadable transcript).
   */
  attach(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const source = this.sourceFor(agentId);
    if (typeof source === 'string') return sendJson(res, 404, { error: source });
    this.serve(req, res, agentId, source);
  }

  /**
   * Opens the conversation of a history session by the transcript `path` (the route already validated account, id
   * and path). `streamId` goes in the `init` (e.g. "session:<conta>:<sessionId>"); `createParser` is the one of
   * the session's tool (HistorySession.createParser; default: Claude Code's). Same errors as attach (429/500).
   */
  attachSession(req: IncomingMessage, res: ServerResponse, streamId: string, path: string, createParser?: () => TerminalParser): void {
    const o = { transcriptPathOf: () => undefined, createParser: createParser ?? this.createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries };
    this.serve(req, res, streamId, new TranscriptSource(streamId, path, o, this.sessionPollMs));
  }

  /** Terminal limit, `init` and the SSE stream of a source already chosen. */
  private serve(req: IncomingMessage, res: ServerResponse, id: string, source: ConversationSource): void {
    if (this.streams.size >= this.maxStreams) {
      return sendJson(res, 429, { error: tr('too many open terminals (max {0}); close one and try again', [this.maxStreams]) });
    }
    let init: TerminalInit;
    try {
      init = source.load();
    } catch (err) {
      log.warnOnce(`terminal-load:${id}:${errMsg(err)}`, tr("Terminal for {0}: couldn't read the transcript ({1}).", [id, errMsg(err)]));
      return sendJson(res, 500, { error: tr("couldn't read the transcript") });
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const s: Stream = { res, timer: null };
    this.streams.add(s);
    this.write(s, frame('init', init));
    s.timer = setInterval(() => this.pump(s, source, id), source.intervalMs);
    s.timer.unref?.();
    const drop = () => this.drop(s);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of [...this.streams]) this.write(c, ': ping\n\n');
      }, this.pingMs);
      this.pinger.unref?.();
    }
  }

  /** Source of the agent's conversation, or the message of the 404. */
  private sourceFor(agentId: string): ConversationSource | string {
    const office = this.opts.office;
    if (office.has(agentId)) {
      const path = this.opts.transcriptPathOf(agentId);
      if (!path) return tr('agent transcript not found');
      const parserFor = this.opts.parserFor;
      const createParser = parserFor ? () => parserFor(agentId) ?? this.createParser() : this.createParser;
      const o = { transcriptPathOf: this.opts.transcriptPathOf, createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries };
      return new TranscriptSource(agentId, path, o, this.pollMs);
    }
    // The demo agents are not among the Office's real ones, but office.detail finds them.
    if (agentId.startsWith(DEMO_PREFIX) && office.detail(agentId)) {
      return new DemoSource(agentId, { office, demoEntries: this.demoEntries, initEntries: this.initEntries }, this.demoPollMs);
    }
    return tr('agent not found');
  }

  private pump(s: Stream, source: ConversationSource, agentId: string): void {
    let r: PollResult;
    try {
      r = source.poll();
    } catch (err) {
      // E.g.: transcript without read permission. Tries again on the next cycle.
      log.warnOnce(`terminal:${agentId}:${errMsg(err)}`, tr('Terminal for {0}: {1}', [agentId, errMsg(err)]));
      return;
    }
    if (r.init) this.write(s, frame('init', r.init));
    if (r.append?.length) this.write(s, frame('append', r.append));
    // The agent is gone (demo turned off or simulated session ended): the stream stays open with pings only.
    if (r.stop && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  private write(s: Stream, chunk: string): void {
    const res = s.res;
    if (res.destroyed || res.writableEnded) return this.drop(s);
    if (res.writableLength > MAX_BUFFERED) {
      this.drop(s);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  private drop(s: Stream): void {
    if (!this.streams.delete(s)) return;
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    if (!this.streams.size && this.pinger) {
      clearInterval(this.pinger);
      this.pinger = null;
    }
  }
}
