// Habblaud server: watches the open Claude Code sessions (all accounts),
// keeps the office model and streams via SSE. No runtime dependencies.
//   npm run dev    -> tsx server/index.ts --dev (Vite in middleware mode, HMR on the same server)
//   npm start      -> node dist/server/index.js (serves dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { codexDirsRefused, isDefaultDir } from './accounts/detect';
import { AccountsService } from './accounts/service';
import { isTruthy, loadConfig, messagesOffReason, terminalOffReason, worldSocketUrl } from './config';
import { createApiHandler, sendJson } from './http/app';
import { createRequestGuard, isLoopbackHost } from './http/guard';
import { createRemoteGate, isRemoteRequest, loadSecret, RemoteSessions, startRemoteListener, type RemoteListener } from './http/remote';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { TerminalStreams } from './http/terminal';
import { createTimelineHandler } from './http/timeline';
import { TIMELINE_DIR, TimelineRecorder } from './history/timeline';
import { DayStatsService } from './history/daystats';
import { describeStateMigration, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { RoomAliases } from './model/room-aliases';
import { createPtyRoutes } from './http/pty';
import { claudeBinFrom, isExecutableFile, loadPty, PtyManager, type ScreenFactory, type SpawnPty } from './pty/manager';
import { loadHeadlessScreen } from './pty/screen';
import { openMainAgent, SessionHistory } from './sources/history';
import { HistorySet, SourceSet } from './sources/source';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';
import { codexAccountOf } from './codex/http';
import { createCodexQueueRunner, findCodexBin } from './messages/codex';
import { createMessageRoutes } from './messages/http';
import { MessageRegistry } from './messages/registry';
import type { CodexLive } from './sources/codex/live';
import { ClaudeWatcher } from './sources/watcher';
import { discoverCodexDirs } from './sources/codex/accounts';
import { CodexHistory } from './sources/codex/history';
import { CodexSource } from './sources/codex/source';
import { createBuildReader, readBuildInfo } from './build';
import { UpdateChecker } from './updates/checker';
import { getLocale, tr } from '../shared/i18n';
import type { WorldLocale } from '../shared/world/protocol';
import { createCliRunner, createOpener, SpawnService } from './spawn/spawn';
import { runnableClaudeBin } from './claude-bin';
import { AttachmentStore } from './spawn/attachments';
import { recentFolders } from './spawn/folders';
import { isDemoId } from '../shared/timeline';
import { DictationService } from './dictation/dictation';
import { createWhisperTranscriber, findWhisper } from './dictation/whisper';
import { DeliveryIndex } from './deliveries/deliveries';
import { FileFetcher } from './deliveries/fetcher';
import { WorldClient } from './world/client';
import { createWorldRoutes } from './world/http';
import { WorldService } from './world/service';
import { WorldSettingsStore } from './world/settings';
import { OwnerSocial } from './world/social';
import { BuildingTokens } from './world/tokens';
import { BuildingUplink } from './world/uplink';
import { WorldViewer } from './world/viewer';

const config = loadConfig();
const startedAt = Date.now();

// Old name (CodeTown, up to 0.3.2): takes ~/.codetown to ~/.habblaud before reading any state and warns about
// the CODETOWN_* variables that no longer work. In Docker, docker:up is the one that migrates.
if (!config.inDocker) {
  const r = migrateLegacyStateDir(config.home);
  const msg = describeStateMigration(r);
  if (msg) (r.error ? log.warn : log.info)(msg);
}
const legacyEnv = legacyEnvWarning(Object.keys(process.env));
if (legacyEnv) log.warn(legacyEnv);

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
// Room names chosen by the user (right button > Rename).
const roomAliases = new RoomAliases(join(config.dataDir, 'rooms.json'));
roomAliases.load();

// Office, accounts and agent sources reference each other (change notices / sources): late binding.
const late: { office?: Office; agents?: SourceSet; permissions?: PermissionRegistry; messages?: MessageRegistry; ptys?: PtyManager; ptyOff?: string } = {};
// New version: checks the latest release on GitHub every 6 h (HABBLAUD_UPDATE_CHECK=0 turns it off).
const updates = new UpdateChecker({
  current: config.version,
  repo: config.repo,
  enabled: config.updateCheck,
  file: join(config.dataDir, 'updates.json'),
  onChange: () => late.office?.markDirty(),
});
updates.load();
// Habblaud World (server/world/): the account and the character on this computer. On by default (server.habblaud.com,
// or HABBLAUD_WORLD_URL); nothing leaves the computer before the person creates the account and signs in.
// HABBLAUD_WORLD=0 hides everything (404 routes and nothing in the interface); a refused HABBLAUD_WORLD_URL leaves
// the feature off.
const worldStore = new WorldSettingsStore(join(config.dataDir, 'world.json'));
if (config.world.enabled && config.world.url) worldStore.load();
// The owner's light social (world/social.ts): likes of the day, "while you were away", knocks on the door and blocked people.
const worldSocial = config.world.enabled ? new OwnerSocial({ session: () => worldStore.get()?.deviceId, onChange: () => late.office?.markDirty() }) : undefined;
const world = config.world.enabled
  ? new WorldService({
      config: config.world,
      terminal: config.terminal,
      store: worldStore,
      client: config.world.url ? new WorldClient({ baseUrl: config.world.url, version: config.version }) : undefined,
      onChange: () => late.office?.markDirty(),
      social: worldSocial,
    })
  : undefined;
const accounts = new AccountsService({
  dirs: config.claudeDirs,
  home: config.home,
  env: process.env,
  usageDir: config.usageDir,
  onChange: () => late.office?.markDirty(),
});
const office = new Office({
  names,
  roomAlias: (path) => roomAliases.get(path),
  version: config.version,
  // In dev mode Vite serves the client straight from the source code: there is no build to compare.
  build: config.dev ? undefined : createBuildReader(config.rootDir),
  startedAt,
  accounts: (sessions) => accounts.list(sessions),
  sources: () => late.agents?.sources() ?? [],
  accountName: (id) => accounts.find(id)?.detected.name,
  terminal: config.terminal,
  permissions: () => late.permissions?.snapshot() ?? new Map(),
  messages: config.messages ? () => late.messages?.reachable() ?? new Set() : undefined,
  ptys: () => (late.ptys ? { status: late.ptys.status(), list: late.ptys.list() } : { status: { enabled: false, reason: late.ptyOff ?? tr('off') }, list: [] }),
  updates: () => updates.status(),
  world: () => world?.meta() ?? { enabled: false, configured: false, state: 'off' },
});
// Agent sources, one per tool (sources/source.ts): Claude Code's and, after it, Codex's (when there are Codex
// folders; HABBLAUD_CODEX=0 turns it off), with its history in the HistorySet below and the accounts registered by
// the source itself (accounts.setProviderAccounts). `codex` also receives the events from the Codex hooks (CodexLive).
const claude = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker });
const agents = new SourceSet([claude]);
const codexDirs = config.codex ? discoverCodexDirs(process.env, config.home) : [];
const codex = codexDirs.length ? new CodexSource({ accounts, office, dirs: codexDirs, env: process.env, home: config.home }) : undefined;
if (codex) agents.add(codex);
// Events from the Codex hooks (POST /api/codex/events, mod/habblaud-codex/hook.mjs): they go to the live Codex source
// (CodexLive); without it (no Codex folder or HABBLAUD_CODEX=0) the route answers {ok: false}.
const codexLive: CodexLive | undefined = codex;
late.office = office;
late.agents = agents;
// Page that can answer for the office: local Host on the local port; on the remote one, only with permissions allowed.
const hub = new Hub(office, {
  canAnswer: (req) => (isRemoteRequest(req) ? !!config.remote?.allow.has('permissions') : isLoopbackHost(req.headers.host)),
});
// "My day": samples the office every second and persists to <dataDir>/stats/ (see history/daystats.ts).
const stats = new DayStatsService({ dir: join(config.dataDir, 'stats'), snapshot: () => hub.current() });
stats.load();
// The building in Habblaud World (world/uplink.ts): only with the world server accepted. It connects on its own with
// the account approved, the character created, the terminal lock and no pause; the packet comes only from the
// projection (shared/world/projection.ts).
const worldTokens = new BuildingTokens({ stats });
const worldUplink =
  world && config.world.url
    ? new BuildingUplink({
        url: worldSocketUrl(config.world.url),
        version: config.version,
        build: () => {
          const b = readBuildInfo(config.rootDir);
          return { commit: b.commit, dirty: b.dirty };
        },
        locale: () => getLocale() as WorldLocale,
        store: worldStore,
        canAct: () => config.terminal,
        agents: () => office.list(),
        subscribe: (cb) => office.onChange(cb),
        booting: () => office.isBooting(),
        tokens: () => worldTokens.read(),
        lastFile: join(config.dataDir, 'world-last-uplink.json'),
        onGoodbye: (reason) => world.goodbye(reason),
        onLeft: () => world.leftElsewhere(),
        onChange: () => office.markDirty(),
      })
    : undefined;
if (world && worldUplink) world.attachUplink(worldUplink);
// The World scene (world/viewer.ts): the city over the same connection as the building, only with the scene open in
// the browser.
const worldViewer = worldUplink ? new WorldViewer() : undefined;
if (worldUplink && worldViewer) {
  worldViewer.attach(worldUplink);
  worldUplink.attachCity(worldViewer);
}
if (worldUplink && worldSocial) {
  worldSocial.attach(worldUplink);
  worldUplink.attachOwner(worldSocial);
}
// Terminal: it only exists with local bind (see terminalOffReason in config.ts).
// Each agent with its tool's parser (Claude Code's by default).
const terminals = config.terminal
  ? new TerminalStreams({ office, transcriptPathOf: (id) => agents.transcriptPathOf(id), parserFor: (id) => agents.parserFor(id) })
  : undefined;
// Terminal history (recent sessions, open or ended, from all the tools): same lock.
const history = config.terminal
  ? new HistorySet([new SessionHistory({ accounts: () => accounts.entries(), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) })])
  : undefined;
if (history && codex) history.add(new CodexHistory({ accounts: () => accounts.entriesOf('codex'), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) }));
// Deliveries: the end of each request, read from the history transcripts (same lock as the terminal). The delivered
// files are read here (Node, or account folder mounted in Docker) or by the host helper.
const deliveries = history
  ? new DeliveryIndex({
      sessions: () => history.list(),
      resolve: (account, sessionId) => {
        const r = history.resolve(account, sessionId);
        return 'path' in r ? r : undefined;
      },
      isBusy: (id) => {
        const st = office.list().find((a) => a.id === id)?.status;
        return st === 'working' || st === 'waiting' || st === 'shell';
      },
      agentName: (id) => office.list().find((a) => a.id === id)?.name,
    })
  : undefined;
const deliveryFiles = deliveries
  ? new FileFetcher({
      direct: !config.inDocker,
      mapHostPath: (p) => {
        for (const e of accounts.entries()) {
          const host = e.detected.configDir.replace(/\/+$/, '');
          if (host && p.startsWith(`${host}/`)) return `${e.dir.replace(/\/+$/, '')}${p.slice(host.length)}`;
        }
        return undefined;
      },
    })
  : undefined;
// Timelapse timeline: records each new snapshot (throttled) in <dataDir>/timeline.
const timelineDir = join(config.dataDir, TIMELINE_DIR);
const timeline = config.timeline ? new TimelineRecorder({ dir: timelineDir }) : undefined;
if (timeline) hub.onSnapshot((snap) => timeline.ingest(snap));
// Answering for the office (PermissionRequest hook): it acts on the sessions, so it follows the same lock.
const permissions = config.terminal
  ? new PermissionRegistry({
      office,
      viewers: () => hub.localSize,
      answerLater: () => !!config.remote?.allow.has('permissions'),
      // Claude Code only: the search for the answer given in the terminal reads its transcript format.
      transcriptPathOf: (id) => claude.transcriptPathOf(id),
      // Requests from the Codex hook: the account by the CODEX_HOME folder it sends.
      codexAccount: (account, codexHome) => codexAccountOf(accounts.entriesOf('codex'), account, codexHome),
      demoDecide: (id, d) => office.decideDemoPermission(id, d),
      demoDetail: (id) => office.demoPermission(id),
    })
  : undefined;
late.permissions = permissions;
// Messages through the office (habblaud-mensagens plugin): they enter the session as if you had typed them, so they
// follow the same lock (and HABBLAUD_MENSAGENS=0 turns off only them). To Codex they go by `codex queue`
// (messages/codex.ts): outside Docker the server itself runs the command (HABBLAUD_CODEX_BIN or `codex` from the
// PATH); in Docker, the host helper (npm run codex:bridge).
const codexBin = config.messages && !config.inDocker ? findCodexBin(process.env) : undefined;
// Interactive terminal and New agent: both run Claude Code on this computer, so they ask for the same authorization,
// HABBLAUD_PTY=1 (accepts the same values as HABBLAUD_TERMINAL).
const ptyFlag = process.env.HABBLAUD_PTY?.trim();
const ptyOptIn = isTruthy(ptyFlag);
// New agent through the office (Claude Code session in the background, or the Claude app's screen filled in): the
// authorization above plus the messages lock. In Docker, the host helper is the one that runs it (npm run codex:bridge).
const spawnOn = config.messages && ptyOptIn;
const attachments = spawnOn ? new AttachmentStore() : undefined;
const spawnBin = config.inDocker ? undefined : runnableClaudeBin(process.env);
const spawn = spawnOn
  ? new SpawnService(config.inDocker ? { attachments } : { opener: createOpener(), cli: spawnBin ? createCliRunner(spawnBin) : undefined, attachments })
  : undefined;
// Dictation: in Docker the host helper does the transcribing; in Node, the server, if it finds the local Whisper.
const whisper = config.messages && !config.inDocker ? findWhisper() : undefined;
const dictation = config.messages
  ? new DictationService(whisper && !('missing' in whisper) ? { transcriber: createWhisperTranscriber(whisper) } : {})
  : undefined;
const messages = config.messages
  ? new MessageRegistry({
      office,
      demoAgent: (id) => office.demoAgent(id),
      demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
      codex: {
        run: codexBin ? createCodexQueueRunner(codexBin) : undefined,
        homeOf: (account) => accounts.entriesOf('codex').find((e) => e.id === account)?.detected.configDir,
      },
    })
  : undefined;
late.messages = messages;

// Interactive terminal (open/take over sessions and end agents): opt-in with HABBLAUD_PTY=1, only with local bind,
// outside Docker, with node-pty and the claude executable on the PATH.
const claudeBinSetting = process.env.HABBLAUD_CLAUDE_BIN?.trim();
const claudeBin = claudeBinFrom();
let spawnPty: SpawnPty | null = null;
let ptyScreen: ScreenFactory | undefined;
let ptyOff: string | undefined;
if (!ptyOptIn) ptyOff = ptyFlag ? tr('off via HABBLAUD_PTY={0}', [ptyFlag]) : tr('off (turn it on with HABBLAUD_PTY=1)');
else if (config.inDocker) ptyOff = tr('unavailable in Docker (run with npm start)');
else if (!config.terminal) ptyOff = tr('same lock as the terminal ({0})', [terminalOffReason(process.env, config.host, config.inDocker)]);
else if (!claudeBin) ptyOff = claudeBinSetting ? tr('HABBLAUD_CLAUDE_BIN not found in PATH ({0})', [claudeBinSetting]) : tr('"claude" executable not found in PATH (set HABBLAUD_CLAUDE_BIN)');
else if (!isExecutableFile(claudeBin)) ptyOff = tr("the Claude Code executable doesn't run: {0} (check HABBLAUD_CLAUDE_BIN)", [claudeBin]);
else {
  const loaded = await loadPty();
  spawnPty = loaded.spawn;
  ptyOff = loaded.reason;
  if (spawnPty) {
    const screen = await loadHeadlessScreen();
    ptyScreen = screen.create ?? undefined;
    if (screen.reason) log.warn(tr('Interactive terminal without the full screen ({0}): on reconnect, modes like bracketed paste may be lost.', [screen.reason]));
  }
}
const ptys = spawnPty
  ? new PtyManager({
      spawn: spawnPty,
      claudeBin: claudeBin ?? 'claude',
      accounts: () => accounts.entries().map((a) => ({ id: a.id, dir: a.dir, isDefault: isDefaultDir(a.dir, config.home) })),
      agent: (id) => {
        const a = office.get(id);
        return a && { id: a.id, kind: a.kind, account: a.account, sessionId: a.sessionId, cwd: office.roomPath(a.roomId) };
      },
      onChange: () => office.markDirty(),
      createScreen: ptyScreen,
    })
  : undefined;
late.ptys = ptys;
late.ptyOff = ptyOff;

if (config.demo) office.setDemo(true);
// The synchronous sources (Claude Code's) finish the boot here, before the hub starts streaming.
void agents.start();
accounts.start();
hub.start();
if (timeline) {
  timeline.start();
  timeline.ingest(hub.current());
}
permissions?.start();
messages?.start();
stats.start();
updates.start();
worldUplink?.start();
const ticker = setInterval(() => {
  try {
    office.tick();
  } catch (err) {
    log.warnOnce(`tick:${errMsg(err)}`, tr('Office clock failed: {0}', [errMsg(err)]));
  }
}, 250);

const api = createApiHandler({
  renameRoom: (id, name) => {
    const path = office.roomPath(id);
    if (!path) return undefined;
    roomAliases.set(path, name);
    office.refreshRoomNames();
    return office.roomName(id);
  },
  office,
  hub,
  accounts,
  sources: () => agents.sources(),
  version: config.version,
  inDocker: config.inDocker,
  terminal: config.terminal,
  terminals,
  sessions: history,
  timeline: createTimelineHandler({ dir: timelineDir, recording: !!timeline }),
  permissions: permissions ? createPermissionRoutes(permissions) : undefined,
  messages: messages ? createMessageRoutes(messages) : undefined,
  pty: ptys ? createPtyRoutes(ptys) : undefined,
  spawn,
  attachments,
  dictation,
  deliveries,
  files: deliveryFiles,
  spawnFolders: async () => {
    const snap = hub.current();
    const last = new Map<string, number>();
    for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
    const rooms = snap.rooms.filter((r) => !isDemoId(r.id)).map((r) => ({ path: r.path, lastAt: last.get(r.id) ?? 0 }));
    return recentFolders(history ? await history.list().catch(() => []) : [], rooms);
  },
  codexLive,
  stats,
  updates,
  remote: config.remote ? { is: isRemoteRequest, allows: (f) => config.remote!.allow.has(f) } : undefined,
  world: world ? createWorldRoutes(world, worldViewer, worldSocial) : undefined,
});

const server = http.createServer();
let closeVite: (() => Promise<void>) | undefined;

function parseUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** What serves whatever is not /api: Vite (dev) or the files in dist/client (production). */
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (config.dev) {
  // Dynamic import: the production bundle never loads Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(config.rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

// Host/Origin/Content-Type: blocks DNS rebinding and CSRF before any route (including Vite).
const guard = createRequestGuard({ allowedHosts: config.allowedHosts });

server.on('request', (req, res) => {
  const url = parseUrl(req);
  try {
    if (guard(req, res)) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(tr('Error responding to {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
    if (!res.headersSent) sendJson(res, 500, { error: tr('internal error') });
    else res.destroy();
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(tr('Port {0} is already in use (set HABBLAUD_PORT to use another one).', [config.port]));
  else log.error(tr('HTTP server error: {0}', [errMsg(err)]));
  process.exit(1);
});

/**
 * Remote port (phone on the local network): the same app, but every request goes through the login (http/remote.ts)
 * before the API. The main port stays local only; what separates the two is the port the connection arrived on.
 */
let remoteListener: RemoteListener | undefined;
if (config.remote) {
  const remote = config.remote;
  const gate = createRemoteGate({
    config: remote,
    sessions: new RemoteSessions(loadSecret(join(config.dataDir, 'remote-secret')), remote, Date.now, join(config.dataDir, 'remote-revoked.json')),
    secure: !!remote.tls,
    caFile: remote.tls?.caFile,
  });
  remoteListener = startRemoteListener(
    remote,
    (req, res) => {
      const url = parseUrl(req);
      try {
        if (guard(req, res)) return;
        if (gate(req, res, url)) return;
        if (!api(req, res, url)) fallback(req, res, url);
      } catch (err) {
        log.warn(tr('Error responding (remote) to {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr('internal error') });
        else res.destroy();
      }
    },
    log,
    config.allowedHosts,
  );
  remoteListener.server.once('listening', () => {
    const allow = [...remote.allow].join(', ') || tr('view only');
    const where = config.inDocker ? tr('published via HABBLAUD_REMOTE_BIND') : remote.host;
    const scheme = remote.tls ? 'HTTPS' : tr('HTTP WITHOUT encryption (HABBLAUD_REMOTE_INSECURE_HTTP)');
    log.info(tr('   Remote access: on at port {0} ({1}), {2}, with login; allows: {3}.', [remote.port, where, scheme, allow]));
    if (remote.allow.has('spawn') && !spawn) log.warn(tr('   Remote access: "spawn" allowed, but New agent is off (turn it on with HABBLAUD_PTY=1).'));
  });
} else if (config.remoteWarning) {
  log.warn(`   ${config.remoteWarning}.`);
}

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(tr('🏢 Habblaud {0}{1}{2} at http://{3}:{4}', [config.version, config.dev ? ' (dev)' : '', config.inDocker ? ' (docker)' : '', host, config.port]));
  const list = accounts.entries();
  if (!list.length) log.warn(tr('No Claude Code folder found (set HABBLAUD_CLAUDE_DIRS).'));
  for (const dir of codexDirsRefused(process.env, config.home)) {
    log.warn(tr('{0} is a Codex folder, not a Claude Code one: it stays out of the Claude Code accounts.', [dir]));
  }
  for (const a of list) {
    const src = agents.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(tr('   Account {0} ({1}): {2} open session(s) · usage: {3} · {4}', [a.detected.short, a.id, src?.sessions ?? 0, usage, a.dir]));
  }
  if (codex) {
    const codexAccounts = codex.accountEntries();
    const open = codex.sources().reduce((n, s) => n + s.sessions, 0);
    log.info(tr('   Codex: {0} account(s), {1} open session(s).', [codexAccounts.length, open]));
    for (const a of codexAccounts) {
      log.info(tr('   Codex account {0} ({1}): usage: {2} · {3}', [a.detected.short, a.id, accounts.usageView(a.id).status, a.detected.configDir]));
    }
  } else {
    log.info(tr('   Codex: {0}.', [config.codex ? tr('no Codex folder found (set HABBLAUD_CODEX_DIRS)') : tr('off (HABBLAUD_CODEX=0)')]));
  }
  if (office.isDemo()) log.info(tr('   Demo mode on (simulated agents mixed in with the real ones).'));
  if (config.terminal) log.info(tr('   Terminal: on (local access only).'));
  else log.info(tr('   Terminal: off ({0}).', [terminalOffReason(process.env, config.host, config.inDocker)]));
  log.info(ptys ? tr('   Interactive terminal: on ({0}).', [claudeBin]) : tr('   Interactive terminal: {0}.', [ptyOff ?? tr('off')]));
  log.info(
    !spawn
      ? tr('   New agent: off ({0}).', [!ptyOptIn ? tr('turn it on with HABBLAUD_PTY=1') : tr('same lock as messages')])
      : config.inDocker
        ? tr('   New agent: on, via the host helper (keep npm run codex:bridge running on the computer).')
        : spawnBin
          ? tr('   New agent: on ({0} --bg; a folder not yet trusted opens in the Claude app).', [spawnBin])
          : tr('   New agent: on, only via the Claude app (claude not found in PATH).'),
  );
  log.info(timeline ? tr('   Timeline (timelapse): recording to {0}.', [timelineDir]) : tr('   Timeline (timelapse): recording off (HABBLAUD_TIMELINE).'));
  log.info(tr('   Reply from the office: {0}.', [config.terminal ? tr('on (needs the mod: npm run mod:install; or the old hook: npm run hooks:install)') : tr('off (same lock as the terminal)')]));
  log.info(
    config.messages
      ? tr('   Messages from the office: on (needs the habblaud-mensagens plugin: npm run mod:install).')
      : tr('   Messages from the office: off ({0}).', [messagesOffReason(process.env, config.host, config.inDocker)]),
  );
  if (config.messages) {
    log.info(
      codexBin
        ? tr('   Messages to Codex: via codex queue ({0}).', [codexBin])
        : config.inDocker
          ? tr('   Messages to Codex: via the host helper (keep npm run codex:bridge running on the Mac).')
          : tr('   Messages to Codex: no Codex binary (codex in PATH or HABBLAUD_CODEX_BIN); the npm run codex:bridge helper also works.'),
    );
  }
  if (config.world.warning) log.warn(`   ${config.world.warning}.`);
  log.info(
    !world
      ? tr('   Habblaud World: hidden (HABBLAUD_WORLD=0).')
      : !config.world.url
        ? tr('   Habblaud World: off (HABBLAUD_WORLD_URL rejected).')
        : tr('   Habblaud World: {0}, account on this computer: {1}{2}.', [
            config.world.defaultUrl ? tr('{0} (default)', [config.world.url]) : config.world.url,
            world.state(),
            config.terminal ? '' : tr(' (read-only: the terminal lock is off)'),
          ]),
  );
  log.info(
    updates.enabled
      ? tr('   New version: checking github.com/{0} releases every 6 h.', [config.repo])
      : tr('   New version: check off ({0}).', [config.repo ? 'HABBLAUD_UPDATE_CHECK' : tr('package.json has no GitHub repository')]),
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(tr('Shutting down ({0})…', [signal]));
  clearInterval(ticker);
  stats.stop();
  agents.stop();
  accounts.stop();
  hub.stop();
  terminals?.stop();
  timeline?.stop();
  permissions?.stop();
  messages?.stop();
  ptys?.stopAll();
  updates.stop();
  worldViewer?.stop();
  worldUplink?.stop();
  world?.stop();
  names.flush();
  void closeVite?.();
  remoteListener?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
