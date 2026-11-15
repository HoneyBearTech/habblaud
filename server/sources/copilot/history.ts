// Copilot CLI terminal history (the 'copilot' HistoryProvider, see sources/source.ts): the recent sessions of each
// Copilot folder (open or already ended), listed from session-state/<session>/events.jsonl modified in the last
// 7 days. From each file it reads only the start (session.start: project; the first prompt: the title) and the end
// (last activity), with cache while the mtime and the size don't change; the project comes from workspace.yaml when
// it has one.
import { statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { createCopilotState, isSessionId, parseEventLine } from './events';
import { EVENTS_FILE, listSessionIds, readWorkspace, sessionFile, SESSION_STATE_DIR } from './files';
import { createCopilotTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Start of each events file where the session.start and the first prompt are looked for. */
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
/** Longest end line parsed for its time (a longer one is skipped, not parsed). */
const LINE_MAX = 16 * 1024;
const READ_CONCURRENCY = 8;

export interface CopilotHistoryAccount {
  id: string;
  /** Copilot folder read by this process (in Docker, the mounted one). */
  dir: string;
}

export interface CopilotHistoryOptions {
  accounts: () => readonly CopilotHistoryAccount[];
  /** Main agent of the session, if it is still open in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

/** What the start and the end of the events file say about the session. */
export interface EventsSummary {
  cwd?: string;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  dir: string;
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export class CopilotHistory implements HistoryProvider {
  readonly provider = 'copilot' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: EventsSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: CopilotHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) all.push(...(await this.candidates(acc, now)));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const summaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const s = summaries[i];
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      if (!agentId && s.firstAt === undefined && s.lastAt === undefined) return;
      const cwd = readWorkspace(c.dir, c.sessionId).cwd ?? s.cwd;
      const r: RecentSession = {
        account: c.account,
        provider: 'copilot',
        sessionId: c.sessionId,
        projectDir: cwd ? encodeCwd(cwd) : SESSION_STATE_DIR,
        lastAt: s.lastAt ?? c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (cwd) r.project = cwd;
      if (s.title) r.title = s.title;
      if (s.firstAt !== undefined) r.firstAt = s.firstAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Events file of the account's session `sessionId`, validated: known account, id in UUID format and the file
   * (with links resolved) inside the account's folder.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isSessionId(sessionId)) return { status: 400, error: tr('invalid session id') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('unknown account') };
    const name = listSessionIds(acc.dir).find((n) => n.toLowerCase() === sessionId.toLowerCase());
    const path = name ? sessionFile(acc.dir, name, EVENTS_FILE) : undefined;
    if (!path) return { status: 404, error: tr('session not found') };
    return { path, createParser: createCopilotTerminalParser };
  }

  /** Events files modified within the window. */
  private async candidates(acc: CopilotHistoryAccount, now: number): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const id of listSessionIds(acc.dir)) {
      // Only the checked path is stat-ed: a link out of the Copilot folder is never followed.
      const path = sessionFile(acc.dir, id, EVENTS_FILE);
      if (!path) continue;
      try {
        const st = await stat(path);
        if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
        out.push({ account: acc.id, dir: acc.dir, sessionId: id, path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // folder without events.jsonl
      }
    }
    return out;
  }

  private async summaryOf(c: Candidate): Promise<EventsSummary> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary;
    let summary: EventsSummary;
    try {
      // The file must stay inside the Copilot folder (a link pointing outside won't do).
      const real = sessionFile(c.dir, c.sessionId, EVENTS_FILE);
      summary = real ? await readEventsSummary(real, statSync(real).size) : {};
    } catch (err) {
      log.warnOnce(`copilot-history:${errMsg(err)}`, tr('Copilot history: unreadable events file ({0}).', [errMsg(err)]));
      summary = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

/** Reads the start and the end of the events file (of size `size`): project, first prompt and times. */
export async function readEventsSummary(path: string, size: number): Promise<EventsSummary> {
  const fh = await open(path, 'r');
  try {
    const read = async (start: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    };
    const summary: EventsSummary = {};
    const state = createCopilotState();
    const ctx = { idPrefix: '', now: 0, activities: false };
    const head = (await read(0, HEAD_BYTES)).toString('utf8').split('\n');
    if (HEAD_BYTES < size) head.pop(); // cut
    for (const line of head) {
      if (!line.trim()) continue;
      parseEventLine(state, line, ctx);
      if (state.title !== undefined && state.cwd !== undefined) break;
    }
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = (await read(tailStart, TAIL_BYTES)).toString('utf8').split('\n');
    if (tailStart > 0) tail.shift(); // cut
    for (const line of tail) {
      const ms = lineTime(line);
      if (ms !== undefined && (summary.lastAt === undefined || ms > summary.lastAt)) summary.lastAt = ms;
    }
    const first = state.startedAt ?? state.firstAt;
    if (first !== undefined) summary.firstAt = first;
    if (summary.lastAt === undefined && state.lastAt !== undefined) summary.lastAt = state.lastAt;
    if (state.title) summary.title = state.title;
    if (state.cwd) summary.cwd = state.cwd;
    return summary;
  } finally {
    await fh.close();
  }
}

/** The top-level `timestamp` of an events line (never one nested in `data`); undefined = none, invalid or too long. */
export function lineTime(line: string): number | undefined {
  if (!line.trim() || line.length > LINE_MAX) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const at = (j as Record<string, unknown>).timestamp;
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** Async map() with at most `limit` tasks at the same time (keeps the order). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
