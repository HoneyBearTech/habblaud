// API routes (/api/*). JSON responses; unknown routes -> 404 JSON.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NAME_MAX, parseAppearanceParts, parseCharacterName, parseSeed } from '../../shared/appearance';
import type { AccessInfo, AgentInfo, ModSummary, OfficeSnapshot, SourceInfo, UpdateStatus } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import { handleCodexEvent } from '../codex/http';
import type { DayStatsService } from '../history/daystats';
import type { Office } from '../model/office';
import type { CodexLive } from '../sources/codex/live';
import type { SessionLookup } from '../sources/source';
import { isJsonContentType, isLoopbackHost } from './guard';
import type { RemoteFeature } from './remote';
import { handleSessionsRoute } from './sessions';
import type { Hub } from './sse';
import { handleStatsRoute } from './stats';
import type { TerminalStreams } from './terminal';
import { tr } from '../../shared/i18n';
import type { SpawnService } from '../spawn/spawn';
import { ATTACHMENT_BODY_MAX, parseAttachment, type AttachmentStore } from '../spawn/attachments';
import type { SpawnFolder } from '../spawn/folders';
import { AUDIO_BODY_MAX, type DictationService } from '../dictation/dictation';
import type { DeliveryIndex } from '../deliveries/deliveries';
import type { FileFetcher } from '../deliveries/fetcher';
import { HOST_WAIT_MS } from '../host-wait';

export interface ApiDeps {
  office: Office;
  hub: Hub;
  accounts: AccountsService;
  sources: () => SourceInfo[];
  version: string;
  inDocker: boolean;
  /** Terminal on (ServerConfig.terminal: only with local bind). */
  terminal?: boolean;
  /** Terminal streams; without them the feature stays off even with `terminal`. */
  terminals?: TerminalStreams;
  /**
   * History of terminal sessions (GET /api/sessions/*, http/sessions.ts): the HistorySet of all the tools
   * (or a single provider); same lock as the terminal.
   */
  sessions?: SessionLookup;
  /** Timelapse routes (/api/timeline/*, see http/timeline.ts); returns false for the rest. */
  timeline?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /**
   * Routes of /api/permissions (answering through the office, server/permissions/http.ts). They only exist with
   * local bind (ServerConfig.terminal); the local Host lock is checked here before calling them.
   */
  permissions?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Routes of the messages through the office (/api/messages, the plugin's inbox at /api/mod/inbox and the Codex
   * helper's at /api/codex/bridge/*, server/messages/http.ts). They only exist with ServerConfig.messages (the
   * terminal lock and HABBLAUD_MENSAGENS); the local Host lock is checked here before calling them.
   */
  messages?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Interactive terminal and actions on the agents (/api/pty/*, POST /api/agents/:id/stop|takeover; http/pty.ts).
   * Absent = off (without HABBLAUD_PTY=1, Docker, without node-pty or without local bind).
   */
  pty?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Live Codex source: receives the events of the Codex hooks (POST /api/codex/events, server/codex/http.ts). Without
   * it the route answers {ok: false}. Only with local Host and, outside Docker, a connection through the loopback (the
   * events only observe: they do not depend on the terminal lock).
   */
  codexLive?: CodexLive;
  /** New agent through the office (/api/spawn and, for the host helper, /api/host/spawn/*; server/spawn/spawn.ts). */
  spawn?: SpawnService;
  /** Folders suggested in "New agent" (GET /api/spawn/folders; spawn/folders.ts): recent projects. */
  spawnFolders?: () => Promise<SpawnFolder[]>;
  /** Attachments of "New agent" (POST /api/spawn/attachments; spawn/attachments.ts). */
  attachments?: AttachmentStore;
  /** Dictation (/api/dictation and, for the host helper, /api/host/dictation/*; dictation/dictation.ts). */
  dictation?: DictationService;
  /** Deliveries (GET /api/deliveries and the attachments at /api/deliveries/file/:id; deliveries/deliveries.ts). */
  deliveries?: DeliveryIndex;
  /** Who reads the delivery files (and, for the host helper, /api/host/files/*; deliveries/fetcher.ts). */
  files?: FileFetcher;
  /** Renames the room (POST /api/rooms/rename {id, name}; empty returns to the default). Returns the name in use, or undefined if the room doesn't exist. */
  renameRoom?: (id: string, name: string) => string | undefined;
  /** Stats of "My day" (GET /api/stats, http/stats.ts). */
  stats?: DayStatsService;
  /** Check for a new version on GitHub (GET /api/updates, POST /api/updates/check; updates/checker.ts). */
  updates?: {
    status(): UpdateStatus;
    check(opts: { manual?: boolean }): Promise<UpdateStatus>;
  };
  /**
   * Remote port with login (http/remote.ts): `is` tells whether the request arrived through it (already authenticated);
   * `allows`, what HABBLAUD_REMOTE_ALLOW allows. A remote request never counts by Host: only by what `allows` allows.
   */
  remote?: { is(req: IncomingMessage): boolean; allows(feature: RemoteFeature): boolean };
  /**
   * Routes of Habblaud World (/api/world/*, server/world/http.ts). Absent = HABBLAUD_WORLD=0: 404 on all of them. Only
   * through the local port with local Host: through the phone's port, not even with login (403 `local_only`).
   */
  world?: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
}

/** GET /api/agents/:id/terminal (ids never contain '/'). */
const TERMINAL_ROUTE = /^\/api\/agents\/([^/]+)\/terminal$/;
/** POST /api/agents/:id/stop|takeover (interactive terminal). */
const AGENT_ACTION_ROUTE = /^\/api\/agents\/[^/]+\/(stop|takeover)$/;

/** PUT|DELETE /api/agents/:id/character: the project's character (see Office.setCharacter). */
const CHARACTER_ROUTE = /^\/api\/agents\/([^/]+)\/character$/;
const NOT_EDITABLE = tr('agent not found: only the main agent of an open session has an editable character');

/** Connection coming from the computer itself (127.x, ::1 or ::ffff:127.x). */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/** Routes of the messages through the office (server/messages/http.ts); /api/mod/summary is left out (no lock). */
/**
 * Routes of the hooks, the plugins and the host helper: registering and waiting for permission requests, fetching the
 * messages of a session, the helper's rounds. They only count through the local port; through the remote one, not
 * even with login (the phone approves and sends messages through the page's routes).
 */
function isLocalOnlyPath(path: string): boolean {
  return (
    path === '/api/permissions' ||
    /^\/api\/permissions\/[^/]+\/wait$/.test(path) ||
    path === '/api/mod/inbox' ||
    path === '/api/mod/inbox/ack' ||
    path.startsWith('/api/codex/') ||
    path.startsWith('/api/host/')
  );
}

function isMessagesPath(path: string): boolean {
  return (
    path === '/api/messages' ||
    path.startsWith('/api/messages/') ||
    path === '/api/mod/inbox' ||
    path === '/api/mod/inbox/ack' ||
    path === '/api/codex/bridge/poll' ||
    path === '/api/codex/bridge/ack'
  );
}

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // The API is only read by the page itself: no "no-cors" reading by other origins.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(data);
}

/**
 * Delivery attachment. Pages and SVG come in a sandbox without scripts (CSP), so they do not run with the office's
 * login; PDF and images can open inside the modal (same origin).
 */
function sendFile(res: ServerResponse, data: Buffer, type: string, name: string): void {
  const active = /^text\/html|^image\/svg/.test(type);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...(active ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob: 'self'; style-src 'unsafe-inline'; media-src 'self'" } : {}),
  });
  res.end(data);
}

/** Reads the JSON body. Requires `Content-Type: application/json` (barrier against CSRF; see http/guard.ts). */
export function readJson(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    return Promise.reject(new HttpError(415, tr('send the body as JSON (Content-Type: application/json)')));
  }
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too big: keeps draining (without storing) to be able to answer 413.
      if (size > max) return void fail(new HttpError(413, tr('body too large')));
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, tr('invalid JSON')));
      }
    });
    req.on('error', fail);
  });
}

/** Summary of the new version check for /api/health. */
function updatesSummary(s: UpdateStatus | undefined): { state: UpdateStatus['state']; latest?: string; available: boolean } {
  return s ? { state: s.state, latest: s.latest, available: s.available } : { state: 'off', available: false };
}

/** Subagents nested deeper than this do not exist in practice; the limit only avoids a loop on a crooked parentId. */
const MAX_PARENT_HOPS = 16;

/**
 * Summary for the Claude Code mod (GET /api/mod/summary, see ModSummary). `isReal` tells who is a real
 * agent: the demo ones live only in the snapshot (not in the Office), so `office.has(id)` separates them without
 * depending on the "demo:" prefix. The session itself is left out when `session` comes (and, if it comes,
 * `account` also has to match): the main one has the session's current sessionId (it changes on /clear) and the
 * subagents keep that of the session that launched them; to be safe, a subagent is also left out when some
 * ancestor (parentId) belongs to it.
 */
export function modSummary(
  snap: OfficeSnapshot,
  isReal: (id: string) => boolean,
  version: string,
  own: { account?: string; session?: string } = {},
): ModSummary {
  const byId = new Map(snap.agents.map((a) => [a.id, a]));
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.name]));
  const isOwn = (a: AgentInfo): boolean => {
    if (!own.session || (own.account && a.account !== own.account)) return false;
    let cur: AgentInfo | undefined = a;
    for (let hops = 0; cur && hops <= MAX_PARENT_HOPS; hops++) {
      if (cur.sessionId === own.session) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  const present = snap.agents.filter((a) => isReal(a.id) && a.status !== 'offline' && a.status !== 'done' && !isOwn(a));
  const waiting = present
    .filter((a) => a.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      room: rooms.get(a.roomId) ?? a.roomId,
      account: a.account,
      waitingFor: a.waitingFor ?? tr('answer in the terminal'),
      since: a.statusSince,
      answerable: !!a.permission,
    }));
  return { version, agents: present.length, working: present.filter((a) => a.status === 'working').length, waiting };
}

/** Returns a handler that handles /api/* and answers false for the rest. */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { office, hub, accounts } = deps;
  const terminals = deps.terminal ? deps.terminals : undefined;

  const isRemote = (req: IncomingMessage): boolean => !!deps.remote?.is(req);
  /**
   * The "from the computer itself" lock: on the local port, the Host has to be loopback (as before); on the remote
   * port, only what HABBLAUD_REMOTE_ALLOW allows (`feature` absent = never through the remote port).
   */
  const trusted = (req: IncomingMessage, feature?: RemoteFeature): boolean =>
    isRemote(req) ? !!feature && !!deps.remote?.allows(feature) : isLoopbackHost(req.headers.host);
  const denied = (req: IncomingMessage, localMessage: string): string =>
    isRemote(req) ? tr('not allowed over remote access (see HABBLAUD_REMOTE_ALLOW)') : localMessage;

  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('method not allowed') });
  };

  const handleDemo = async (req: IncomingMessage, res: ServerResponse) => {
    const body = (await readJson(req)) as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, tr('expected {enabled: boolean}'));
    office.setDemo(body.enabled);
    sendJson(res, 200, { ok: true, demo: office.isDemo() });
  };

  const handleCharacter = async (req: IncomingMessage, res: ServerResponse, id: string, method: string) => {
    if (method === 'DELETE') {
      req.resume();
      if (office.resetCharacter(id) === 'not-found') return sendJson(res, 404, { error: NOT_EDITABLE });
      return sendJson(res, 200, { ok: true });
    }
    const body = (await readJson(req)) as { name?: unknown; seed?: unknown; parts?: unknown } | null;
    const name = parseCharacterName(body?.name);
    const seed = parseSeed(body?.seed);
    const parts = parseAppearanceParts(body?.parts);
    if (!name || seed === null || !parts) {
      throw new HttpError(400, tr('expected {name: text of 1 to {0} characters, seed: integer from 0 to 4294967295, parts: appearance parts}', [NAME_MAX]));
    }
    const r = office.setCharacter(id, { name, seed, parts });
    if (r.result === 'not-found') return sendJson(res, 404, { error: NOT_EDITABLE });
    if (r.result === 'conflict') return sendJson(res, 409, { error: r.message });
    sendJson(res, 200, { ok: true });
  };

  /**
   * Host helper round: with `?wait=1`, the response waits for work (up to HOST_WAIT_MS). Returns undefined if the
   * connection dropped while it waited (nothing leaves the queue).
   */
  const hostWait = async <T>(res: ServerResponse, url: URL, poll: (ms: number, signal: AbortSignal) => Promise<T[]>): Promise<T[] | undefined> => {
    const ac = new AbortController();
    const abort = () => ac.abort();
    res.once('close', abort);
    try {
      const list = await poll(url.searchParams.get('wait') === '1' ? HOST_WAIT_MS : 0, ac.signal);
      return ac.signal.aborted ? undefined : list;
    } finally {
      res.off('close', abort);
    }
  };

  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('internal error') });
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (isRemote(req) && isLocalOnlyPath(path)) {
      req.resume();
      sendJson(res, 403, { error: tr('route only for the computer running Habblaud (hooks, plugins and the host helper)') });
      return true;
    }
    if (path === '/api/world' || path.startsWith('/api/world/')) {
      // The Habblaud World account acts in your name: only the computer itself, like the terminal. The local Host alone is
      // not enough (Tailscale arrives through the loopback and the Host can be faked): the remote port never passes, not
      // even with login.
      if (!deps.world) {
        req.resume();
        sendJson(res, 404, { error: tr('unknown route') });
      } else if (isRemote(req) || !isLoopbackHost(req.headers.host)) {
        req.resume();
        sendJson(res, 403, { error: { code: 'local_only', message: tr('Habblaud World can only be used from this computer (http://localhost)') } });
      } else deps.world(req, res, url);
      return true;
    }
    if (path === '/api/stream') {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else hub.attach(req, res);
      return true;
    }
    if (path === '/api/snapshot') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, hub.current());
      return true;
    }
    if (path === '/api/health') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const remote = isRemote(req);
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          demo: office.isDemo(),
          docker: deps.inDocker,
          remote,
          terminal: !!terminals && (!remote || trusted(req, 'terminal')),
          permissions: !!deps.permissions && (!remote || trusted(req, 'permissions')),
          // The interactive terminal (pty) never counts through the remote port.
          pty: !!deps.pty && !remote,
          messages: !!deps.messages && (!remote || trusted(req, 'messages')),
          codexEvents: !!deps.codexLive,
          updates: updatesSummary(deps.updates?.status()),
          sources: deps.sources(),
          accounts: accounts.allEntries().map((a) =>
            a.provider === 'claude'
              ? { id: a.id, usageStatus: accounts.usageView(a.id).status }
              : { id: a.id, provider: a.provider, usageStatus: accounts.usageView(a.id).status },
          ),
        });
      }
      return true;
    }
    if (path === '/api/access') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const remote = isRemote(req);
        const access: AccessInfo = {
          remote,
          local: !remote && isLoopbackHost(req.headers.host),
          permissions: !!deps.permissions && trusted(req, 'permissions'),
          messages: !!deps.messages && trusted(req, 'messages'),
          terminal: !!terminals && trusted(req, 'terminal'),
          spawn: !!deps.spawn && trusted(req, 'spawn'),
          world: !!deps.world && !!deps.terminal && !remote && isLoopbackHost(req.headers.host),
        };
        sendJson(res, 200, access);
      }
      return true;
    }
    if (path === '/api/mod/summary') {
      // Read every 5 s per session with the mod: only counts and who is waiting (nothing the snapshot doesn't already show).
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const own = { account: url.searchParams.get('account') || undefined, session: url.searchParams.get('session') || undefined };
        sendJson(res, 200, modSummary(hub.current(), (id) => office.has(id), deps.version, own));
      }
      return true;
    }
    const terminalMatch = TERMINAL_ROUTE.exec(path);
    if (terminalMatch) {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else if (!terminals) {
        sendJson(res, 403, { error: tr('terminal disabled: it only works when Habblaud is reachable only from the computer running it') });
      } else if (!trusted(req, 'terminal')) {
        sendJson(res, 403, { error: denied(req, tr('the terminal only opens from the computer running Habblaud (http://localhost or http://127.0.0.1)')) });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(terminalMatch[1]);
        } catch {
          sendJson(res, 400, { error: tr('invalid id') });
          return true;
        }
        terminals.attach(req, res, id);
      }
      return true;
    }
    if (path.startsWith('/api/sessions/')) {
      handleSessionsRoute(req, res, path, {
        history: deps.terminal ? deps.sessions : undefined,
        terminals,
        trusted: isRemote(req) ? trusted(req, 'terminal') : undefined,
      });
      return true;
    }
    if (path === '/api/permissions' || path.startsWith('/api/permissions/')) {
      // Answering through the office acts on the sessions: the same lock as the terminal (local bind + local Host).
      if (!deps.permissions) {
        sendJson(res, 403, { error: tr('replying from the office disabled: it only works when Habblaud is reachable only from the computer running it') });
      } else if (!trusted(req, 'permissions')) {
        sendJson(res, 403, { error: denied(req, tr('permission requests can only be answered from the computer running Habblaud (http://localhost or http://127.0.0.1)')) });
      } else {
        deps.permissions(req, res, path);
      }
      return true;
    }
    if (path === '/api/pty' || path.startsWith('/api/pty/') || AGENT_ACTION_ROUTE.test(path)) {
      // Runs commands on the machine: never through the remote port, not even with login (the Host and the address of
      // whoever connects are not enough: Tailscale arrives through the loopback and the Host can be faked).
      if (isRemote(req)) sendJson(res, 403, { error: tr('the interactive terminal can only be used on the computer running Habblaud') });
      else if (!deps.pty) sendJson(res, 403, { error: tr('interactive terminal disabled (see the server log)') });
      else deps.pty(req, res, path);
      return true;
    }
    const characterMatch = CHARACTER_ROUTE.exec(path);
    if (characterMatch) {
      // Changing the character acts on the office: the same lock as the terminal (local bind + local Host).
      if (method !== 'PUT' && method !== 'DELETE') methodNotAllowed(res, 'PUT, DELETE');
      else if (!deps.terminal) {
        sendJson(res, 403, { error: tr('character editing disabled: it only works when Habblaud is reachable only from the computer running it') });
      } else if (!trusted(req)) {
        sendJson(res, 403, { error: denied(req, tr('the character can only be edited from the computer running Habblaud (http://localhost or http://127.0.0.1)')) });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(characterMatch[1]);
        } catch {
          sendJson(res, 400, { error: tr('invalid id') });
          return true;
        }
        handleCharacter(req, res, id, method).catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/codex/events') {
      // Events of the Codex hooks: they only observe, but they only count coming from the computer itself. Outside Docker
      // the hook always connects through the loopback (the Host alone a client on the network can fake); in Docker it
      // arrives through the published port, with the gateway's address.
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('Codex events are only accepted from the computer running Habblaud (http://localhost or http://127.0.0.1)')) });
      } else handleCodexEvent(req, res, { live: deps.codexLive, entries: () => accounts.entriesOf('codex') }).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/spawn' || path.startsWith('/api/spawn/')) {
      // Opens a new session in the Claude app: it runs code on the computer, so the same lock as the messages.
      const spawn = deps.spawn;
      if (!spawn) sendJson(res, 403, { error: tr('new agent from the office disabled') });
      else if (!trusted(req, 'spawn')) sendJson(res, 403, { error: denied(req, tr('new agents can only be opened from the computer running Habblaud (http://localhost)')) });
      else if (path === '/api/spawn' && isRead) sendJson(res, 200, { available: spawn.available(), mode: spawn.mode() });
      else if (path === '/api/spawn/folders') {
        if (!isRead) methodNotAllowed(res, 'GET');
        else (deps.spawnFolders ?? (async () => []))().then((folders) => sendJson(res, 200, { folders }), (err) => fail(res, err));
      } else if (path === '/api/spawn/attachments') {
        const store = deps.attachments;
        if (method !== 'POST') methodNotAllowed(res, 'POST');
        else if (!store) sendJson(res, 403, { error: tr('attachments disabled') });
        else
          readJson(req, ATTACHMENT_BODY_MAX)
            .then((body) => {
              const a = parseAttachment(body);
              if ('error' in a) return sendJson(res, 400, { error: a.error });
              const r = store.put(a);
              if ('error' in r) return sendJson(res, 429, { error: r.error });
              sendJson(res, 201, { id: r.id, name: a.name, size: a.data.length });
            })
            .catch((err) => fail(res, err));
      }
      else if (path === '/api/spawn' && method === 'POST') {
        readJson(req)
          .then((body) => {
            const r = spawn.submit(body);
            if ('spawn' in r) return sendJson(res, 201, r.spawn);
            sendJson(res, r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, { error: r.reason });
          })
          .catch((err) => fail(res, err));
      } else if (path !== '/api/spawn' && isRead) {
        const info = spawn.get(decodeURIComponent(path.slice('/api/spawn/'.length)));
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: tr('unknown request') });
      } else methodNotAllowed(res, path === '/api/spawn' ? 'GET, POST' : 'GET');
      return true;
    }
    if (path === '/api/dictation' || path.startsWith('/api/dictation/')) {
      // Dictation of "New agent" and of the message box: it counts with either of the two locks (the text becomes a
      // request or a message, which keep their own lock when they are sent).
      const dictation = deps.dictation;
      if (!dictation) sendJson(res, 403, { error: tr('dictation disabled') });
      else if (!trusted(req, 'spawn') && !trusted(req, 'messages')) {
        sendJson(res, 403, { error: denied(req, tr('dictation only works from the computer running Habblaud (http://localhost)')) });
      }
      else if (path === '/api/dictation' && isRead) sendJson(res, 200, { available: dictation.available() });
      else if (path === '/api/dictation' && method === 'POST') {
        readJson(req, AUDIO_BODY_MAX)
          .then((body) => {
            const r = dictation.submit(body);
            if ('dictation' in r) return sendJson(res, 201, r.dictation);
            sendJson(res, r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, { error: r.reason });
          })
          .catch((err) => fail(res, err));
      } else if (path !== '/api/dictation' && isRead) {
        const info = dictation.get(decodeURIComponent(path.slice('/api/dictation/'.length)));
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: tr('unknown dictation') });
      } else methodNotAllowed(res, path === '/api/dictation' ? 'GET, POST' : 'GET');
      return true;
    }
    if (path === '/api/deliveries' || path.startsWith('/api/deliveries/')) {
      // Deliveries show the whole reply and the agent's files: the same lock as the terminal.
      const deliveries = deps.deliveries;
      if (!deliveries) sendJson(res, 403, { error: tr('deliveries disabled (they need the terminal: local access)') });
      else if (!isRead) methodNotAllowed(res, 'GET');
      else if (!trusted(req, 'terminal')) sendJson(res, 403, { error: denied(req, tr('deliveries only open from the computer running Habblaud (http://localhost)')) });
      else if (path === '/api/deliveries') deliveries.list().then((list) => sendJson(res, 200, { deliveries: list }), (err) => fail(res, err));
      else if (path.startsWith('/api/deliveries/file/')) {
        const att = deliveries.attachment(decodeURIComponent(path.slice('/api/deliveries/file/'.length)));
        if (!att) sendJson(res, 404, { error: tr('unknown attachment: refresh the deliveries list') });
        else if (att.kind === 'capture') sendFile(res, att.data, att.type, att.name);
        else if (!deps.files) sendJson(res, 404, { error: tr('files disabled') });
        else
          deps.files.get(att.path).then(
            (r) => ('data' in r ? sendFile(res, r.data, att.type, att.name) : sendJson(res, r.status, { error: r.error })),
            (err) => fail(res, err),
          );
      } else sendJson(res, 404, { error: tr('unknown route') });
      return true;
    }
    if (path === '/api/host/files/poll' || path === '/api/host/files/ack') {
      // Only the host helper, through the local port (never the remote one); outside Docker, only through the loopback.
      const files = deps.files;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!files) sendJson(res, 403, { error: tr('files disabled') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('only the helper on the computer running Habblaud')) });
      } else if (path === '/api/host/files/poll') {
        req.resume();
        hostWait(res, url, (ms, signal) => files.pollWait(ms, signal)).then((list) => list && sendJson(res, 200, { files: list }), (err) => fail(res, err));
      } else {
        readJson(req, 36 * 1024 * 1024)
          .then((body) => {
            files.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/host/dictation/poll' || path === '/api/host/dictation/ack') {
      // Only the host helper, through the local port (never the remote one); outside Docker, only through the loopback.
      const dictation = deps.dictation;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!dictation) sendJson(res, 403, { error: tr('dictation disabled') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('only the helper on the computer running Habblaud')) });
      } else if (path === '/api/host/dictation/poll') {
        req.resume();
        hostWait(res, url, (ms, signal) => dictation.pollWait(ms, signal)).then((list) => list && sendJson(res, 200, { dictations: list }), (err) => fail(res, err));
      } else {
        readJson(req, 512 * 1024)
          .then((body) => {
            dictation.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/host/spawn/poll' || path === '/api/host/spawn/ack') {
      // Only the host helper, through the local port (never the remote one); outside Docker, only through the loopback.
      const spawn = deps.spawn;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!spawn) sendJson(res, 403, { error: tr('new agent from the office disabled') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('only the helper on the computer running Habblaud')) });
      } else if (path === '/api/host/spawn/poll') {
        req.resume();
        sendJson(res, 200, { spawns: spawn.poll() });
      } else {
        readJson(req)
          .then((body) => {
            spawn.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (isMessagesPath(path)) {
      // The messages enter the session as if you had typed them: the same lock (feature on + local Host).
      if (!deps.messages) {
        sendJson(res, 403, {
          error: tr('messages from the office disabled: they only work when Habblaud is reachable only from the computer running it (and without HABBLAUD_MENSAGENS=0)'),
        });
      } else if (!trusted(req, 'messages')) {
        sendJson(res, 403, { error: denied(req, tr('messages can only be sent from the computer running Habblaud (http://localhost or http://127.0.0.1)')) });
      } else {
        deps.messages(req, res, path);
      }
      return true;
    }
    if (path.startsWith('/api/agents/')) {
      if (!isRead) {
        methodNotAllowed(res, 'GET');
        return true;
      }
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/agents/'.length));
      } catch {
        sendJson(res, 400, { error: tr('invalid id') });
        return true;
      }
      const detail = office.detail(id);
      if (detail) sendJson(res, 200, detail);
      else sendJson(res, 404, { error: tr('agent not found') });
      return true;
    }
    if (path === '/api/rooms/rename') {
      // Like the character: the same lock as the terminal (local bind + local Host).
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!deps.terminal) sendJson(res, 403, { error: tr('room renaming disabled: it only works when Habblaud is reachable only from the computer running it') });
      else if (!trusted(req)) sendJson(res, 403, { error: denied(req, tr('rooms can only be renamed from the computer running Habblaud (http://localhost)')) });
      else
        readJson(req)
          .then((body) => {
            const b = body as { id?: unknown; name?: unknown };
            if (typeof b?.id !== 'string' || typeof b.name !== 'string') throw new HttpError(400, tr('expected {id, name}'));
            const name = deps.renameRoom?.(b.id, b.name);
            if (name === undefined) throw new HttpError(404, tr('room not found'));
            sendJson(res, 200, { name });
          })
          .catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/stats' || path.startsWith('/api/stats/')) {
      handleStatsRoute(req, res, url, deps.stats, sendJson);
      return true;
    }
    if (path === '/api/demo') {
      // Turns demo mode on for everyone: only from the computer (the phone with login only sees what was allowed).
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (isRemote(req)) sendJson(res, 403, { error: tr('not allowed over remote access (see HABBLAUD_REMOTE_ALLOW)') });
      else handleDemo(req, res).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/updates') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, { version: deps.version, ...(deps.updates?.status() ?? { state: 'off', available: false }) });
      return true;
    }
    if (path === '/api/updates/check') {
      // "Check now": queries GitHub (at most once every 30 s) and returns the new status.
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else {
        req.resume();
        const updates = deps.updates;
        if (!updates) sendJson(res, 200, { version: deps.version, state: 'off', available: false });
        else
          updates
            .check({ manual: true })
            .then((status) => sendJson(res, 200, { version: deps.version, ...status }))
            .catch((err) => fail(res, err));
      }
      return true;
    }
    if (deps.timeline?.(req, res, url)) return true;
    sendJson(res, 404, { error: tr('unknown route') });
    return true;
  };
}
