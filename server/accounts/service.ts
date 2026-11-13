// Watched accounts + the usage of each one: statusline tap (recommended) and the /usage cache
// written in .claude.json. Only local files: no credentials and no network calls.
//
// The Claude Code accounts come from the config dirs (detectAccounts). Those of other tools (Codex) arrive from
// outside, discovered by their source (setProviderAccounts), with ids unique among all accounts; their usage is also
// pushed by the source (setUsage), next to the statusline and the /usage cache of Claude Code.
import { basename, resolve } from 'node:path';
import type { AccountInfo, AccountUsage, Provider } from '../../shared/types';
import { log } from '../log';
import { detectAccounts, type DetectedAccount } from './detect';
import { StatuslineUsageReader, type StatuslineUsage } from './statusline';
import { usageFromCache, UsageStore, type UsageSource, type UsageView } from './usage';
import { tr } from '../../shared/i18n';

export interface AccountEntry {
  id: string;
  /** The account's tool. */
  provider: Provider;
  /** Config dir read by this process (in Docker, the mounted path). */
  dir: string;
  detected: DetectedAccount;
}

/** Account of another tool (e.g. a CODEX_HOME), discovered by its source. */
export interface ProviderAccountInput {
  /** Folder read by this process (in Docker, the mounted path). */
  dir: string;
  /**
   * Metadata for display. `id` is the desired one (e.g. ".codex"): if another account already uses that id, it gets
   * "~2", "~3"... (the final id comes back in setProviderAccounts). `provider` is filled in by the service.
   */
  detected: DetectedAccount;
}

export interface AccountsServiceOptions {
  dirs: string[];
  home: string;
  env: NodeJS.ProcessEnv;
  onChange: () => void;
  now?: () => number;
  /** Reread interval of .claude.json (usage cache). */
  refreshMs?: number;
  /** Folder with the usage captured from the statusline (scripts/statusline-tap.mjs). Without it, the source stays off. */
  usageDir?: string;
  /** Reread interval of the statusline folder (default 5 s). */
  statuslineMs?: number;
}

export class AccountsService {
  readonly usage = new UsageStore();
  /** Claude Code accounts (config dirs). */
  private list_: AccountEntry[] = [];
  /** Accounts of the other tools, by tool (setProviderAccounts). */
  private external = new Map<Provider, AccountEntry[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private statuslineTimer: ReturnType<typeof setInterval> | null = null;
  private readonly statusline: StatuslineUsageReader | null;
  /** Signature of the displayed usage (the status changes by itself over time: ok -> stale, windows reset). */
  private usageSig = '';
  private readonly now: () => number;

  constructor(private readonly opts: AccountsServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.statusline = opts.usageDir ? new StatuslineUsageReader(opts.usageDir) : null;
    this.refresh();
    this.refreshStatusline();
  }

  /** Rereads the metadata and the usage cache (cheap: two or three small JSONs). */
  refresh(): void {
    let detected: DetectedAccount[];
    try {
      detected = detectAccounts(this.opts.dirs, { home: this.opts.home, env: this.opts.env });
    } catch (err) {
      log.warnOnce('detect-accounts', tr('Failed to detect accounts: {0}', [String(err).slice(0, 120)]));
      return;
    }
    const next = this.opts.dirs.map((dir, i): AccountEntry => ({ id: detected[i].id, provider: 'claude', dir, detected: detected[i] }));
    let changed = JSON.stringify(next.map((e) => ({ ...e.detected, cachedUsage: undefined }))) !==
      JSON.stringify(this.list_.map((e) => ({ ...e.detected, cachedUsage: undefined })));
    this.list_ = next;
    for (const e of next) {
      const cache = usageFromCache(e.detected.cachedUsage);
      if (cache) changed = this.usage.set(e.id, cache) || changed;
      else changed = this.usage.clear(e.id, 'cache') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  /**
   * Rereads the statusline tap files and applies to each account the most recent one that matches
   * (by the config dir; otherwise by the id/basename). An account without a file loses the 'statusline' source.
   */
  refreshStatusline(): void {
    if (!this.statusline) return;
    let files: StatuslineUsage[];
    try {
      files = this.statusline.read(this.now());
    } catch (err) {
      log.warnOnce('statusline-read', tr('Failed to read statusline usage: {0}', [String(err).slice(0, 120)]));
      return;
    }
    let changed = false;
    for (const e of this.list_) {
      const mine = files.filter((f) => this.fileMatches(e, f));
      const best = mine.reduce<StatuslineUsage | undefined>((acc, f) => (!acc || f.usage.fetchedAt > acc.usage.fetchedAt ? f : acc), undefined);
      if (best) changed = this.usage.set(e.id, best.usage) || changed;
      else changed = this.usage.clear(e.id, 'statusline') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  private fileMatches(e: AccountEntry, f: StatuslineUsage): boolean {
    if (f.configDir) {
      const dir = resolve(f.configDir);
      if (dir === resolve(e.detected.configDir) || dir === resolve(e.dir)) return true;
      // Same folder name but a different path: only counts if no other account has that path.
      if (this.list_.some((o) => resolve(o.detected.configDir) === dir || resolve(o.dir) === dir)) return false;
      return basename(dir) === e.id;
    }
    return !!f.accountId && f.accountId === e.id;
  }

  /**
   * Replaces the accounts of a tool that is not Claude Code (its source calls this on every discovery). Ids
   * unique among all accounts: an id already used (by a Claude Code account, by one of another tool or repeated
   * in the list) gets "~2", "~3"... in the order of the list. Returns the entries with the final ids, in the same
   * order: they are the ones that go in AgentInfo.account. An account that left loses the stored usage.
   */
  setProviderAccounts(provider: Exclude<Provider, 'claude'>, list: readonly ProviderAccountInput[]): readonly AccountEntry[] {
    const taken = new Set(this.list_.map((e) => e.id));
    for (const [p, entries] of this.external) if (p !== provider) for (const e of entries) taken.add(e.id);
    const next = list.map((input): AccountEntry => {
      const base = input.detected.id || basename(input.dir) || input.dir;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
      taken.add(id);
      return { id, provider, dir: input.dir, detected: { ...input.detected, id, provider } };
    });
    const prev = this.external.get(provider) ?? [];
    let changed = JSON.stringify(prev) !== JSON.stringify(next);
    for (const e of prev) if (!next.some((n) => n.id === e.id)) changed = this.usage.forget(e.id) || changed;
    if (next.length) this.external.set(provider, next);
    else this.external.delete(provider);
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
    return next;
  }

  /**
   * Usage pushed by a source (e.g. the Codex one, read from the session files): stored by origin
   * (`usage.source`), next to the others; the most recent one counts (highest fetchedAt). Returns true if something
   * changed.
   */
  setUsage(accountId: string, usage: AccountUsage): boolean {
    const changed = this.usage.set(accountId, usage);
    const viewChanged = this.usageViewChanged();
    if (changed || viewChanged) this.opts.onChange();
    return changed;
  }

  /** Forgets the usage of one origin of the account (e.g. the source has no more numbers). True if something changed. */
  clearUsage(accountId: string, source: UsageSource): boolean {
    const changed = this.usage.clear(accountId, source);
    const viewChanged = this.usageViewChanged();
    if (changed || viewChanged) this.opts.onChange();
    return changed;
  }

  /** Did the displayed usage change (including by itself, over time: ok -> stale, windows reset)? */
  private usageViewChanged(): boolean {
    const now = this.now();
    const sig = JSON.stringify(this.allEntries().map((e) => this.usage.view(e.id, now)));
    if (sig === this.usageSig) return false;
    this.usageSig = sig;
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), this.opts.refreshMs ?? 60_000);
    this.timer.unref?.();
    if (this.statusline) {
      this.statuslineTimer = setInterval(() => this.refreshStatusline(), this.opts.statuslineMs ?? 5_000);
      this.statuslineTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statuslineTimer) clearInterval(this.statuslineTimer);
    this.timer = null;
    this.statuslineTimer = null;
  }

  /** Claude Code accounts (the watcher, the history and the statusline are theirs only). */
  entries(): readonly AccountEntry[] {
    return this.list_;
  }

  /** Accounts of one tool. */
  entriesOf(provider: Provider): readonly AccountEntry[] {
    return provider === 'claude' ? this.list_ : (this.external.get(provider) ?? []);
  }

  /** Accounts of all the tools: the Claude Code ones first. */
  allEntries(): readonly AccountEntry[] {
    if (!this.external.size) return this.list_;
    return [...this.list_, ...[...this.external.values()].flat()];
  }

  idForDir(dir: string): string | undefined {
    const abs = resolve(dir);
    return this.allEntries().find((e) => resolve(e.dir) === abs)?.id;
  }

  find(id: string): AccountEntry | undefined {
    return this.allEntries().find((e) => e.id === id);
  }

  usageView(id: string): UsageView {
    return this.usage.view(id, this.now());
  }

  /** Accounts (of all the tools) in the protocol format; `sessions` = open sessions per account. */
  list(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    const now = this.now();
    return this.allEntries().map((e) => {
      const d = e.detected;
      const view = this.usage.view(e.id, now);
      const info: AccountInfo = {
        id: e.id,
        short: d.short,
        name: d.name,
        color: d.color,
        configDir: d.configDir,
        sessions: sessions.get(e.id) ?? 0,
        usageStatus: view.status,
      };
      // Absent = 'claude' (the snapshot of the Claude Code accounts does not change).
      if (e.provider !== 'claude') info.provider = e.provider;
      if (d.email) info.email = d.email;
      if (d.organization) info.organization = d.organization;
      if (d.plan) info.plan = d.plan;
      if (view.usage) info.usage = view.usage;
      return info;
    });
  }
}
