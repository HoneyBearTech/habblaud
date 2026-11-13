// Brings up (or takes down) Habblaud in the local Docker. Runs on the HOST, with tsx:
//
//   npm run docker:up                 # detects the accounts, generates the override, builds and brings it up
//   npm run docker:up -- --no-build   # brings it up without rebuilding the image
//   npm run docker:down               # takes down the container
//
// What it does when bringing it up:
// 1. Finds the Claude Code config dirs on the host (same rule as the server: ~/.claude*,
//    CLAUDE_CONFIG_DIR or HABBLAUD_CLAUDE_DIRS) and reads the accounts' metadata with detectAccounts.
// 2. Generates docker-compose.override.yml mounting ONLY <account>/projects and <account>/sessions,
//    read-only, at /claude/<account>/... — never the account's whole folder, where credentials
//    and settings are — and the folder of the usage captured by the statusline
//    (~/.habblaud/usage, created if missing) at /usage, also read-only. Passes
//    HABBLAUD_CLAUDE_DIRS, HABBLAUD_ACCOUNTS, HABBLAUD_USAGE_DIR and the host's time zone (TZ) to the container.
//    Codex accounts (~/.codex*, CODEX_HOME or HABBLAUD_CODEX_DIRS; HABBLAUD_CODEX=0 turns it off): ONLY
//    sessions/, archived_sessions/ and thread-writer-locks/ of each one, read-only, at /codex/<account>/... —
//    never auth.json, config.toml, shell_snapshots/, history.jsonl, logs or the SQLite files. They go in
//    HABBLAUD_CODEX_DIRS and, with `provider: 'codex'` and the HOST folder (where `codex queue` runs), in
//    HABBLAUD_ACCOUNTS.
// 3. Migrates what is left of the old name (CodeTown, up to 0.3.2): ~/.codetown becomes ~/.habblaud, the
//    `codetown` container and the codetown_default network are removed and, if the new volume doesn't exist yet,
//    the data from codetown_codetown-data is copied into it (the old one stays, to delete by hand). Warns about
//    CODETOWN_* in the environment and in .env, which no longer apply.
// 4. Runs `docker compose up -d --build`, waits for /api/health and shows the URL.
// 5. Says at the end whether Habblaud World is on (HABBLAUD_WORLD_URL from the environment or from .env, checked as
//    the server checks it) and for which server; without the variable, it comes on pointing at server.habblaud.com
//    ("(default)"), and HABBLAUD_WORLD=0 turns everything off.
// 6. Updates the Habblaud mod in the accounts where it is ALREADY installed with another version (after
//    updating Habblaud): rereads the marketplace from this folder and runs `claude plugin update` with each
//    account's CLAUDE_CONFIG_DIR. Never installs by itself; if `claude` is missing or fails, it is only a warning.
//    In an account with the mod and without the messages plugin (which came later), it only gives the tip to run
//    npm run mod:install.
//
// Live 5h/weekly usage: the Habblaud mod (npm run mod:install; Claude Code 2.1.287+) or, in
// earlier versions, the statusline tap (npm run usage:install). Both write the numbers to the folder
// mounted at /usage. Without them, the /usage cache read from the accounts at startup is used.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AccountInfo, SourceInfo } from '../shared/types';
import { codexDirsRefused, detectAccounts, discoverClaudeDirs, type DetectedAccount } from '../server/accounts/detect';
import { detectCodexAccounts, discoverCodexDirs } from '../server/sources/codex/accounts';
import { describeStateMigration, LEGACY_NAME, legacyEnvWarning, migrateLegacyStateDir } from '../server/legacy';
import { makeClaudeRunner, MIN_CLAUDE_VERSION, readPackageVersion, updateInstalledMods, type ModUpdateResult } from './mod-install';
import { tr } from '../shared/i18n';
import { readEnvValue } from '../server/remote/envfile';
import { parseWorldConfig } from '../server/config';
import { ensureServerCert, remoteTargets, remoteTlsBase, tlsPaths } from '../server/remote/tls';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || homedir();
const STATE_DIR = join(HOME, '.habblaud');
const OVERRIDE_FILE = join(ROOT, 'docker-compose.override.yml');
/** This folder's .env, which Compose reads by itself. */
const ENV_FILE = join(ROOT, '.env');
/** Usage captured on the host by the Habblaud mod or by the statusline tap (scripts/statusline-tap.mjs). */
const USAGE_DIR = process.env.HABBLAUD_USAGE_DIR?.trim() ? resolve(process.env.HABBLAUD_USAGE_DIR.trim()) : join(STATE_DIR, 'usage');
/** Where that folder appears in the container. */
const CONTAINER_USAGE_DIR = '/usage';
/** Where the container reads the remote access certificate (server/http/remote.ts). */
const CONTAINER_REMOTE_TLS_DIR = '/remote-tls';
const SERVICE = 'habblaud';
/** Root of the mounts inside the container: /claude/<account>/{projects,sessions}. */
const CONTAINER_ROOT = '/claude';
/** Only these subfolders of each account go into the container. */
const MOUNTED_SUBDIRS = ['projects', 'sessions'] as const;
/** Root of the Codex mounts inside the container: /codex/<account>/{sessions,archived_sessions,thread-writer-locks}. */
const CODEX_CONTAINER_ROOT = '/codex';
/**
 * Only these subfolders of each Codex folder go into the container (the conversations and the locks of the open sessions).
 * auth.json, config.toml, shell_snapshots/, history.jsonl, logs and the SQLite files stay on the host.
 */
export const CODEX_MOUNTED_SUBDIRS = ['sessions', 'archived_sessions', 'thread-writer-locks'] as const;
const DEFAULT_PORT = 4747;
const HEALTH_TIMEOUT_MS = 120_000;
/** Image and data volume as Compose names them (`name: habblaud` in docker-compose.yml). */
const IMAGE = 'habblaud:local';
const DATA_VOLUME = 'habblaud_habblaud-data';
/** The same in CodeTown (up to 0.3.2), only for the migration: fixed container_name, default network, volume and image. */
const LEGACY_DOCKER = {
  container: LEGACY_NAME,
  network: `${LEGACY_NAME}_default`,
  volume: `${LEGACY_NAME}_${LEGACY_NAME}-data`,
  image: `${LEGACY_NAME}:local`,
} as const;

const USAGE = tr("Usage: npm run docker:up [-- options]\n\nOptions:\n  --no-build   starts without rebuilding the image\n  --down       stops the container (same as npm run docker:down)\n  -h, --help   shows this help\n\nVariables: HABBLAUD_PORT (host port, default {0}), HABBLAUD_CLAUDE_DIRS\n(comma-separated config dirs, if the accounts aren't in ~/.claude*), HABBLAUD_CODEX_DIRS\n(Codex folders, if they aren't in ~/.codex* or CODEX_HOME) and HABBLAUD_CODEX=0 (without Codex).", [DEFAULT_PORT]);

// ---------------------------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------------------------

const say = (msg: string) => console.log(`[docker-up] ${msg}`);
const warn = (msg: string) => console.warn(tr('[docker-up] Warning: {0}', [msg]));

class FatalError extends Error {}

function fail(msg: string): never {
  throw new FatalError(msg);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const USAGE_STATUS: Record<AccountInfo['usageStatus'], string> = {
  ok: tr('usage up to date'),
  stale: tr('usage outdated'),
  disabled: tr('no usage data'),
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export interface Options {
  down: boolean;
  build: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { down: false, build: true, help: false };
  for (const arg of argv) {
    if (arg === '--down') opts.down = true;
    else if (arg === '--no-build') opts.build = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else fail(tr('unknown option: {0}\n\n{1}', [arg, USAGE]));
  }
  return opts;
}

export function hostPort(env: NodeJS.ProcessEnv): number {
  const raw = env.HABBLAUD_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(tr('Invalid HABBLAUD_PORT: "{0}" (use a number from 1 to 65535).', [raw]));
  return port;
}

// ---------------------------------------------------------------------------------------------
// Mount plan and Compose override (pure functions, no side effects)
// ---------------------------------------------------------------------------------------------

export interface BindMount {
  /** Real path on the host (symlinks resolved: Docker Desktop doesn't follow them). */
  source: string;
  /** Path inside the container. */
  target: string;
}

export interface AccountMount {
  account: DetectedAccount;
  /** The account's config dir on the host. */
  hostDir: string;
  /** Where the account appears in the container: /claude/<id>. */
  mountDir: string;
  binds: BindMount[];
}

/** Usage windows the server shows (the other cache keys are ignored). */
const USAGE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

type CachedWindow = { utilization: unknown; resets_at?: unknown };
type CachedUsage = { fetchedAtMs: unknown; utilization: Partial<Record<(typeof USAGE_WINDOWS)[number], CachedWindow>> };

export interface AccountPayload {
  id: string;
  /** Only on Codex accounts (absent = Claude Code). */
  provider?: 'codex';
  configDir: string;
  mountDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: CachedUsage;
}

/** Real path of an existing folder, or undefined. */
function realDir(p: string): string | undefined {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mounts only projects/ and sessions/ of each account (the ones that exist). `accounts` comes from
 * detectAccounts(dirs) and is in the same order as `dirs`; the id (disambiguated basename) becomes the
 * folder name in the container, so the server in there derives exactly the same id.
 */
export function planMounts(dirs: string[], accounts: DetectedAccount[], resolveDir: (p: string) => string | undefined = realDir): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    for (const sub of MOUNTED_SUBDIRS) {
      const source = resolveDir(join(hostDir, sub));
      if (source) binds.push({ source, target: posix.join(mountDir, sub) });
    }
    if (binds.length) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/**
 * Mounts only sessions/, archived_sessions/ and thread-writer-locks/ of each Codex folder (the ones that exist), in
 * /codex/<id>. `accounts` comes from detectCodexAccounts(dirs), in the same order as `dirs`; the id becomes the
 * folder name in the container, so the server in there derives the same id.
 */
export function planCodexMounts(dirs: string[], accounts: DetectedAccount[], resolveDir: (p: string) => string | undefined = realDir): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CODEX_CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    for (const sub of CODEX_MOUNTED_SUBDIRS) {
      const source = resolveDir(join(hostDir, sub));
      if (source) binds.push({ source, target: posix.join(mountDir, sub) });
    }
    if (binds.length) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/** Metadata of the Codex accounts for HABBLAUD_ACCOUNTS: `provider: 'codex'` and the HOST folder in `configDir`. */
export function codexAccountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, hostDir, mountDir }) => {
    const p: AccountPayload = { id: a.id, provider: 'codex', configDir: hostDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.plan) p.plan = a.plan;
    return p;
  });
}

/** HABBLAUD_CODEX turned off (0, false, off, no) in the environment of whoever runs docker:up. */
export function codexDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.HABBLAUD_CODEX?.trim();
  return !!v && !/^(1|true|yes|sim|on)$/i.test(v);
}

/**
 * From the Claude Code usage cache (`cachedUsageUtilization`) only the collection date goes through and, for
 * each window shown, the percentage and the reset time. Account identifiers, spending and
 * the other fields stay out (the container's environment is visible in `docker inspect`).
 */
export function sanitizeCachedUsage(raw: unknown): CachedUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const fetchedAtMs = c.fetchedAtMs ?? c.fetchedAt;
  if (fetchedAtMs === undefined || !c.utilization || typeof c.utilization !== 'object') return undefined;
  const util = c.utilization as Record<string, unknown>;
  const out: CachedUsage = { fetchedAtMs, utilization: {} };
  for (const key of USAGE_WINDOWS) {
    const w = util[key];
    if (!w || typeof w !== 'object') continue;
    const { utilization, resets_at } = w as Record<string, unknown>;
    if (utilization === undefined || utilization === null) continue;
    out.utilization[key] = resets_at === undefined || resets_at === null ? { utilization } : { utilization, resets_at };
  }
  return Object.keys(out.utilization).length ? out : undefined;
}

/** Metadata of the accounts for HABBLAUD_ACCOUNTS (the container does not see the host's .claude.json). */
export function accountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, mountDir }) => {
    const p: AccountPayload = { id: a.id, configDir: a.configDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.email) p.email = a.email;
    if (a.organization) p.organization = a.organization;
    if (a.plan) p.plan = a.plan;
    const cached = sanitizeCachedUsage(a.cachedUsage);
    if (cached) p.cachedUsage = cached;
    return p;
  });
}

/**
 * Safe YAML scalar: JSON string (valid as a double-quoted YAML string) with `$`
 * doubled, so that Compose does not try to interpolate variables inside the values.
 */
export function yamlString(value: string): string {
  return JSON.stringify(value.replaceAll('$', '$$$$'));
}

/**
 * Host time zone (TZ or the system's), for the container: without it the container's Node uses UTC and
 * the "day" of the timelapse and of the day panel would roll over at 21:00 Brasília time. Undefined if invalid.
 */
export function hostTimeZone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let tz = env.TZ?.trim().replace(/^:/, '');
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }
  return tz && /^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz) ? tz : undefined;
}

/**
 * `usageDir`: host folder with the usage captured by the statusline tap (already existing; real path),
 * mounted read-only at /usage. `timeZone`: the host's time zone, passed on as TZ. `codex`: mounts of the Codex
 * accounts (planCodexMounts).
 */
export function renderOverride(
  mounts: AccountMount[],
  generatedAt: Date = new Date(),
  usageDir?: string,
  timeZone?: string,
  codex: AccountMount[] = [],
  remoteTlsDir?: string,
  extraPorts: string[] = [],
): string {
  const env: Array<[string, string]> = [
    ['HABBLAUD_CLAUDE_DIRS', mounts.map((m) => m.mountDir).join(',')],
    ['HABBLAUD_ACCOUNTS', JSON.stringify([...accountsPayload(mounts), ...codexAccountsPayload(codex)])],
  ];
  if (codex.length) env.push(['HABBLAUD_CODEX_DIRS', codex.map((m) => m.mountDir).join(',')]);
  if (usageDir) env.push(['HABBLAUD_USAGE_DIR', CONTAINER_USAGE_DIR]);
  if (timeZone) env.push(['TZ', timeZone]);
  const lines = [
    `# Generated by scripts/docker-up.ts at ${generatedAt.toISOString()} — do not edit: it is recreated on every \`npm run docker:up\`.`,
    '# Contains host paths and the emails of the accounts: it stays out of git and has permission 600.',
    '# Mounts: ONLY <account>/projects, <account>/sessions and the statusline usage folder, all read-only.',
    ...(codex.length ? ['# Codex: ONLY <folder>/sessions, <folder>/archived_sessions and <folder>/thread-writer-locks, read-only.'] : []),
    'services:',
    `  ${SERVICE}:`,
    '    environment:',
    ...env.map(([k, v]) => `      ${k}: ${yamlString(v)}`),
  ];
  // Compose merges these ports with the ones in docker-compose.yml.
  if (extraPorts.length) lines.push('    ports:', ...extraPorts.map((p) => `      - ${yamlString(p)}`));
  const binds = [...mounts, ...codex].flatMap((m) => m.binds);
  if (usageDir) binds.push({ source: usageDir, target: CONTAINER_USAGE_DIR });
  // Remote access: ONLY the server certificate's folder (the CA key stays on the host).
  if (remoteTlsDir) binds.push({ source: remoteTlsDir, target: CONTAINER_REMOTE_TLS_DIR });
  if (binds.length) {
    lines.push('    volumes:');
    for (const b of binds) {
      lines.push(
        '      - type: bind',
        `        source: ${yamlString(b.source)}`,
        `        target: ${yamlString(b.target)}`,
        '        read_only: true',
        '        bind:',
        '          create_host_path: false',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Hint at the end of docker:up about the mod: it only shows when no account has the mod installed (whoever already
 * installed it gets the automatic update, or a notice). Without the Claude Code CLI, there is no way to know: it
 * stays quiet.
 */
export function modHint(mod: Pick<ModUpdateResult, 'installed' | 'unavailable'>): string[] {
  if (mod.installed || mod.unavailable) return [];
  return [
    tr('  Live 5h/weekly usage, replying and sending messages from the office: npm run mod:install (once; Claude Code {0}+).', [MIN_CLAUDE_VERSION]),
    tr('  On earlier Claude Code versions: npm run usage:install and npm run hooks:install. Without them, the /usage cache is used.'),
  ];
}

// ---------------------------------------------------------------------------------------------
// Old name (CodeTown, up to 0.3.2): plan for the startup in Docker and names from the .env (pure functions)
// ---------------------------------------------------------------------------------------------

/** What already exists in Docker before starting. */
export interface DockerState {
  /** CodeTown's `codetown` container (fixed container_name: it holds the name and the port). */
  legacyContainer: boolean;
  /** The codetown_default network. */
  legacyNetwork: boolean;
  /** The codetown_codetown-data volume (character names, timeline, statistics). */
  legacyVolume: boolean;
  /** The codetown:local image. */
  legacyImage: boolean;
  /** Habblaud's data volume (habblaud_habblaud-data). */
  dataVolume: boolean;
}

export type UpStep =
  | { kind: 'remove-container'; name: string }
  | { kind: 'remove-network'; name: string }
  | { kind: 'compose'; args: string[] }
  | { kind: 'copy-volume'; from: string; to: string };

export interface UpPlan {
  steps: UpStep[];
  /** Commands to delete what is left of CodeTown, shown at the end when this startup migrated something. */
  cleanup: string[];
}

/**
 * Steps to start Habblaud. First, it gets the CodeTown container and its network out of the way. If the old volume
 * exists and the new one does not yet, the data is copied: Compose creates the volume (with its labels; a volume
 * created by hand causes a warning and a request to recreate it) and the container, still stopped; the copy goes in
 * and only then does it start. The old volume is never deleted here.
 */
export function planUp(state: DockerState, build: boolean): UpPlan {
  const steps: UpStep[] = [];
  if (state.legacyContainer) steps.push({ kind: 'remove-container', name: LEGACY_DOCKER.container });
  if (state.legacyNetwork) steps.push({ kind: 'remove-network', name: LEGACY_DOCKER.network });
  const copy = state.legacyVolume && !state.dataVolume;
  if (copy) {
    steps.push(
      { kind: 'compose', args: build ? ['up', '--no-start', '--build'] : ['up', '--no-start'] },
      { kind: 'copy-volume', from: LEGACY_DOCKER.volume, to: DATA_VOLUME },
      { kind: 'compose', args: ['up', '-d'] },
    );
  } else steps.push({ kind: 'compose', args: build ? ['up', '-d', '--build'] : ['up', '-d'] });

  const cleanup: string[] = [];
  if (state.legacyContainer || copy) {
    if (state.legacyVolume) cleanup.push(`docker volume rm ${LEGACY_DOCKER.volume}`);
    if (state.legacyImage) cleanup.push(`docker image rm ${LEGACY_DOCKER.image}`);
  }
  return { steps, cleanup };
}

/**
 * Throwaway `docker run` that copies the volume `from` (read-only) to `to` with Habblaud's own
 * image, as root (it runs as `node`) and without network; the root of `to` gets the owner and the permissions of
 * the root of `from`. The --rm takes along the anonymous volume of the image's VOLUME /data.
 */
export function copyVolumeArgs(from: string, to: string, image: string = IMAGE): string[] {
  const script = 'set -e; cp -a /from/. /to/; chown "$(stat -c %u:%g /from)" /to; chmod "$(stat -c %a /from)" /to';
  const flags = ['--rm', '--pull', 'never', '--network', 'none', '--no-healthcheck', '--user', '0:0', '--entrypoint', 'sh'];
  return ['run', ...flags, '-v', `${from}:/from:ro`, '-v', `${to}:/to`, image, '-c', script];
}

/** Names of the variables in a .env (lines `NOME=valor`, with or without `export`). The values stay out. */
export function envFileKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** The Habblaud World variables that docker-compose.yml passes on to the container. */
const WORLD_ENV_KEYS = ['HABBLAUD_WORLD', 'HABBLAUD_WORLD_URL', 'HABBLAUD_WORLD_DEV'] as const;

/**
 * The Habblaud World line at the end of docker:up: what the container will read (the environment wins over the .env,
 * as in Compose), checked by the same parseWorldConfig as the server (in the container there is no `--dev`: only
 * HABBLAUD_WORLD_DEV). Shows only the already normalized address, never the raw value (which could have a user and
 * password).
 */
export function worldLine(env: NodeJS.ProcessEnv, envFile = ''): string {
  const vars: NodeJS.ProcessEnv = {};
  for (const key of WORLD_ENV_KEYS) {
    const value = key in env ? env[key] : readEnvValue(envFile, key);
    if (value !== undefined) vars[key] = value;
  }
  const world = parseWorldConfig(vars, []);
  if (!world.enabled) return tr('Habblaud World: off (HABBLAUD_WORLD={0}).', [vars.HABBLAUD_WORLD?.trim() ?? '0']);
  if (world.url) return world.defaultUrl ? tr('Habblaud World: on: {0} (default)', [world.url]) : tr('Habblaud World: on: {0}', [world.url]);
  return tr('Habblaud World: off ({0}).', [world.warning ?? tr('HABBLAUD_WORLD_URL rejected')]);
}

// ---------------------------------------------------------------------------------------------
// State on the host (~/.habblaud)
// ---------------------------------------------------------------------------------------------

/** This folder's .env ('' without one). */
function readEnvFile(): string {
  try {
    return readFileSync(ENV_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** Warns about the CODETOWN_* variables (old name, ignored) in the environment and in this folder's .env. */
function warnLegacyEnv(): void {
  let fileKeys: string[] = [];
  try {
    fileKeys = envFileKeys(readFileSync(ENV_FILE, 'utf8'));
  } catch {
    // no .env (the normal case) or unreadable: nothing to warn about
  }
  for (const msg of [legacyEnvWarning(Object.keys(process.env)), legacyEnvWarning(fileKeys, tr('in .env'))]) {
    if (msg) warn(msg);
  }
}

/** Moves ~/.codetown (old name) to ~/.habblaud; runs before creating the usage folder, so that it is a rename. */
function migrateStateDir(): void {
  const result = migrateLegacyStateDir(HOME);
  const msg = describeStateMigration(result);
  if (msg) (result.error ? warn : say)(msg);
}

/** Creates the statusline usage folder if it is missing and returns the real path (or undefined, if it fails). */
function ensureUsageDir(): string | undefined {
  try {
    mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
    return realDir(USAGE_DIR);
  } catch (err) {
    warn(tr("couldn't create {0} ({1}); statusline usage won't show up in the container.", [tildify(USAGE_DIR), (err as Error).message]));
    return undefined;
  }
}

function tildify(p: string): string {
  return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

// ---------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------

function checkDocker(): void {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (info.error) fail(tr('the "docker" command wasn\'t found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/'));
  if (info.status !== 0) fail(tr("Docker isn't responding. Open Docker Desktop, wait for it to finish starting and try again."));
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (compose.status !== 0) fail(tr('Docker Compose v2 ("docker compose") isn\'t available. Update Docker Desktop.'));
}

function compose(args: string[], port: number): void {
  // Explicit HABBLAUD_PORT: it wins over a possible .env in the project folder.
  const res = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HABBLAUD_PORT: String(port) } });
  if (res.error) fail(tr('couldn\'t run "docker compose {0}": {1}', [args.join(' '), res.error.message]));
  if (res.status !== 0) fail(tr('"docker compose {0}" failed (code {1}).', [args.join(' '), res.status ?? res.signal]));
}

/** `docker <args>` showing nothing in the terminal: whether it worked, the output and the last line of the error. */
function dockerQuiet(args: string[]): { ok: boolean; out: string; error: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  // The last line from docker is usually just "Run 'docker run --help' for more information".
  const lines = (res.stderr ?? '').split('\n').filter((l) => l.trim() && !/^Run '.*--help'/.test(l));
  const error = res.error?.message || lines.pop()?.trim() || tr('code {0}', [res.status ?? res.signal]);
  return { ok: res.status === 0, out: res.stdout ?? '', error };
}

/** What already exists in Docker from CodeTown and from Habblaud (input of planUp). */
function inspectDocker(): DockerState {
  const exists = (kind: 'network' | 'volume' | 'image', name: string) => dockerQuiet([kind, 'inspect', name]).ok;
  // Only the `codetown` container that really is CodeTown's goes: from the old image or from the old Compose project.
  const { container, image } = LEGACY_DOCKER;
  const c = dockerQuiet(['container', 'inspect', '--format', '{{.Config.Image}} {{index .Config.Labels "com.docker.compose.project"}}', container]);
  const [cImage = '', cProject = ''] = c.out.trim().split(' ');
  const legacyContainer = c.ok && (cImage === image || cProject === LEGACY_NAME);
  if (c.ok && !legacyContainer) warn(tr("there's a container {0} that isn't from CodeTown (image {1}); leaving it as is.", [container, cImage || '?']));
  return {
    legacyContainer,
    legacyNetwork: exists('network', LEGACY_DOCKER.network),
    legacyVolume: exists('volume', LEGACY_DOCKER.volume),
    legacyImage: exists('image', image),
    dataVolume: exists('volume', DATA_VOLUME),
  };
}

/** Copies the data from CodeTown's volume to Habblaud's. Failure is only a warning: the office starts without it. */
function copyVolume(from: string, to: string): boolean {
  // The new volume has to come from Compose: `docker run -v` would create one without its labels.
  if (!dockerQuiet(['volume', 'inspect', to]).ok) {
    warn(tr("Compose didn't create the volume {0}; the CodeTown data wasn't copied and is still in {1}.", [to, from]));
    return false;
  }
  say(tr('Copying CodeTown data (character names, timeline and stats) from {0} to {1}…', [from, to]));
  const res = dockerQuiet(copyVolumeArgs(from, to));
  if (!res.ok) {
    warn(
      tr("couldn't copy the CodeTown data ({0}). The office starts without it; the data is still in {1}.\n", [res.error, from]) +
        tr('  To try again: npm run docker:down && docker volume rm {0} && npm run docker:up', [to]),
    );
    return false;
  }
  say(tr('Data copied; the volume {0} was left intact.', [from]));
  return true;
}

/** Runs the planUp steps. Only Compose and the old container that does not go away bring docker:up down. */
function runPlan(plan: UpPlan, port: number, build: boolean): { copyFailed: boolean } {
  let copyFailed = false;
  let created = false;
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'remove-container': {
        say(tr('Removing the container {0} (CodeTown, the old name)…', [step.name]));
        const res = dockerQuiet(['rm', '-f', step.name]);
        if (!res.ok) fail(tr("couldn't remove the old container {0} ({1}). Remove it with docker rm -f {2} and run again.", [step.name, res.error, step.name]));
        break;
      }
      case 'remove-network': {
        const res = dockerQuiet(['network', 'rm', step.name]);
        if (!res.ok) warn(tr("couldn't remove the old network {0} ({1}); delete it later with docker network rm {2}.", [step.name, res.error, step.name]));
        break;
      }
      case 'copy-volume':
        copyFailed = !copyVolume(step.from, step.to);
        break;
      case 'compose':
        if (step.args.includes('--no-start')) {
          say(tr('{0} the container, still stopped, to receive the CodeTown data…', [build ? tr('Building the image and creating') : tr('Creating')]));
          created = true;
        } else if (created) say(tr('Starting the container…'));
        else say(build ? tr('Building the image and starting the container…') : tr('Starting the container (without rebuilding the image)…'));
        compose(step.args, port);
        break;
    }
  }
  return { copyFailed };
}

interface Health {
  ok: boolean;
  version?: string;
  demo?: boolean;
  docker?: boolean;
  sources?: SourceInfo[];
  accounts?: Array<{ id: string; usageStatus: AccountInfo['usageStatus'] }>;
}

async function fetchHealth(baseUrl: string, timeoutMs: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Health;
    return body?.ok ? body : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

async function waitHealthy(baseUrl: string): Promise<Health | undefined> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl, 3_000);
    if (health) return health;
    await sleep(1_000);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function down(port: number): void {
  checkDocker();
  say(tr('Stopping the container…'));
  compose(['down'], port);
  say(tr('Done. Character names are still stored in the habblaud-data volume.'));
}

async function up(opts: Options, port: number): Promise<void> {
  checkDocker();
  warnLegacyEnv();
  const baseUrl = `http://127.0.0.1:${port}`;
  const publicUrl = `http://localhost:${port}`;

  // Port taken by a Habblaud outside Docker (npm run dev / npm start)?
  const existing = await fetchHealth(baseUrl, 1_500);
  if (existing && !existing.docker) {
    fail(
      tr('a Habblaud is already running outside Docker at {0} (npm run dev or npm start?).\n', [publicUrl]) +
        tr(`Stop it first, or use another port: HABBLAUD_PORT=4848 npm run docker:up`),
    );
  }

  const dirs = discoverClaudeDirs(process.env, HOME);
  const accounts = detectAccounts(dirs, { home: HOME, env: process.env });
  const mounts = planMounts(dirs, accounts);
  if (!mounts.length) {
    warn(
      tr('no Claude Code folder (with projects/ or sessions/) was found in ~/.claude*.\n') +
        tr('  The office will open empty (you can turn on demo mode in the interface).\n') +
        tr('  If the accounts are somewhere else: HABBLAUD_CLAUDE_DIRS=/path/account1,/path/account2 npm run docker:up'),
    );
  }
  for (const m of mounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(' and ');
    say(tr('Account {0} ({1}): mounts {2} from {3}, read-only.', [m.account.short, m.account.id, subdirs, tildify(m.hostDir)]));
  }
  for (const dir of dirs) {
    if (!mounts.some((m) => m.hostDir === dir)) warn(tr('{0} has neither projects/ nor sessions/; account skipped.', [tildify(dir)]));
  }
  // Codex folder (CODEX_HOME) listed or found as if it were Claude Code's: it is not mounted as a Claude account.
  // It goes in (only the conversations and the locks) as a Codex account, just below.
  const claudeRefused = codexDirsRefused(process.env, HOME);
  const codexDirs = codexDisabled(process.env) ? [] : discoverCodexDirs(process.env, HOME);
  for (const dir of claudeRefused) if (!codexDirs.includes(dir)) warn(tr('{0} is a Codex folder, not a Claude Code one; account skipped.', [tildify(dir)]));
  const codexAccounts = detectCodexAccounts(codexDirs, {
    home: HOME,
    env: process.env,
    taken: { shorts: accounts.map((a) => a.short), colors: accounts.map((a) => a.color) },
  });
  const codexMounts = planCodexMounts(codexDirs, codexAccounts);
  for (const m of codexMounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(', ');
    say(tr('Codex {0} ({1}): mounts {2} from {3}, read-only.', [m.account.short, m.account.id, subdirs, tildify(m.hostDir)]));
    if (!m.binds.some((b) => b.target.endsWith('/thread-writer-locks'))) {
      warn(tr("{0} doesn't have thread-writer-locks/ yet: in the container, open session = conversation modified in the last 30 min (run docker:up again after using Codex).", [tildify(m.hostDir)]));
    }
  }

  migrateStateDir();
  const usageDir = ensureUsageDir();
  if (usageDir) say(tr('Live usage (mod or statusline tap): mounts {0} at {1}, read-only.', [tildify(USAGE_DIR), CONTAINER_USAGE_DIR]));
  const remoteTlsDir = prepareRemoteTls();
  const remotePorts = remoteTlsDir || remoteInsecure() ? remotePortsToPublish() : [];
  const tmp = `${OVERRIDE_FILE}.tmp`;
  writeFileSync(tmp, renderOverride(mounts, new Date(), usageDir, hostTimeZone(), codexMounts, remoteTlsDir, remotePorts), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, OVERRIDE_FILE);
  say(tr('docker-compose.override.yml generated.'));

  const plan = planUp(inspectDocker(), opts.build);
  const { copyFailed } = runPlan(plan, port, opts.build);

  say(tr('Waiting for Habblaud to respond at {0}…', [publicUrl]));
  const health = await waitHealthy(baseUrl);
  if (!health) fail(tr("Habblaud didn't respond within {0} s. See what happened with: npm run docker:logs", [HEALTH_TIMEOUT_MS / 1000]));

  console.log('');
  say(tr('Habblaud{0} is up: {1}', [health.version ? ` ${health.version}` : '', publicUrl]));
  for (const acc of accounts) {
    const src = health.sources?.find((s) => s.label === acc.id);
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === acc.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, tr('open session'), tr('open sessions')) : tr('read error ({0})', [src.error ?? tr('unknown')]);
    say(tr('  Account {0} ({1}): {2}{3}', [acc.short, acc.id, state, usage ? ` · ${USAGE_STATUS[usage]}` : '']));
  }
  for (const m of codexMounts) {
    const src = health.sources?.find((s) => s.label === m.account.id && s.provider === 'codex');
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === m.account.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, tr('open session'), tr('open sessions')) : tr('read error ({0})', [src.error ?? tr('unknown')]);
    say(`  Codex ${m.account.short} (${m.account.id}): ${state}${usage ? ` · ${USAGE_STATUS[usage]}` : ''}`);
  }
  for (const line of modHint(updateMods(dirs, accounts))) say(line);
  // With the copy failed, the data only exists in the old volume: no suggesting to delete it.
  if (plan.cleanup.length && !copyFailed) say(tr('  Left over from CodeTown; after checking the office, delete with: {0}', [plan.cleanup.join(' · ')]));
  say(`  ${worldLine(process.env, readEnvFile())}`);
  say(tr('  Logs: npm run docker:logs · Stop: npm run docker:down'));
}

/**
 * Remote access turned on in the .env (npm run remote:setup): checks the server certificate and remakes it when the
 * Wi-Fi IP changed or it is close to expiring (the CA stays the same, so the phone keeps trusting it). Returns the
 * folder to mount.
 */
function prepareRemoteTls(): string | undefined {
  let env = '';
  try {
    env = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return undefined;
  }
  if (!readEnvValue(env, 'HABBLAUD_REMOTE_USER')) return undefined;
  const paths = tlsPaths(remoteTlsBase(HOME));
  if (!statOk(paths.caCert)) {
    warn(tr('remote access configured, but no local CA: run npm run remote:setup.'));
    return undefined;
  }
  try {
    const targets = remoteTargets({ name: readEnvValue(env, 'HABBLAUD_REMOTE_NAME'), domain: readEnvValue(env, 'HABBLAUD_REMOTE_DOMAIN') });
    const r = ensureServerCert(paths, targets);
    if (r.issued) say(tr('Remote access: server certificate renewed ({0}).', [r.reason]));
    say(tr('Remote access: mounts {0} at {1}, read-only.', [tildify(paths.serverDir), CONTAINER_REMOTE_TLS_DIR]));
    return paths.serverDir;
  } catch (err) {
    warn(tr("remote access: couldn't check the certificate ({0}).", [(err as Error).message]));
    return statOk(paths.serverCert) ? paths.serverDir : undefined;
  }
}

/**
 * Ports for access from the phone, only with it configured (HABBLAUD_REMOTE_USER in the .env): the remote one
 * (HABBLAUD_REMOTE_PORT, default 4748) and, if there is one, HABBLAUD_REMOTE_HTTP_PORT (the setup writes 80 when the
 * remote one is 443), which lands on the same container port and answers HTTP with 308 to https:// — whoever types
 * just "meuclaude.local" lands on HTTPS. Without the setup, nothing is published besides 4747.
 */
export function remotePortsFrom(env: string): string[] {
  if (!readEnvValue(env, 'HABBLAUD_REMOTE_USER')) return [];
  const bind = readEnvValue(env, 'HABBLAUD_REMOTE_BIND') || '127.0.0.1';
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;
  const raw = readEnvValue(env, 'HABBLAUD_REMOTE_PORT');
  const port = raw ? Number(raw) : 4748;
  const out = valid(port) ? [`${bind}:${port}:4748`] : [];
  const http = Number(readEnvValue(env, 'HABBLAUD_REMOTE_HTTP_PORT'));
  if (valid(http) && http !== port) out.push(`${bind}:${http}:4748`);
  return out;
}

function remoteInsecure(): boolean {
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    return !!readEnvValue(env, 'HABBLAUD_REMOTE_USER') && /^(1|true|yes|sim|on)$/i.test(readEnvValue(env, 'HABBLAUD_REMOTE_INSECURE_HTTP') ?? '');
  } catch {
    return false;
  }
}

function remotePortsToPublish(): string[] {
  try {
    const ports = remotePortsFrom(readFileSync(ENV_FILE, 'utf8'));
    for (const p of ports) say(tr('Remote access: publishes {0} (container port {1}).', [p.split(':').slice(0, 2).join(':'), 4748]));
    return ports;
  } catch {
    return [];
  }
}

function statOk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Updates the mod for whoever already installed it (see mod-install.ts). Nothing here brings docker:up down. */
function updateMods(dirs: string[], accounts: DetectedAccount[]): Pick<ModUpdateResult, 'installed' | 'unavailable'> {
  try {
    const labels = dirs.map((dir, i) => ({ dir, label: tr('Account {0}', [accounts[i]?.short ?? tildify(dir)]) }));
    const mod = updateInstalledMods(labels, { env: process.env, home: HOME, root: ROOT, version: readPackageVersion(ROOT), claude: makeClaudeRunner() });
    for (const l of mod.lines) {
      if (l.level === 'warn') warn(l.text);
      else say(`  ${l.text}`);
    }
    return mod;
  } catch (err) {
    warn(tr("couldn't check the Habblaud mod ({0}).", [(err as Error).message]));
    return { installed: false, unavailable: true };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const port = hostPort(process.env);
  if (opts.down) down(port);
  else await up(opts, port);
}

// Runs only when called directly (importing the module, e.g. in tests, starts nothing).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    if (err instanceof FatalError) console.error(tr('[docker-up] Error: {0}', [err.message]));
    else console.error(tr('[docker-up] Unexpected error:'), err);
    process.exitCode = 1;
  });
}
