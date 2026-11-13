// Installs (or removes) the Habblaud mod in each account's Claude Code. Runs on the HOST, with tsx:
//
//   npm run mod:install      # marketplace "habblaud" (this folder) + plugins habblaud, habblaud-permissoes and
//                            # habblaud-mensagens
//   npm run mod:uninstall    # removes the three plugins and the marketplace from each account
//   npm run mod:status       # per account: marketplace, plugins (and versions) and leftovers of the old way
//   (options: --sem-permissoes, --sem-mensagens, --conta <folder>, --dry-run, --claude <command>)
//
// Everything goes through Claude Code's own CLI (`claude plugin ...`), run once per account with that account's
// CLAUDE_CONFIG_DIR, as the shell shortcut does (`alias d='CLAUDE_CONFIG_DIR=... claude'`). This way the one that
// writes the records (enabledPlugins and extraKnownMarketplaces in settings.json, <account>/plugins/*.json) is
// Claude Code, in the format it knows: this script does not edit those fields.
//
// The marketplace is THIS folder (.claude-plugin/marketplace.json at the repository root), added as a local
// directory: Claude Code loads the plugins straight from the folders in mod/, without copying. After a `git pull`,
// new sessions (or /reload-plugins) already run the new code; `claude plugin update` fixes the registered version
// (`npm run docker:up` does that by itself for whoever already installed it).
//
// Messages from the office (habblaud-mensagens, the plugin that types in the session in your name): it goes along by
// default; with --sem-mensagens it stays out, and one already installed stays (like the permissions one with
// --sem-permissoes). docker:up never installs it by itself: in an account with the mod and without it, it only
// gives the hint to run mod:install.
//
// Migration from the old way: the mod writes the usage to the same file as the statusline tap (usage:install) and
// the permissions plugin does the same as the PermissionRequest settings hook (hooks:install). On installation, each
// one leaves the account's settings.json (with backup), through the old installers' functions, so that there are not
// two capturing the usage nor two answering the same request. With --sem-permissoes, the old hook stays as it is.
//
// Old name (CodeTown, up to 0.3.2): install removes the codetown and codetown-permissoes plugins and the codetown
// marketplace (this same folder, with the name the manifest no longer has) BEFORE adding habblaud, and moves
// ~/.codetown to ~/.habblaud. Uninstall also removes them, status shows them and docker:up only warns.
//
// Status (and each account's plan): comes from `claude plugin list --json` and
// `claude plugin marketplace list --json`, documented outputs that already resolve scope, on/off and
// CLAUDE_CODE_PLUGIN_CACHE_DIR. The files <account>/plugins/installed_plugins.json and known_marketplaces.json are
// internal to Claude Code and can change format (the first one is already at version 2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs, expandHome, isDefaultDir } from '../server/accounts/detect';
import { LEGACY_NAME } from '../server/legacy';
import { DEFAULT_PORT, installedHook, planUninstall as planHookUninstall } from './hooks-install';
import {
  formatAge,
  isTapCommand,
  migrateLegacyState,
  planUninstall as planTapUninstall,
  readSettings,
  tildify,
  usageDirOf,
  writeSettings,
  type Settings,
} from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Name of the marketplace in .claude-plugin/marketplace.json (contract with mod/). */
export const MARKETPLACE = 'habblaud';
/** The mod: plan usage, "needs you" alert in the terminal and /habblaud. */
export const MOD_PLUGIN = `habblaud@${MARKETPLACE}`;
/** The PermissionRequest settings hook for answering from the office, packaged as a plugin. */
export const PERMISSIONS_PLUGIN = `habblaud-permissoes@${MARKETPLACE}`;
/** Sending messages from the office: takes into the session, as yours, the messages typed in Habblaud. */
export const MESSAGES_PLUGIN = `habblaud-mensagens@${MARKETPLACE}`;
/** Habblaud's plugins, in output order (status, removal, update). */
export const PLUGINS = [MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN] as const;
/** Marketplace of the old name (CodeTown, up to 0.3.2): the same folder, registered with the name it had. */
export const LEGACY_MARKETPLACE = LEGACY_NAME;
/** The plugins that came from it (the mod and the permissions one, with the old name). */
export const LEGACY_PLUGINS = [`${LEGACY_NAME}@${LEGACY_MARKETPLACE}`, `${LEGACY_NAME}-permissoes@${LEGACY_MARKETPLACE}`] as const;
/** First version of Claude Code (terminal) that loads mods. */
export const MIN_CLAUDE_VERSION = '2.1.287';
/** The plugins always go to the user scope: they apply in all of the account's projects. */
const SCOPE = 'user';
/** Maximum time for each call to the CLI (the add/update of a local directory takes a few seconds). */
const CLI_TIMEOUT_MS = 120_000;

const USAGE = tr("Usage: npm run mod:<install|uninstall|status> [-- options]\n\n  install     installs the Habblaud mod into each account's Claude Code (this folder's marketplace + plugins)\n              and removes what it replaces: the old statusline tap, the old permission hook and the mod under\n              the old name (codetown)\n  uninstall   removes the Habblaud plugins and marketplace from each account (and the old-name ones, if any are left)\n  status      shows, per account, the marketplace, the plugins (and versions) and what's left of the old way\n\nOptions:\n  --sem-permissoes   doesn't install the plugin for answering permissions from the office (and keeps the old hook)\n  --sem-mensagens    doesn't install the plugin for sending messages from the office (one already installed stays)\n  --conta <folder>   only this account (e.g. --conta ~/.claude-conta2); can be repeated\n  --dry-run          shows what it would do, without installing or writing anything\n  --claude <cmd>     Claude Code command (default: claude, from PATH)\n  -h, --help         shows this help\n\nRequires Claude Code {0} or newer. On earlier versions, use the old way:\nnpm run usage:install (live usage) and npm run hooks:install (answer permissions); sending messages from the\noffice only exists with the mod.\n\nAccounts: the same as the server's (~/.claude* with projects/ or sessions/, CLAUDE_CONFIG_DIR or\nHABBLAUD_CLAUDE_DIRS). Usage captured in HABBLAUD_USAGE_DIR (default ~/.habblaud/usage).", [MIN_CLAUDE_VERSION]);

// ---------------------------------------------------------------------------------------------
// The Claude Code CLI (injectable: the tests never call the real one)
// ---------------------------------------------------------------------------------------------

export interface ClaudeResult {
  /** Exit code (null if it never got to run or was killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Failure to start the process (e.g. `claude` not in the PATH). */
  error?: string;
}

/** Runs `claude <args>` with the given environment (the account's CLAUDE_CONFIG_DIR comes in it). */
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => ClaudeResult;

/** The real runner. stdin closed: nothing stays waiting for an answer in the terminal. */
export function makeClaudeRunner(cmd = 'claude'): ClaudeRunner {
  return (args, env) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? tr('the "{0}" command wasn\'t found in PATH', [cmd]) : code === 'ETIMEDOUT' ? tr('"{0} {1}" didn\'t finish within {2} s', [cmd, args.join(' '), CLI_TIMEOUT_MS / 1000]) : r.error.message;
      return { code: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
    }
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/**
 * CLI environment for an account. The default account (~/.claude) runs WITHOUT CLAUDE_CONFIG_DIR, like plain
 * `claude`: with the variable pointing to ~/.claude, Claude Code would start using ~/.claude/.claude.json instead of
 * ~/.claude.json. And the inherited variable (e.g. running from inside a session of the other account) never leaks.
 */
export function accountEnv(env: NodeJS.ProcessEnv, dir: string, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (isDefaultDir(dir, home)) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/mod-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** "2.1.293 (Claude Code)" → [2, 1, 293]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Without the terminal's color codes. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * JSON from the CLI output, with tolerance: the whole output, or from the first line that opens a JSON (warnings
 * before it), or only the last line (result format of the actions' `--json`). undefined if nothing works.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim();
  if (!text) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text);
  if (whole !== undefined) return whole;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start > 0) {
    const fromStart = tryParse(lines.slice(start).join('\n'));
    if (fromStart !== undefined) return fromStart;
  }
  return tryParse(lines[lines.length - 1]);
}

/** A plugin installation, as `claude plugin list --json` shows it (only what we use). */
export interface PluginInfo {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  /** Folder it loads from, when read in place from a local marketplace (Claude Code 2.1.289+). */
  readFromFolder?: string;
  /** Version of the manifest in that folder (can be newer than the registered one). */
  folderVersion?: string;
  errors: string[];
}

/** List of installed plugins; accepts the array or the object from `--available` ({installed: [...]}). */
export function parsePluginList(stdout: string): PluginInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  const list = Array.isArray(raw) ? raw : rec(raw) && Array.isArray(rec(raw)!.installed) ? (rec(raw)!.installed as unknown[]) : undefined;
  if (!list) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out: PluginInfo[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id);
    if (!r || !id) continue;
    out.push({
      id,
      version: str(r.version),
      scope: str(r.scope),
      enabled: r.enabled !== false,
      readFromFolder: str(r.readFromFolder),
      folderVersion: str(r.folderVersion),
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  /** Folder (directory or local file marketplaces). */
  path?: string;
}

export function parseMarketplaceList(stdout: string): MarketplaceInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  if (!Array.isArray(raw)) return undefined;
  const out: MarketplaceInfo[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || typeof r.name !== 'string') continue;
    const m: MarketplaceInfo = { name: r.name };
    if (typeof r.source === 'string') m.source = r.source;
    const path = typeof r.path === 'string' ? r.path : typeof r.installLocation === 'string' && r.source === 'directory' ? r.installLocation : undefined;
    if (path) m.path = path;
    out.push(m);
  }
  return out;
}

/** What an account has of Habblaud in Claude Code. */
export interface AccountState {
  marketplace?: MarketplaceInfo;
  /** The marketplace of the old name (codetown), if it is still registered. */
  legacyMarketplace?: MarketplaceInfo;
  plugins: PluginInfo[];
}

/** The installation of `id` in the user scope (the only one this script manages). */
export function userInstall(state: AccountState, id: string): PluginInfo | undefined {
  return state.plugins.find((p) => p.id === id && (p.scope === SCOPE || p.scope === undefined));
}

/** Plugins of the old name in the user scope (where the 0.3 mod:install put them). */
export function legacyPlugins(state: AccountState): PluginInfo[] {
  return LEGACY_PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
}

/**
 * The leftovers of the old name in one phrase ("marketplace codetown, codetown@codetown 0.3.2"), or undefined if
 * nothing is left. `where` describes the marketplace's folder (the status says whether it is this one).
 */
export function legacySummary(state: AccountState, where?: (m: MarketplaceInfo) => string): string | undefined {
  const parts = legacyPlugins(state).map((p) => `${p.id}${p.version ? ` ${p.version}` : ''}`);
  const m = state.legacyMarketplace;
  if (m) parts.unshift(`marketplace ${LEGACY_MARKETPLACE}${where ? ` (${where(m)})` : ''}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** A call to the CLI, with the phrase that tells what it does. */
export interface CliStep {
  args: string[];
  /** "habblaud: installed" (becomes ✓, ~ or ✗ in the output). */
  message: string;
  /** Plugin that depends on this step (failed = does not count as installed). */
  plugin?: string;
  /** If it fails, the following installation steps run anyway (the failure still counts at the end). */
  keepGoing?: boolean;
}

/** Plan item, in output order: a call to the CLI or something that is already right (becomes "="). */
export type PlanItem = CliStep | { unchanged: string };

export interface InstallPlan {
  items: PlanItem[];
  /** Warnings that do not prevent the installation. */
  notes: string[];
  /** Plugins that end up installed if all the steps work. */
  plugins: string[];
}

/** Only the CLI calls of a plan. */
export function cliSteps(plan: InstallPlan): CliStep[] {
  return plan.items.filter((i): i is CliStep => 'args' in i);
}

export interface PlanOptions {
  /** Repository root (where .claude-plugin/marketplace.json is). */
  root: string;
  /** Version from package.json (= version of the plugins). */
  version: string;
  /** Also install the permissions plugin. */
  permissions: boolean;
  /** Also install the messages plugin. */
  messages: boolean;
  /** Compares folders (default: real path). */
  sameDir?: (a: string, b: string) => boolean;
}

/** Same folder, resolving symlinks when possible. */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const shortName = (id: string) => id.split('@')[0];

/**
 * Steps that remove the leftovers of the old name: the plugins (user scope) and then the marketplace. A plugin
 * that does not come out does not hold up the following steps: removing the marketplace takes along what came from it.
 */
function legacySteps(state: AccountState): CliStep[] {
  const steps: CliStep[] = legacyPlugins(state).map((p) => ({
    args: ['plugin', 'uninstall', p.id, '--scope', SCOPE],
    message: tr('{0} (old name): removed', [shortName(p.id)]),
    keepGoing: true,
  }));
  if (state.legacyMarketplace) {
    steps.push({ args: ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE], message: tr('marketplace {0} (old name): removed', [LEGACY_MARKETPLACE]) });
  }
  return steps;
}

/**
 * Installation steps for an account, starting from what it already has. The leftovers of the old name go first. The
 * marketplace is added (or, if it already exists, has its catalog reread; if it pointed to another folder, it now
 * points to this one). Each plugin is installed, turned back on (if it was off) or updated (if the registered
 * version differs from the one in package.json).
 */
export function planInstall(state: AccountState, o: PlanOptions): InstallPlan {
  const same = o.sameDir ?? sameDir;
  const plan: InstallPlan = { items: [], notes: [], plugins: [] };
  // The codetown marketplace points to this same folder: it goes out before habblaud comes in, so that there are never
  // two names registered for the same folder (one of them that the manifest no longer has).
  plan.items.push(...legacySteps(state));
  const m = state.marketplace;
  if (!m) {
    plan.items.push({ args: ['plugin', 'marketplace', 'add', o.root], message: tr('marketplace {0}: added (this folder)', [MARKETPLACE]) });
  } else if (m.path && same(m.path, o.root)) {
    plan.items.push({ args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catalog reloaded from this folder', [MARKETPLACE]) });
  } else {
    // Another folder (Habblaud moved to another place) or another source: the add with the same key only swaps the
    // source and keeps the plugins installed.
    plan.items.push({
      args: ['plugin', 'marketplace', 'add', o.root],
      message: tr('marketplace {0}: now points to this folder (before: {1})', [MARKETPLACE, m.path ?? m.source ?? tr('another source')]),
    });
  }
  const wanted = [MOD_PLUGIN, ...(o.permissions ? [PERMISSIONS_PLUGIN] : []), ...(o.messages ? [MESSAGES_PLUGIN] : [])];
  for (const id of wanted) {
    const name = shortName(id);
    const cur = userInstall(state, id);
    if (!cur) {
      plan.items.push({ args: ['plugin', 'install', id, '--scope', SCOPE], message: tr('{0}: installed', [name]), plugin: id });
      plan.plugins.push(id);
      continue;
    }
    plan.plugins.push(id);
    let touched = false;
    if (!cur.enabled) {
      plan.items.push({ args: ['plugin', 'enable', id, '--scope', SCOPE], message: tr('{0}: re-enabled (was disabled)', [name]), plugin: id });
      touched = true;
    }
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: updated from {1} to {2}', [name, cur.version ?? '?', o.version]), plugin: id });
      touched = true;
    }
    if (!touched) plan.items.push({ unchanged: tr('{0}: already installed at version {1}', [name, o.version]) });
  }
  // With --sem-permissoes (or --sem-mensagens), such a plugin already installed stays (and follows the mod's version).
  const left: Array<[id: string, flag: string]> = [];
  if (!o.permissions) left.push([PERMISSIONS_PLUGIN, '--sem-permissoes']);
  if (!o.messages) left.push([MESSAGES_PLUGIN, '--sem-mensagens']);
  for (const [id, flag] of left) {
    const cur = userInstall(state, id);
    if (!cur) continue;
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: updated from {1} to {2}', [shortName(id), cur.version ?? '?', o.version]), plugin: id });
    }
    plan.plugins.push(id);
    plan.notes.push(tr("{0} was already installed and stays ({1} doesn't remove it; to remove it: claude plugin uninstall {2})", [shortName(id), flag, id]));
  }
  return plan;
}

/**
 * Removal steps: the leftovers of the old name (if any), the user-scope plugins and the marketplace, only what
 * exists. (Removing the marketplace would already uninstall what came from it, but one step per plugin makes clear,
 * in the output, what went out.)
 */
export function planUninstall(state: AccountState): InstallPlan {
  const plan: InstallPlan = { items: [...legacySteps(state)], notes: [], plugins: [] };
  for (const id of PLUGINS) {
    const name = shortName(id);
    if (userInstall(state, id)) plan.items.push({ args: ['plugin', 'uninstall', id, '--scope', SCOPE], message: tr('{0}: removed', [name]), plugin: id });
    else plan.items.push({ unchanged: tr("{0}: wasn't installed", [name]) });
  }
  if (state.marketplace) plan.items.push({ args: ['plugin', 'marketplace', 'remove', MARKETPLACE], message: tr('marketplace {0}: removed', [MARKETPLACE]) });
  else plan.items.push({ unchanged: tr("marketplace {0}: wasn't added", [MARKETPLACE]) });
  return plan;
}

export interface MigrationPlan {
  /** New settings.json, if something changed. */
  settings?: Settings;
  /** What was removed (becomes ✓). */
  done: string[];
  /** What stayed and why (becomes "="). */
  kept: string[];
  /** Formats that cannot be touched safely (becomes "!"). */
  warnings: string[];
}

/**
 * Removes from settings.json what the mod replaces: the statusline tap (if the mod ended up installed) and the old
 * permission hook (if the permissions plugin ended up installed). A single write, for a single backup.
 */
export function planMigration(settings: Settings, o: { modInstalled: boolean; permissionsInstalled: boolean; permissions: boolean }): MigrationPlan {
  const out: MigrationPlan = { done: [], kept: [], warnings: [] };
  let next = settings;
  const sl = rec(settings.statusLine);
  if (sl && isTapCommand(sl.command)) {
    if (!o.modInstalled) out.kept.push(tr("old statusline tap kept (the mod didn't get installed)"));
    else {
      const p = planTapUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('old statusline tap removed: the mod records usage in its place ({0})', [p.message]));
      } else if (p.action === 'skip') out.warnings.push(tr('old statusline tap: {0} (run npm run usage:uninstall after checking)', [p.message]));
    }
  }
  if (installedHook(next)) {
    if (!o.permissions) out.kept.push(tr('old permission hook kept (--sem-permissoes)'));
    else if (!o.permissionsInstalled) out.kept.push(tr("old permission hook kept (the permissions plugin didn't get installed)"));
    else {
      const p = planHookUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('old permission hook removed: the {0} plugin answers in its place', [shortName(PERMISSIONS_PLUGIN)]));
      } else if (p.action === 'skip') out.warnings.push(tr('old permission hook: {0} (run npm run hooks:uninstall after checking)', [p.message]));
    }
  }
  if (next !== settings) out.settings = next;
  return out;
}

/** Differences between what should have ended up installed and what Claude Code records after the steps. */
export function verifyInstall(after: AccountState, plugins: string[], version: string): string[] {
  const out: string[] = [];
  for (const id of plugins) {
    const p = userInstall(after, id);
    const name = shortName(id);
    if (!p) out.push(tr("{0}: doesn't show as installed in the Claude Code list", [name]));
    else if (!p.enabled) out.push(tr('{0}: installed, but disabled (claude plugin enable {1})', [name, id]));
    else if (p.version !== version) out.push(tr('{0}: Claude Code records version {1}, not {2} (does the manifest in mod/ have a different version?)', [name, p.version ?? '?', version]));
    if (p?.errors.length) out.push(`${name}: ${p.errors.join('; ')}`);
  }
  return out;
}

/**
 * For docker:up: updates only what is already installed, never installs. `hint` is the hint for whoever has the mod
 * and not the messages plugin (which came later): docker:up does not install it by itself.
 */
export type UpdatePlan =
  | { action: 'none'; installed: boolean; hint?: string }
  | { action: 'update'; steps: CliStep[]; hint?: string }
  | { action: 'warn'; message: string };

/** The messages plugin hint, when the account has the mod and not it. */
export const MESSAGES_HINT = tr('run npm run mod:install to send messages from the office (plugin {0})', [shortName(MESSAGES_PLUGIN)]);

export function planUpdate(state: AccountState, o: { root: string; version: string; sameDir?: (a: string, b: string) => boolean }): UpdatePlan {
  const same = o.sameDir ?? sameDir;
  // Old name: the swap (remove codetown, install habblaud) belongs to mod:install; here only the warning. A warning
  // counts as "installed", so the hint to install from scratch does not show for whoever already used the mod.
  const legacy = legacySummary(state);
  if (legacy) return { action: 'warn', message: tr("still under the old name ({0}); docker:up doesn't switch it on its own: run npm run mod:install", [legacy]) };
  const installed = PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
  if (!installed.length) return { action: 'none', installed: false };
  const hint = userInstall(state, MOD_PLUGIN) && !userInstall(state, MESSAGES_PLUGIN) ? { hint: MESSAGES_HINT } : {};
  const stale = installed.filter((p) => p.version !== o.version);
  if (!stale.length) return { action: 'none', installed: true, ...hint };
  // Marketplace from another folder (another clone, moved folder): updating from there would not bring this version.
  const m = state.marketplace;
  if (!m) return { action: 'warn', message: tr('the mod is installed, but the marketplace {0} is gone; run npm run mod:install', [MARKETPLACE]) };
  if (!m.path || !same(m.path, o.root)) {
    return { action: 'warn', message: tr("the mod comes from another folder ({0}), so it wasn't updated; to use this one: npm run mod:install", [m.path ?? m.source ?? '?']) };
  }
  return {
    action: 'update',
    steps: [
      { args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catalog reloaded', [MARKETPLACE]) },
      ...stale.map((p) => ({ args: ['plugin', 'update', p.id, '--scope', SCOPE], message: `${shortName(p.id)}: ${p.version ?? '?'} → ${o.version}`, plugin: p.id })),
    ],
    ...hint,
  };
}

/** Last useful lines of the CLI output (to explain a failure). */
export function cliMessage(r: ClaudeResult): string {
  if (r.error) return r.error;
  const lines = stripAnsi(`${r.stdout}\n${r.stderr}`)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s✘✔✗✓×]+/, '').trim())
    .filter(Boolean);
  return lines.slice(-2).join(' · ') || tr('exited with code {0}', [r.code ?? '?']);
}

/** Lines of an account's status (without the header). */
export function describeStatus(state: AccountState, settings: Settings, o: { root: string; version: string; home: string; sameDir?: (a: string, b: string) => boolean }): string[] {
  const same = o.sameDir ?? sameDir;
  const lines: string[] = [];
  const m = state.marketplace;
  if (!m) lines.push(tr('marketplace {0}: not added', [MARKETPLACE]));
  else if (m.path && same(m.path, o.root)) lines.push(tr('marketplace {0}: this folder', [MARKETPLACE]));
  else lines.push(tr('marketplace {0}: another source ({1}); npm run mod:install points it to this folder', [MARKETPLACE, m.path ? tildify(m.path, o.home) : (m.source ?? '?')]));
  for (const id of PLUGINS) {
    const name = shortName(id);
    const all = state.plugins.filter((p) => p.id === id);
    if (!all.length) {
      lines.push(tr('{0}: not installed', [name]));
      continue;
    }
    for (const p of all) {
      const parts = [tr('installed{0}', [p.scope && p.scope !== SCOPE ? tr(' (scope {0})', [p.scope]) : '']), p.enabled ? tr('enabled') : tr('off')];
      parts.push(tr('version {0}{1}', [p.version ?? '?', p.version === o.version ? '' : tr(' (this folder: {0}; npm run mod:install or npm run docker:up updates it)', [o.version])]));
      if (p.folderVersion && p.folderVersion !== p.version) parts.push(tr('loads {0} from {1}', [p.folderVersion, tildify(p.readFromFolder ?? '?', o.home)]));
      if (p.errors.length) parts.push(`error: ${p.errors.join('; ')}`);
      lines.push(`${name}: ${parts.join(', ')}`);
    }
  }
  const legacy = legacySummary(state, (lm) => (lm.path && same(lm.path, o.root) ? tr('this folder') : lm.path ? tildify(lm.path, o.home) : (lm.source ?? '?')));
  if (legacy) lines.push(tr('! old name still registered: {0}; npm run mod:install replaces it with habblaud', [legacy]));
  const sl = rec(settings.statusLine);
  const hook = installedHook(settings);
  const modOn = !!userInstall(state, MOD_PLUGIN);
  const permOn = !!userInstall(state, PERMISSIONS_PLUGIN);
  if (sl && isTapCommand(sl.command)) {
    lines.push(
      modOn
        ? tr('! old statusline tap still installed alongside the mod: npm run mod:install removes it (or npm run usage:uninstall)')
        : tr('old statusline tap installed (old way; the mod replaces it)'),
    );
  }
  if (hook) {
    lines.push(
      permOn
        ? tr('! old permission hook still in settings.json alongside the plugin: both answer; npm run mod:install removes it (or npm run hooks:uninstall)')
        : tr('old permission hook installed (old way; the permissions plugin replaces it)'),
    );
  }
  if (settings.disableAllHooks === true) lines.push(tr("! disableAllHooks is on in this account's settings.json: no mod (or hook) runs"));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Effects (Claude Code CLI and settings.json)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** false with --sem-permissoes. */
  permissions: boolean;
  /** false with --sem-mensagens. */
  messages: boolean;
  /** --conta (empty = all the detected ones). */
  accounts: string[];
  claudeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  /** Repository root (the marketplace). */
  root: string;
  /** Version from package.json. */
  version: string;
  claude: ClaudeRunner;
  out: (line: string) => void;
  /** Queries Habblaud's /api/health in the status (tests inject a fake one). */
  health?: (port: number) => Promise<HealthInfo | undefined>;
}

/** What the status uses from /api/health (`messages` only exists since the Habblaud with messages from the office). */
export interface HealthInfo {
  permissions?: boolean;
  messages?: boolean;
}

class FatalError extends Error {}

async function fetchHealth(port: number): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthInfo;
  } catch {
    return undefined;
  }
}

/** Habblaud's port (HABBLAUD_PORT or the default one). */
function habblaudPort(env: NodeJS.ProcessEnv): number {
  const p = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_PORT;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let permissions = true;
  let messages = true;
  let claudeCmd: string | undefined;
  const accounts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--sem-permissoes') permissions = false;
    else if (a === '--sem-mensagens') messages = false;
    else if (a === '--conta') {
      const dir = argv[++i];
      if (!dir) throw new FatalError(tr('--conta needs the account folder (e.g. --conta ~/.claude-conta2).'));
      accounts.push(dir);
    } else if (a === '--claude') {
      claudeCmd = argv[++i];
      if (!claudeCmd) throw new FatalError(tr('--claude needs a command or path.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('specify what to do: install, uninstall or status.\n\n{0}', [USAGE]));
  return { command, dryRun, permissions, messages, accounts, claudeCmd };
}

/** Version from the root package.json. */
export function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) throw new FatalError(tr('package.json without "version" in {0}', [root]));
  return pkg.version;
}

/** An account's marketplace and plugins, through the CLI (or the reason it could not get them). */
export function readAccountState(claude: ClaudeRunner, env: NodeJS.ProcessEnv): AccountState | { error: string } {
  const mr = claude(['plugin', 'marketplace', 'list', '--json'], env);
  if (mr.error || mr.code !== 0) return { error: tr("couldn't list the marketplaces ({0})", [cliMessage(mr)]) };
  const markets = parseMarketplaceList(mr.stdout);
  if (!markets) return { error: tr("couldn't parse Claude Code's marketplace list") };
  const pr = claude(['plugin', 'list', '--json'], env);
  if (pr.error || pr.code !== 0) return { error: tr("couldn't list the plugins ({0})", [cliMessage(pr)]) };
  const plugins = parsePluginList(pr.stdout);
  if (!plugins) return { error: tr("couldn't parse Claude Code's plugin list") };
  return { marketplace: markets.find((m) => m.name === MARKETPLACE), legacyMarketplace: markets.find((m) => m.name === LEGACY_MARKETPLACE), plugins };
}

/** Account folders: the ones from --conta (which must exist) or the detected ones. */
function accountDirs(opts: RunOptions, env: NodeJS.ProcessEnv, home: string): string[] {
  if (!opts.accounts.length) return discoverClaudeDirs(env, home);
  return [...new Set(opts.accounts.map((a) => expandHome(a, home)))].map((dir) => {
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new FatalError(tr('--conta {0}: folder not found.', [dir]));
    return dir;
  });
}

/** Last usage captured (by the mod or by the tap) for an account, for the status. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string, now: Date): string {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Rec;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    return tr('last usage captured {0} ago ({1})', [formatAge(now.getTime() - at), j.source === 'mod' ? tr('via the mod') : tr('via the statusline tap')]);
  } catch {
    return tr('no usage captured yet (it arrives after the next reply in an open session of this account)');
  }
}

/** Runs the command for all accounts. Returns the exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = accountDirs(opts, env, home);
  if (!dirs.length) {
    out(tr('No Claude Code account found (~/.claude* with projects/ or sessions/). Use --conta <folder> or HABBLAUD_CLAUDE_DIRS.'));
    return 1;
  }
  const manifest = join(ctx.root, '.claude-plugin', 'marketplace.json');
  if (opts.command === 'install' && !existsSync(manifest)) {
    out(tr("{0} not found: this folder doesn't have the mod (old Habblaud version? run git pull).", [tildify(manifest, home)]));
    return 1;
  }

  // A single version: all the accounts use the same executable, only the CLAUDE_CONFIG_DIR changes.
  const vr = ctx.claude(['--version'], env);
  if (vr.error) {
    out(tr("Couldn't run Claude Code: {0}.", [vr.error]));
    out(tr('Install Claude Code (https://code.claude.com) or say where it is: npm run mod:<command> -- --claude <path>'));
    return 1;
  }
  const cliVersion = parseVersion(vr.stdout) ? parseVersion(vr.stdout)!.join('.') : undefined;
  if (opts.command === 'install') {
    if (!cliVersion) out(tr('! Couldn\'t parse the Claude Code version ("{0}"); continuing anyway.', [cliMessage(vr)]));
    else if (!versionAtLeast(cliVersion, MIN_CLAUDE_VERSION)) {
      out(tr('The mod requires Claude Code {0} or newer, and this one is {1}.', [MIN_CLAUDE_VERSION, cliVersion]));
      out(tr('Update Claude Code (claude update) and run again. Or use the old way, which works on earlier versions:'));
      out(tr('  npm run usage:install    # live 5h/weekly usage (statusline tap)'));
      out(tr('  npm run hooks:install    # answer permission requests from the office'));
      return 1;
    }
  }
  if (opts.command === 'status') {
    out(tr('Claude Code {0}{1} · Habblaud {2} in {3}', [cliVersion ?? tr('(unknown version)'), cliVersion && !versionAtLeast(cliVersion, MIN_CLAUDE_VERSION) ? tr(' — the mod requires {0}+', [MIN_CLAUDE_VERSION]) : '', ctx.version, tildify(ctx.root, home)]));
  }

  // Old name: ~/.codetown becomes ~/.habblaud before creating (or using) the usage folder.
  if (opts.command === 'install') {
    const moved = migrateLegacyState(home, opts.dryRun);
    if (moved) out(moved);
  }
  // The mod writes the usage to ~/.habblaud/usage, but does not create the folder (docker:up also mounts it in
  // the container).
  if (opts.command === 'install' && !opts.dryRun) {
    const usageDir = usageDirOf(env, home);
    try {
      if (!existsSync(usageDir)) {
        mkdirSync(usageDir, { recursive: true, mode: 0o700 });
        out(tr('✓ usage folder created: {0}', [tildify(usageDir, home)]));
      }
    } catch (err) {
      out(tr("! couldn't create {0} ({1}); live usage won't be recorded", [tildify(usageDir, home), (err as Error).message]));
    }
  }

  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const label = `${basename(dir)} (${tildify(dir, home)})`;
    const cenv = accountEnv(env, dir, home);
    const state = readAccountState(ctx.claude, cenv);
    const file = join(dir, 'settings.json');
    if (opts.command === 'status') {
      out(`• ${label}`);
      const read = readSettings(file);
      const settings = 'error' in read ? {} : read.settings;
      if ('error' in read) out(tr('    ✗ settings.json: {0}', [read.error]));
      if ('error' in state) {
        out(`    ✗ ${state.error}`);
        failures++;
      } else for (const l of describeStatus(state, settings, { root: ctx.root, version: ctx.version, home })) out(`    ${l}`);
      out(`    ${lastCapture(dir, env, home, ctx.now)}`);
      continue;
    }

    out(`${label}:`);
    if ('error' in state) {
      out(`  ✗ ${state.error}`);
      failures++;
      continue;
    }
    const plan =
      opts.command === 'install' ? planInstall(state, { root: ctx.root, version: ctx.version, permissions: opts.permissions, messages: opts.messages }) : planUninstall(state);
    const failed = new Set<string>();
    let broken = false;
    let stepFailed = false;
    for (const item of plan.items) {
      if (!('args' in item)) {
        out(`  = ${item.unchanged}`);
        continue;
      }
      if (opts.dryRun) {
        out(tr('  ~ {0} (dry run: claude {1})', [item.message, item.args.join(' ')]));
        continue;
      }
      // On installation, after a failure the following steps of this account do not run (without a marketplace there is
      // no plugin), except after a plugin of the old name that did not come out (its marketplace takes it along). On
      // removal, it goes on: whatever can be removed goes out.
      if (broken && opts.command === 'install') {
        if (item.plugin) failed.add(item.plugin);
        continue;
      }
      const r = ctx.claude(item.args, cenv);
      if (!r.error && r.code === 0) {
        out(`  ✓ ${item.message}`);
        changed++;
      } else {
        out(tr('  ✗ {0}: failed ({1})', [item.message.split(':')[0], cliMessage(r)]));
        if (item.plugin) failed.add(item.plugin);
        stepFailed = true;
        if (!item.keepGoing) broken = true;
      }
    }
    if (stepFailed) failures++;
    for (const n of plan.notes) out(`  ! ${n}`);
    if (opts.command !== 'install') continue;

    // Checks with Claude Code itself what ended up installed (an update with no effect also exits with 0) and
    // decides the migration from that. In a dry run (or if the list fails), what counts is the plan minus what failed.
    let ok = (id: string) => plan.plugins.includes(id) && !failed.has(id);
    if (!opts.dryRun) {
      const after = readAccountState(ctx.claude, cenv);
      if (!('error' in after)) {
        for (const w of verifyInstall(after, plan.plugins, ctx.version)) out(`  ! ${w}`);
        const legacy = legacySummary(after);
        if (legacy) out(tr('  ! old name still registered: {0}; run npm run mod:install again (or check with npm run mod:status)', [legacy]));
        ok = (id: string) => userInstall(after, id)?.enabled === true;
      }
    }

    // Migration: reads settings.json AFTER the CLI (it also writes there: enabledPlugins, marketplaces).
    const read = readSettings(file);
    if ('error' in read) {
      out(tr("  ✗ settings.json: {0}; the old tap and hook weren't checked", [read.error]));
      failures++;
      continue;
    }
    const mig = planMigration(read.settings, { modInstalled: ok(MOD_PLUGIN), permissionsInstalled: ok(PERMISSIONS_PLUGIN), permissions: opts.permissions });
    for (const k of mig.kept) out(`  = ${k}`);
    for (const w of mig.warnings) out(`  ! ${w}`);
    if (read.settings.disableAllHooks === true) out(tr("  ! disableAllHooks is on in this account's settings.json: the mod won't run until you turn it off"));
    if (!mig.settings) continue;
    if (opts.dryRun) {
      for (const d of mig.done) out(tr('  ~ {0} (dry run: nothing written)', [d]));
      continue;
    }
    try {
      const backup = writeSettings(file, mig.settings, read.raw, ctx.now);
      for (const d of mig.done) out(`  ✓ ${d}`);
      if (backup) out(tr('    settings.json backup in {0}', [tildify(backup, home)]));
      changed++;
    } catch (err) {
      out(tr("  ✗ couldn't write settings.json ({0}); the old tap and hook remain", [(err as Error).message]));
      failures++;
    }
  }

  if (opts.command === 'install' && !opts.dryRun && !failures) {
    out('');
    out(tr('Done. New Claude Code sessions already load the mod; in sessions already open, run /reload-plugins (or'));
    out(tr("reopen the session). The 5h/weekly usage reaches Habblaud after each session's next reply."));
    out(tr('To check: npm run mod:status · To undo: npm run mod:uninstall'));
  }
  if (opts.command === 'uninstall' && !opts.dryRun && changed) {
    out('');
    out(tr('Done. Sessions already open keep the mod until /reload-plugins (or until the session is reopened).'));
    out(tr('To go back to the old way (Claude Code before 2.1.287): npm run usage:install and npm run hooks:install'));
  }
  if (opts.command === 'status') {
    // The mod and the plugins only talk to the local Habblaud: says whether it is there to answer.
    const port = habblaudPort(env);
    const health = await (ctx.health ?? fetchHealth)(port);
    const at = tr('Habblaud at http://127.0.0.1:{0}', [port]);
    if (!health) out(tr('{0}: down (the mod keeps recording usage; permission requests stay in the terminal only).', [at]));
    else if (health.permissions) out(tr('{0}: up and handling permission requests (with a page open).', [at]));
    else out(tr('{0}: up, but answering from the office is off (port exposed on the network or HABBLAUD_TERMINAL=0).', [at]));
    // A Habblaud from before the messages says nothing about them.
    if (health && typeof health.messages === 'boolean') {
      out(
        health.messages
          ? tr('Messages from the office: on (they reach open sessions with the {0} plugin).', [shortName(MESSAGES_PLUGIN)])
          : tr('Messages from the office: off in Habblaud (port exposed on the network, HABBLAUD_TERMINAL=0 or HABBLAUD_MENSAGENS=0).'),
      );
    }
  }
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// For docker:up: updates the mod for those who already installed it
// ---------------------------------------------------------------------------------------------

export interface ModUpdateContext {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
  version: string;
  claude: ClaudeRunner;
}

export interface ModUpdateResult {
  /** Some account has the mod (or one of the other plugins) installed, even if under the old name. */
  installed: boolean;
  /** Claude Code could not be queried in any account (e.g. `claude` not in the PATH). */
  unavailable: boolean;
  lines: Array<{ level: 'info' | 'warn'; text: string }>;
}

/**
 * For each account with the mod installed in a version different from the one in package.json: rereads the catalog
 * and updates the installed plugins. With leftovers of the old name, only gives a notice (the switch belongs to
 * mod:install). With the mod and without the messages plugin, gives the hint to run mod:install. Never installs
 * anything and never throws: any failure becomes a notice.
 */
export function updateInstalledMods(accounts: Array<{ dir: string; label: string }>, ctx: ModUpdateContext): ModUpdateResult {
  const res: ModUpdateResult = { installed: false, unavailable: false, lines: [] };
  if (!accounts.length) return res;
  // A runner that never throws: any exception becomes an ordinary failure (docker:up cannot go down because of it).
  const claude: ClaudeRunner = (args, env) => {
    try {
      return ctx.claude(args, env);
    } catch (err) {
      return { code: null, stdout: '', stderr: '', error: (err as Error).message };
    }
  };
  // Without the CLI, the same failure would repeat in every account: checks once and gives the notice once.
  const probe = claude(['--version'], ctx.env);
  if (probe.error || probe.code !== 0) {
    res.unavailable = true;
    res.lines.push({ level: 'warn', text: tr("couldn't query Claude Code ({0}); the mod wasn't checked.", [cliMessage(probe)]) });
    return res;
  }
  for (const { dir, label } of accounts) {
    const env = accountEnv(ctx.env, dir, ctx.home);
    const state = readAccountState(claude, env);
    if ('error' in state) {
      res.lines.push({ level: 'warn', text: tr('mod on {0}: {1}', [label, state.error]) });
      continue;
    }
    const plan = planUpdate(state, { root: ctx.root, version: ctx.version });
    if (plan.action !== 'none' || plan.installed) res.installed = true;
    if (plan.action === 'warn') {
      res.lines.push({ level: 'warn', text: tr('mod on {0}: {1}', [label, plan.message]) });
      continue;
    }
    if (plan.action === 'update') res.lines.push(applyUpdate(plan.steps, { claude, env, version: ctx.version, label }));
    // Has the mod and not the messages plugin (which came later): docker:up does not install it by itself, it only
    // gives the hint.
    if (plan.hint) res.lines.push({ level: 'info', text: tr('Tip for {0}: {1}', [label, plan.hint]) });
  }
  return res;
}

/** Runs the update steps for one account and tells how it went, in one line. */
function applyUpdate(steps: CliStep[], o: { claude: ClaudeRunner; env: NodeJS.ProcessEnv; version: string; label: string }): ModUpdateResult['lines'][number] {
  for (const step of steps) {
    const r = o.claude(step.args, o.env);
    if (r.error || r.code !== 0) {
      return { level: 'warn', text: tr("couldn't update the mod on {0}: {1} ({2}). Try: npm run mod:install", [o.label, step.message.split(':')[0], cliMessage(r)]) };
    }
  }
  // Only says "updated" if Claude Code really started recording the new version.
  const after = readAccountState(o.claude, o.env);
  const ids = steps.flatMap((s) => (s.plugin ? [s.plugin] : []));
  const issues = 'error' in after ? [after.error] : verifyInstall(after, ids, o.version);
  if (issues.length) return { level: 'warn', text: tr('mod on {0}: {1}', [o.label, issues.join('; ')]) };
  return { level: 'info', text: tr('Mod updated to {0} on {1}; open sessions: /reload-plugins', [o.version, o.label]) };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    root: ROOT,
    version: readPackageVersion(ROOT),
    claude: makeClaudeRunner(parsed.claudeCmd),
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[mod] Error: {0}', [err.message]) : tr('[mod] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
