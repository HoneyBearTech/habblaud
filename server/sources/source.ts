// Agent sources (one per tool: Claude Code, Codex...) and what the rest of the server expects from them.
//
// Each source watches the OPEN sessions of its tool and feeds the Office (addMain, addActivity...). The
// server connects them all through a SourceSet: the snapshot (meta.sources), /api/health, the terminal and the
// path of an agent's transcript go through it, without knowing which tool the agent comes from. Today only the
// Claude Code one exists (sources/watcher.ts, ClaudeWatcher); the Codex one comes in through the same contract.
//
// Terminal history (recent sessions, open or ended): one HistoryProvider per tool, together in a
// HistorySet that serves the /api/sessions/* routes. The Claude Code one is SessionHistory (sources/history.ts).
//
// Boot: the source that rebuilds the open sessions when it starts calls office.beginBoot() before and
// office.endBoot() after, ALWAYS as a pair (in a `finally`, including in an asynchronous boot). The Office counts
// the boots: while some source is booting there are no notices and the feed is held to come out in chronological
// order at the end of the last boot (a source that never called endBoot would silence everyone's notices).
import type { Provider, RecentSession, SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { HISTORY_LIMIT } from './history';
import { createTerminalParser, type TerminalParser } from './terminal';
import { tr } from '../../shared/i18n';

/** An agent source: watches the open sessions of a tool and feeds the Office. */
export interface AgentSource {
  readonly provider: Provider;
  /**
   * Boot (rebuilds the open sessions, between office.beginBoot/endBoot) and the live tracking. A synchronous
   * source finishes the boot before returning; an asynchronous one returns the promise (failures only go to the log).
   */
  start(): void | Promise<void>;
  stop(): void;
  /** One entry per watched account (the snapshot's meta.sources and /api/health). */
  sources(): SourceInfo[];
  /** Conversation file of a present agent of this source; undefined if the agent is not its (or has no file yet). */
  transcriptPathOf(agentId: string): string | undefined;
  /**
   * Terminal parser for the conversation of an agent of this source: a NEW one on each call (parsers keep state).
   * Absent, or undefined, = the Claude Code one (createTerminalParser).
   */
  terminalParser?(agentId: string): TerminalParser | undefined;
}

/** All the connected agent sources, seen as one. */
export class SourceSet {
  private readonly list: AgentSource[] = [];

  constructor(sources: readonly AgentSource[] = []) {
    for (const s of sources) this.add(s);
  }

  /** Adds a source (before start()). */
  add(source: AgentSource): void {
    this.list.push(source);
  }

  all(): readonly AgentSource[] {
    return this.list;
  }

  /** The source of a tool, if it is connected. */
  of(provider: Provider): AgentSource | undefined {
    return this.list.find((s) => s.provider === provider);
  }

  /**
   * Starts the sources in the order they came in: the synchronous ones finish the boot right here (before the hub
   * starts broadcasting). The failure of one does not stop the others: it goes to the log. The promise resolves
   * when the asynchronous ones finish starting.
   */
  start(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const s of this.list) {
      const failed = (err: unknown) => log.error(tr('Agent source {0}: failed to start ({1}).', [s.provider, errMsg(err)]));
      try {
        const r = s.start();
        if (r) pending.push(r.catch(failed));
      } catch (err) {
        failed(err);
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  stop(): void {
    for (const s of this.list) {
      try {
        s.stop();
      } catch (err) {
        log.warn(tr('Agent source {0}: failed to stop ({1}).', [s.provider, errMsg(err)]));
      }
    }
  }

  sources(): SourceInfo[] {
    return this.list.flatMap((s) => s.sources());
  }

  /** Conversation file of a present agent (the first source that knows it). */
  transcriptPathOf(agentId: string): string | undefined {
    for (const s of this.list) {
      const path = s.transcriptPathOf(agentId);
      if (path) return path;
    }
    return undefined;
  }

  /**
   * NEW parser for an agent's terminal: the one from the source that knows its transcript (transcriptPathOf); with
   * no source, or if it does not have one of its own, the Claude Code one.
   */
  parserFor(agentId: string): TerminalParser {
    const owner = this.list.find((s) => s.transcriptPathOf(agentId) !== undefined);
    return owner?.terminalParser?.(agentId) ?? createTerminalParser();
  }
}

// ------------------------------------------------------------------ terminal history

/** History session found: the conversation file and the terminal parser for it. */
export interface HistorySession {
  path: string;
  /** NEW parser on each call (the terminal creates another one when the file is truncated or replaced). */
  createParser: () => TerminalParser;
}

/** Result of resolve(): the session or the HTTP error. */
export type HistoryResolveResult = HistorySession | { status: 400 | 404; error: string };

/** What the /api/sessions/* routes need: a single provider or the HistorySet. */
export interface SessionLookup {
  /** Recent sessions, from the most recent activity to the oldest. */
  list(): Promise<RecentSession[]>;
  /**
   * Validates and finds the account's session `sessionId` (no path traversal). Never throws: 400 = invalid id,
   * 404 = unknown account or session.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult;
}

/** History of one tool: the recent sessions of its accounts. */
export interface HistoryProvider extends SessionLookup {
  readonly provider: Provider;
  /** The account belongs to this provider (the HistorySet sends its resolve() here). */
  hasAccount(account: string): boolean;
}

/**
 * Joins the history of all the tools: everyone's listing (from the most recent activity to the oldest,
 * up to `limit`) and each session resolved by the account's provider. An account that no provider knows goes to
 * the first one (the Claude Code one), which gives the usual error (400 for an invalid id, otherwise 404).
 */
export class HistorySet implements SessionLookup {
  private readonly list_: HistoryProvider[] = [];

  constructor(
    providers: readonly HistoryProvider[] = [],
    private readonly limit = HISTORY_LIMIT,
  ) {
    for (const p of providers) this.add(p);
  }

  add(provider: HistoryProvider): void {
    this.list_.push(provider);
  }

  /** A failing provider does not take down the others' listing (only goes to the log); if all fail, the failure rises. */
  async list(): Promise<RecentSession[]> {
    const results = await Promise.allSettled(this.list_.map((p) => p.list()));
    const out: RecentSession[] = [];
    const failures: Array<{ provider: Provider; err: unknown }> = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(...r.value);
      else failures.push({ provider: this.list_[i].provider, err: r.reason });
    });
    if (failures.length && failures.length === results.length) throw failures[0].err;
    for (const f of failures) {
      log.warnOnce(`history-list:${f.provider}:${errMsg(f.err)}`, tr('Session history ({0}): failed to list ({1}).', [f.provider, errMsg(f.err)]));
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const owner = this.list_.find((p) => p.hasAccount(account)) ?? this.list_[0];
    return owner ? owner.resolve(account, sessionId) : { status: 404, error: tr('unknown account') };
  }
}
