// Server configuration from the environment variables (documented in server/README.md).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeDirs } from './accounts/detect';
import { parseAllowedHosts } from './http/guard';
import { parseRemoteConfig, type RemoteConfig } from './http/remote';
import { parseGithubRepo } from './updates/checker';
import { tr } from '../shared/i18n';

export interface ServerConfig {
  port: number;
  host: string;
  /** `--dev`: Vite in middleware mode (HMR) on the same server. */
  dev: boolean;
  /** Turns on the demo simulator at startup. */
  demo: boolean;
  /** Running inside a container (PIDs in the registry are the host's: they cannot be checked). */
  inDocker: boolean;
  home: string;
  /** Watched Claude Code config dirs (one per account). */
  claudeDirs: string[];
  /** Where Habblaud keeps its own state (persisted names). */
  dataDir: string;
  /**
   * Folder with the usage captured by the Claude Code statusline (scripts/statusline-tap.mjs):
   * HABBLAUD_USAGE_DIR or ~/.habblaud/usage. In Docker, docker-up mounts this folder at /usage.
   */
  usageDir: string;
  /** Extra names accepted in the Host/Origin header (HABBLAUD_ALLOWED_HOSTS); localhost and IPs always count. */
  allowedHosts: Set<string>;
  /**
   * Terminal (GET /api/agents/:id/terminal) on: only with a local bind, that is, with Habblaud reachable only
   * from the computer itself (see terminalOffReason). It is the lock on everything that shows or acts on the sessions.
   */
  terminal: boolean;
  /**
   * Messages from the office (POST /api/messages and the inbox of the habblaud-mensagens plugin) on: the
   * terminal lock and HABBLAUD_MENSAGENS not turning them off (see messagesOffReason).
   */
  messages: boolean;
  /** Records the office timeline for the timelapse (<dataDir>/timeline); HABBLAUD_TIMELINE=0 turns it off. */
  timeline: boolean;
  /** Project root (where package.json is); serves dist/client from here. */
  rootDir: string;
  version: string;
  /** Repository on GitHub ("owner/name", from the `repository` field of package.json) where new versions come out. */
  repo?: string;
  /** Queries GitHub for a new version (server/updates/checker.ts); HABBLAUD_UPDATE_CHECK=0 turns it off. */
  updateCheck: boolean;
  /** Watches the Codex sessions (sources/codex/); HABBLAUD_CODEX=0 turns it off. */
  codex: boolean;
  /** Second port, with login, for the phone on the local network (http/remote.ts); absent = off. */
  remote?: RemoteConfig;
  /** Why remote access stayed off when the variables are incomplete. */
  remoteWarning?: string;
  /** Habblaud World (server/world/): account, character and, in the next phases, the building in the world. */
  world: WorldConfig;
}

export interface WorldConfig {
  /** HABBLAUD_WORLD different from 0 (false, off, no): the /api/world/* routes exist and the interface shows the section. */
  enabled: boolean;
  /**
   * HTTP(S) base of the world server, without a trailing slash (from HABBLAUD_WORLD_URL or, without it,
   * DEFAULT_WORLD_URL; `wss://` becomes `https://`). Absent = HABBLAUD_WORLD_URL rejected (`warning` says why): the
   * feature stays off and nothing leaves the computer. The WebSocket is the same origin with /v1/socket.
   */
  url?: string;
  /** The URL came from the default (HABBLAUD_WORLD_URL absent or empty). */
  defaultUrl?: true;
  /**
   * `--dev` or HABBLAUD_WORLD_DEV=1: also accepts `http://` and `ws://` for 127.0.0.1 and host.docker.internal (local
   * world server; from the Habblaud container, the host is host.docker.internal).
   */
  dev: boolean;
  /** Why HABBLAUD_WORLD_URL was rejected (goes to the log at startup). */
  warning?: string;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Climbs from `from` until it finds the project's package.json. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'habblaud') return dir;
      } catch {
        // package.json unreadable: keeps climbing
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

/** Version and repository from package.json. */
function readPackage(rootDir: string): { version: string; repo?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown; repository?: unknown };
    return { version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', repo: parseGithubRepo(pkg.repository) };
  } catch {
    return { version: '0.0.0' };
  }
}

export function detectDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HABBLAUD_IN_DOCKER !== undefined) return isTruthy(env.HABBLAUD_IN_DOCKER);
  return existsSync('/.dockerenv');
}

/**
 * Listen address that only the computer itself reaches: 127.0.0.0/8, `::1` (with or without brackets)
 * or `localhost`. `0.0.0.0`, `::`, network IPs and any other names do not count.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    // Canonical form (0:0:0:0:0:0:0:1 -> [::1]).
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Why the terminal stays off (undefined = on). The transcripts have the whole conversation, so it
 * only turns on when Habblaud is not exposed beyond the computer itself:
 * - Node: HABBLAUD_HOST must be loopback;
 * - Docker: the process always listens on 0.0.0.0 inside the container and what decides the exposure is the port
 *   published on the host, HABBLAUD_BIND (docker-compose.yml passes the same value on to the container). Absent
 *   or empty = off: without it there is no way to know whether the port is exposed.
 * HABBLAUD_TERMINAL with any value that is not "on" (0, false, off...) turns it off; there is no way
 * to turn it on with the port exposed.
 */
export function terminalOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_TERMINAL?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_TERMINAL=${flag}`;
  if (inDocker) {
    const bind = env.HABBLAUD_BIND?.trim();
    if (!bind) return tr("HABBLAUD_BIND didn't reach the container, so the port may be exposed on the network");
    return isLoopbackBind(bind) ? undefined : tr('the port is exposed on the network: HABBLAUD_BIND={0}', [bind]);
  }
  return isLoopbackBind(host) ? undefined : tr('the port is exposed on the network: HABBLAUD_HOST={0}', [host]);
}

/**
 * Why the messages from the office stay off (undefined = on). They enter the session as if you
 * had typed them, so they follow the terminal lock; HABBLAUD_MENSAGENS with any value that is not
 * "on" (0, false, off, no...) turns off only them.
 */
export function messagesOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_MENSAGENS?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_MENSAGENS=${flag}`;
  const terminal = terminalOffReason(env, host, inDocker);
  return terminal ? tr('same lock as the terminal: {0}', [terminal]) : undefined;
}

/**
 * The Habblaud World server when HABBLAUD_WORLD_URL is missing or empty: World comes on by default, but nothing
 * leaves the computer before the person creates the account and signs in (server/world/service.ts).
 * HABBLAUD_WORLD=0 turns everything off.
 */
export const DEFAULT_WORLD_URL = 'https://server.habblaud.com';

/** Hosts accepted without TLS in development mode: the computer itself and, from inside Docker, the host. */
const LOCAL_WORLD_HOSTS: readonly string[] = ['127.0.0.1', 'host.docker.internal'];

/**
 * Habblaud World from the environment. Without HABBLAUD_WORLD_URL, DEFAULT_WORLD_URL. The URL is only valid with
 * `https://` or `wss://` (the device token never travels without TLS); `http://` and `ws://` only in development mode
 * and only for 127.0.0.1 or host.docker.internal (the world server running on the computer itself, seen from outside
 * or from inside Docker). No path, user, password or parameters: only the server address. A URL that is set and
 * rejected does not fall back to the default: the feature stays off, with the reason in `warning`.
 */
export function parseWorldConfig(env: NodeJS.ProcessEnv, argv: string[]): WorldConfig {
  const flag = env.HABBLAUD_WORLD?.trim();
  const enabled = !flag || isTruthy(flag);
  const dev = argv.includes('--dev') || isTruthy(env.HABBLAUD_WORLD_DEV);
  if (!enabled) return { enabled, dev };
  const raw = env.HABBLAUD_WORLD_URL?.trim();
  if (!raw) return { enabled, dev, url: DEFAULT_WORLD_URL, defaultUrl: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL is not a valid address') };
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const local = (u.protocol === 'http:' || u.protocol === 'ws:') && LOCAL_WORLD_HOSTS.includes(u.hostname);
  if (!secure && !(local && dev)) {
    return {
      enabled,
      dev,
      warning: local
        ? tr('HABBLAUD_WORLD_URL with http:// (127.0.0.1 or host.docker.internal) only works in development mode (--dev or HABBLAUD_WORLD_DEV=1)')
        : tr('HABBLAUD_WORLD_URL must start with https:// or wss://'),
    };
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL must contain only the server address (no path, user, password or parameters)') };
  }
  return { enabled, dev, url: `${secure ? 'https:' : 'http:'}//${u.host}` };
}

/** Address of the world WebSocket from the HTTP(S) base (ServerConfig.world.url). */
export function worldSocketUrl(base: string): string {
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/socket`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  const host = env.HABBLAUD_HOST?.trim() || '127.0.0.1';
  const pkg = readPackage(rootDir);
  const remote = parseRemoteConfig(env, inDocker);
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host,
    dev: argv.includes('--dev'),
    demo: isTruthy(env.HABBLAUD_DEMO),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.HABBLAUD_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.habblaud'))),
    usageDir: resolve(env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage')),
    allowedHosts: parseAllowedHosts(env.HABBLAUD_ALLOWED_HOSTS),
    terminal: terminalOffReason(env, host, inDocker) === undefined,
    messages: messagesOffReason(env, host, inDocker) === undefined,
    timeline: !env.HABBLAUD_TIMELINE?.trim() || isTruthy(env.HABBLAUD_TIMELINE),
    rootDir,
    version: pkg.version,
    repo: pkg.repo,
    updateCheck: !env.HABBLAUD_UPDATE_CHECK?.trim() || isTruthy(env.HABBLAUD_UPDATE_CHECK),
    codex: !env.HABBLAUD_CODEX?.trim() || isTruthy(env.HABBLAUD_CODEX),
    remote: remote.config,
    remoteWarning: remote.warning,
    world: parseWorldConfig(env, argv),
  };
}
