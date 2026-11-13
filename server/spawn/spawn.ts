// New agent from the office. The way that runs on its own: a Claude Code background session
// (`claude --bg -n <nome> -- <pedido>`, in the chosen folder), which starts right away, appears in the office like
// any session and receives messages and permission requests through Habblaud (`claude attach <id>` opens it in the
// Mac terminal). Claude Code only does this in a folder it already trusts (the trust notice was accepted in the
// terminal); if the folder is not, or `claude` is not here, it falls back to the link
// `claude://code/new?folder=<pasta>&q=<pedido>` (the one from Finder's "New Claude Code Session Here"), which opens
// the app's new session screen filled in: then it starts when the person presses Enter there. Whoever runs it
// must be on the app's computer:
// - Node mode: the server itself;
// - Docker: the host helper (scripts/codex-bridge.ts, npm run codex:bridge) fetches the requests at
//   POST /api/host/spawn/poll, checks the folder, runs and confirms at POST /api/host/spawn/ack.
// Attachments (spawn/attachments.ts): whoever runs it writes the files to ~/.habblaud/attachments/ and puts the
// paths at the end of the request. No shell (execFile), with a timeout, and the request goes after `--` (it never
// becomes an option or a subcommand).
// Plain Node with no dependencies: it is also imported by the host helper (via tsx).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { tr } from '../../shared/i18n';
import { attachmentsRoot, promptWithAttachments, writeAttachments, type Attachment, type AttachmentStore } from './attachments';

/** Maximum size of the request (the whole link goes through the command line of `open`). */
export const PROMPT_MAX = 8_000;
export const FOLDER_MAX = 1_024;
/** Timeout of `open`. */
export const OPEN_TIMEOUT_MS = 10_000;
/** Timeout of `claude --bg` (it starts the background service the first time and returns). */
export const CLI_TIMEOUT_MS = 30_000;
const NAME_MAX = 48;
/** The helper counts as present until this long after the last round. */
export const HOST_PRESENCE_MS = 10_000;
/**
 * A request fetched and not confirmed becomes a failure; a request nobody fetched too. Whoever runs it may take the
 * `claude --bg` plus the `open` (CLI_TIMEOUT_MS + OPEN_TIMEOUT_MS): the "fetched" timeout covers both with slack, and
 * the page waits longer than the sum of the two timeouts (client/src/ui/spawn.ts), so it never says "didn't confirm"
 * about something that still opens.
 */
export const SENT_TIMEOUT_MS = CLI_TIMEOUT_MS + OPEN_TIMEOUT_MS + 10_000;
export const QUEUED_TIMEOUT_MS = 30_000;
/** Resolved requests stay this long for the GET. */
export const KEEP_MS = 10 * 60_000;
const MAX_OPEN = 5;
const ERROR_MAX = 300;

export interface SpawnRequest {
  folder: string;
  prompt: string;
}

export type SpawnStatus = 'queued' | 'sent' | 'opened' | 'failed';

/** How it opened: `cli` = already running in the background; `app` = app screen filled in, waiting for Enter on the Mac. */
export type SpawnHow = 'cli' | 'app';

export interface SpawnInfo {
  id: string;
  folder: string;
  status: SpawnStatus;
  error?: string;
  how?: SpawnHow;
  /** With how `app` after trying `claude --bg`: why it did not run on its own. */
  note?: string;
}

export type OpenResult = { ok: true } | { ok: false; error: string };
export type Opener = (url: string) => Promise<OpenResult>;
export type CliResult = { ok: true; id: string } | { ok: false; error: string };
/** Runs the request as a Claude Code background session. */
export type CliRunner = (req: SpawnRequest) => Promise<CliResult>;
export type LaunchResult = { ok: true; how: SpawnHow; note?: string } | { ok: false; error: string };

/** Checks the body of POST /api/spawn; returns the request or the reason for the refusal. */
export function parseSpawn(raw: unknown): SpawnRequest | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const folder = typeof r.folder === 'string' ? r.folder.trim() : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt.replace(/\s+$/, '') : '';
  if (!folder || folder.length > FOLDER_MAX || folder.includes('\0') || !(isAbsolute(folder) || /^[A-Za-z]:[\\/]/.test(folder))) {
    return { error: tr('choose a folder (absolute path, e.g. /Users/you/project)') };
  }
  if (prompt.length > PROMPT_MAX || prompt.includes('\0')) return { error: tr('the request exceeds {0} characters', [PROMPT_MAX]) };
  return { folder, prompt };
}

/** The link the Claude app understands (claude://code/new; `q` = request already written). */
export function spawnUrl(req: SpawnRequest): string {
  const q = new URLSearchParams();
  q.set('folder', req.folder);
  if (req.prompt.trim()) q.set('q', req.prompt);
  q.set('source', 'habblaud');
  return `claude://code/new?${q.toString().replace(/\+/g, '%20')}`;
}

/** Name of the background session: "Habblaud: " + start of the 1st line of the request. */
export function sessionName(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cut = line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line;
  return cut ? `Habblaud: ${cut}` : 'Habblaud';
}

/** Arguments of `claude`: the request after `--` (a request "doctor" or "-x" is still a request). */
export function cliArgs(req: SpawnRequest): string[] {
  const args = ['--bg', '-n', sessionName(req.prompt)];
  return req.prompt.trim() ? [...args, '--', req.prompt] : args;
}

/** `claude --bg` in the request's folder; returns the short id it prints ("backgrounded · 7eacc670 · name"). */
export function createCliRunner(bin: string, timeoutMs = CLI_TIMEOUT_MS): CliRunner {
  return (req) =>
    new Promise((ok) => {
      const child = execFile(bin, cliArgs(req), { cwd: req.folder, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, out, stderr) => {
        const id = /backgrounded\s*·\s*([\w-]+)/.exec(out ?? '')?.[1];
        if (!err && id) return ok({ ok: true, id });
        const line = [stderr, out, err?.message].map((t) => (t ?? '').split('\n').map((l) => l.trim()).find(Boolean)).find(Boolean);
        ok({ ok: false, error: (line ?? tr("claude didn't start the session")).slice(0, ERROR_MAX) });
      });
      child.stdin?.end();
    });
}

/** Sentence for the screen when `claude --bg` did not run. */
export function cliNote(error: string): string {
  return /not trusted/i.test(error)
    ? tr("the folder isn't trusted by Claude Code yet: run `claude` in it once on the computer and accept the warning")
    : error;
}

/** Runs in the background; if that does not work, opens the app screen filled in (and says why). */
export async function launch(req: SpawnRequest, open: Opener, cli?: CliRunner): Promise<LaunchResult> {
  let note: string | undefined;
  if (cli) {
    const r = await cli(req).catch((err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) }));
    if (r.ok) return { ok: true, how: 'cli' };
    note = cliNote(r.error);
  }
  const o = await open(spawnUrl(req)).catch(() => ({ ok: false as const, error: tr("couldn't open the app") }));
  if (!o.ok) return note ? { ok: false, error: tr("{0}; and the app didn't open ({1})", [note, o.error]).slice(0, ERROR_MAX) } : o;
  return note ? { ok: true, how: 'app', note } : { ok: true, how: 'app' };
}

/** The folder exists on this computer (the helper checks before opening; Docker cannot see the host's folders). */
export function folderProblem(folder: string, stat: (p: string) => { isDirectory(): boolean } = statSync): string | undefined {
  try {
    return stat(folder).isDirectory() ? undefined : tr('not a folder');
  } catch {
    return tr('folder not found on this computer');
  }
}

/** `open`/`xdg-open`/`start` without a shell. */
export function createOpener(platform: NodeJS.Platform = process.platform, timeoutMs = OPEN_TIMEOUT_MS): Opener {
  const [bin, pre] = platform === 'darwin' ? ['open', []] : platform === 'win32' ? ['cmd', ['/c', 'start', '""']] : ['xdg-open', []];
  return (url) =>
    new Promise((ok) => {
      execFile(bin, [...pre, url], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) => {
        if (!err) return ok({ ok: true });
        const line = (stderr || err.message || '').split('\n').find((l) => l.trim()) ?? tr('failed');
        ok({ ok: false, error: `${bin}: ${line.trim()}`.slice(0, ERROR_MAX) });
      });
    });
}

interface Entry {
  info: SpawnInfo;
  req: SpawnRequest;
  files: Attachment[];
  at: number;
}

/** A request for the host helper, with the attachments in base64. */
export interface PolledSpawn extends SpawnRequest {
  id: string;
  files: Array<{ name: string; type: string; data: string }>;
}

export interface SpawnServiceOptions {
  /** Node mode: opens right here. Absent (Docker): stays in the queue for the host helper. */
  opener?: Opener;
  /** Node mode: runs in the background before falling back to the app (absent = only the app). */
  cli?: CliRunner;
  /** Checks the folder before opening in direct mode (default: statSync). */
  folderProblem?: (folder: string) => string | undefined;
  /** Attachments sent before the request (POST /api/spawn/attachments); absent = requests without attachments. */
  attachments?: AttachmentStore;
  /** Direct mode: writes the attachments and returns the paths (default: ~/.habblaud/attachments/). */
  writeFiles?: (spawnId: string, files: readonly Attachment[]) => string[];
  now?: () => number;
  newId?: () => string;
}

export type SpawnSubmit = { spawn: SpawnInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

export class SpawnService {
  private readonly entries = new Map<string, Entry>();
  private hostSeenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: SpawnServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** It can open now: direct mode, or the host helper came by a short while ago. */
  available(): boolean {
    return !!this.opts.opener || this.now() - this.hostSeenAt <= HOST_PRESENCE_MS;
  }

  mode(): 'direct' | 'host' {
    return this.opts.opener ? 'direct' : 'host';
  }

  submit(raw: unknown): SpawnSubmit {
    this.prune();
    const req = parseSpawn(raw);
    if ('error' in req) return { error: 'invalid', reason: req.error };
    if (!this.available()) {
      return { error: 'unavailable', reason: tr("the computer's helper isn't running: keep npm run codex:bridge running (Habblaud is in Docker)") };
    }
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('there are already {0} new agents waiting to open', [MAX_OPEN]) };
    const ids = raw && typeof raw === 'object' ? (raw as { attachments?: unknown }).attachments : undefined;
    let files: Attachment[] = [];
    if (ids !== undefined && !(Array.isArray(ids) && !ids.length)) {
      if (!this.opts.attachments) return { error: 'invalid', reason: tr('attachments disabled') };
      const taken = this.opts.attachments.take(ids);
      if ('error' in taken) return { error: 'invalid', reason: taken.error };
      files = taken;
    }
    const info: SpawnInfo = { id: this.opts.newId?.() ?? randomUUID(), folder: req.folder, status: 'queued' };
    const entry: Entry = { info, req, files, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.opener) void this.openDirect(entry, this.opts.opener);
    return { spawn: { ...info } };
  }

  get(id: string): SpawnInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Helper round: marks presence and hands over the queued requests (it builds the link: it does not open one from outside). */
  poll(): PolledSpawn[] {
    this.hostSeenAt = this.now();
    this.prune();
    const out: PolledSpawn[] = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued') continue;
      e.info.status = 'sent';
      e.at = this.now();
      const files = e.files.map((f) => ({ name: f.name, type: f.type, data: f.data.toString('base64') }));
      this.dropFiles(e);
      out.push({ id: e.info.id, folder: e.req.folder, prompt: e.req.prompt, files });
    }
    return out;
  }

  ack(raw: unknown): void {
    this.hostSeenAt = this.now();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      const how: SpawnHow = x.how === 'cli' ? 'cli' : 'app';
      const note = typeof x.note === 'string' && x.note ? x.note.slice(0, ERROR_MAX) : undefined;
      this.resolve(
        e,
        x.ok === true ? { ok: true, how, ...(note ? { note } : {}) } : { ok: false, error: typeof x.error === 'string' && x.error ? x.error.slice(0, ERROR_MAX) : tr("the helper didn't open the app") },
      );
    }
  }

  private async openDirect(e: Entry, opener: Opener): Promise<void> {
    e.info.status = 'sent';
    const problem = (this.opts.folderProblem ?? folderProblem)(e.req.folder);
    if (problem) return this.resolve(e, { ok: false, error: problem });
    let paths: string[];
    try {
      paths = (this.opts.writeFiles ?? ((id, files) => writeAttachments(attachmentsRoot(), id, files)))(e.info.id, e.files);
    } catch (err) {
      return this.resolve(e, { ok: false, error: tr("couldn't save the attachments ({0})", [(err as Error).message]).slice(0, ERROR_MAX) });
    } finally {
      this.dropFiles(e);
    }
    const req = { folder: e.req.folder, prompt: promptWithAttachments(e.req.prompt, paths) };
    this.resolve(e, await launch(req, opener, this.opts.cli));
  }

  /** The request's attachments leave memory (and the AttachmentStore cap). */
  private dropFiles(e: Entry): void {
    this.opts.attachments?.release(e.files.reduce((n, f) => n + f.data.length, 0));
    e.files = [];
  }

  private resolve(e: Entry, r: OpenResult | LaunchResult): void {
    this.dropFiles(e);
    e.info.status = r.ok ? 'opened' : 'failed';
    if (!r.ok) e.info.error = r.error;
    else if ('how' in r) {
      e.info.how = r.how;
      if (r.note) e.info.note = r.note;
    }
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr("the computer's helper didn't fetch the request") });
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr("the computer's helper didn't confirm") });
      else if ((e.info.status === 'opened' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
