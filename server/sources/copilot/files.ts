// Files of a Copilot CLI folder (COPILOT_HOME, ~/.copilot) that the source reads, and nothing else:
// - session-state/<session>/events.jsonl (the session's events, see events.ts);
// - session-state/<session>/workspace.yaml (session id, working folder, creation time, client name);
// - open-sessions-state.json (the sessions Copilot considers open: only a hint, see source.ts).
// config.json, permissions-config.json, session-store.db*, logs/, command-history-state.json, settings.json and
// hooks/ are never opened. Session folder names are validated (UUID) and every file, with links resolved, has to
// stay inside the Copilot folder. Values read here never go to the log.
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isSessionId } from './events';

export const SESSION_STATE_DIR = 'session-state';
export const EVENTS_FILE = 'events.jsonl';
export const WORKSPACE_FILE = 'workspace.yaml';
export const OPEN_SESSIONS_FILE = 'open-sessions-state.json';

/** Largest workspace.yaml read (real ones have a few hundred bytes). */
const WORKSPACE_MAX = 64 * 1024;
/** Largest open-sessions-state.json read. */
const OPEN_SESSIONS_MAX = 1024 * 1024;

/** Is the folder a Copilot one? It has `session-state/` (checked by existence only). */
export function isCopilotHome(p: string): boolean {
  try {
    return statSync(join(p, SESSION_STATE_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/** Session ids (folders with a UUID name, as written) in session-state/. Missing folder = []. */
export function listSessionIds(home: string): string[] {
  try {
    return readdirSync(join(home, SESSION_STATE_DIR)).filter(isSessionId);
  } catch {
    return [];
  }
}

/**
 * Real path of a file of the session (`events.jsonl` or `workspace.yaml`), checked: valid id, a regular file and,
 * with links resolved, inside the Copilot folder. Undefined = missing or refused.
 */
export function sessionFile(home: string, sessionId: string, name: typeof EVENTS_FILE | typeof WORKSPACE_FILE): string | undefined {
  if (!isSessionId(sessionId)) return undefined;
  return insideHome(home, join(home, SESSION_STATE_DIR, sessionId, name));
}

/** The file (with links resolved) if it is a regular file inside the Copilot folder. */
export function insideHome(home: string, path: string): string | undefined {
  try {
    const root = realpathSync(home);
    const real = realpathSync(path);
    if (!real.startsWith(root + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Reads at most `max` bytes from the start of a file (synchronous). Undefined = unreadable. */
function readSmall(path: string, max: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = Math.min(fstatSync(fd).size, max);
    const buf = Buffer.alloc(size);
    const n = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------ workspace.yaml

export interface WorkspaceInfo {
  id?: string;
  cwd?: string;
  createdAt?: number;
  clientName?: string;
}

/**
 * Value of a `key: value` line. Quoted ('…' or "…"): what is between the quotes, with the quote escapes ('' in single
 * quotes, \" and \\ in double quotes) undone and a ` #` inside kept; after the closing quote only a comment may
 * follow. Plain: a comment starts at a `#` after a space (as in YAML). A quote that never closes counts as plain text.
 */
function scalar(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === "'" || q === '"') {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (q === "'" && c === "'") {
        if (v[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return out;
      }
      if (q === '"' && c === '\\' && (v[i + 1] === '"' || v[i + 1] === '\\')) {
        out += v[++i];
        continue;
      }
      if (q === '"' && c === '"') return out;
      out += c;
    }
  }
  return v.replace(/\s+#.*$/, '').trim();
}

/**
 * Tiny reader of workspace.yaml: only top-level `key: value` lines. Indented lines (nested maps), comments, list
 * items and keys without a value are skipped; quotes around the value are removed (a ` #` comment is stripped only outside them). Not a
 * YAML parser: the server has no runtime dependencies and only needs a handful of plain fields.
 */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || /^\s/.test(raw) || raw.startsWith('#') || raw.startsWith('-')) continue;
    const m = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/.exec(raw);
    if (!m || m[2] === undefined) continue;
    const value = scalar(m[2]);
    if (value && !(m[1] in out)) out[m[1]] = value;
  }
  return out;
}

/** The fields of workspace.yaml that Habblaud uses. */
export function workspaceInfo(text: string): WorkspaceInfo {
  const y = parseWorkspaceYaml(text);
  const info: WorkspaceInfo = {};
  if (y.id && isSessionId(y.id)) info.id = y.id.toLowerCase();
  if (y.cwd) info.cwd = y.cwd;
  const created = y.created_at ? Date.parse(y.created_at) : NaN;
  if (!Number.isNaN(created)) info.createdAt = created;
  if (y.client_name) info.clientName = y.client_name.slice(0, 60);
  return info;
}

/** workspace.yaml of the session ({} = missing or unreadable). */
export function readWorkspace(home: string, sessionId: string): WorkspaceInfo {
  const path = sessionFile(home, sessionId, WORKSPACE_FILE);
  const text = path ? readSmall(path, WORKSPACE_MAX) : undefined;
  return text ? workspaceInfo(text) : {};
}

// ------------------------------------------------------------------ open-sessions-state.json

/**
 * Sessions listed in open-sessions-state.json (`{<uuid>: {schemaVersion, openedAt, refreshedAt, working}}`); null =
 * missing or unreadable. Only a hint: the file can still list sessions that already shut down (and, in Docker, a
 * single-file mount can go stale).
 */
export function readOpenSessions(home: string): Set<string> | null {
  const path = insideHome(home, join(home, OPEN_SESSIONS_FILE));
  const text = path ? readSmall(path, OPEN_SESSIONS_MAX) : undefined;
  if (text === undefined) return null;
  try {
    const j = JSON.parse(text) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return new Set();
    return new Set(Object.keys(j).filter(isSessionId).map((k) => k.toLowerCase()));
  } catch {
    return new Set();
  }
}
