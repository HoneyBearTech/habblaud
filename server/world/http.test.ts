// Rotas locais do Habblaud World (/api/world/*) com o servidor do mundo de mentira (server/test/fake-world.ts): as
// travas, a validação e o caminho inteiro de ponta a ponta (cadastro → verificação → lista de espera → entrar →
// personagem → sair), conferindo que o token do dispositivo nunca aparece fora do world.json.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../accounts/service';
import { DEFAULT_WORLD_URL, parseWorldConfig, worldSocketUrl, type WorldConfig } from '../config';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { FAKE_CODE, startFakeWorld, type FakeWorld } from '../test/fake-world';
import { tempDir } from '../test/fixtures';
import { WorldClient } from './client';
import { createWorldRoutes } from './http';
import { WorldService } from './service';
import { WorldSettingsStore } from './settings';
import { BuildingUplink } from './uplink';
import { WorldViewer } from './viewer';

setQuiet(true);

const EMAIL = 'ana@example.com';
const PASSWORD = 'a very long password';
const NAME = 'Ana Pixel';
/** O cadastro: o nome de jogador é obrigatório (fica reservado na lista de espera). */
const REGISTER = { email: EMAIL, password: PASSWORD, name: NAME };
const CHARACTER = {
  name: 'Ana Pixel',
  look: 'f',
  parts: { skin: '#e8b48c', hairStyle: 'bob' },
  traits: ['games', 'cafeina'],
  intro: 'coffee',
};

interface Harness {
  base: string;
  hub: Hub;
  office: Office;
  uplink?: BuildingUplink;
  viewer?: WorldViewer;
  lastFile: string;
  service?: WorldService;
  store: WorldSettingsStore;
  file: string;
  world?: FakeWorld;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  setQuiet(true);
  vi.restoreAllMocks();
});

/** A porta local do Habblaud (guard + API), com o mundo como no server/index.ts. */
async function start(opts: { world?: 'off' | 'no-url' | 'on'; terminal?: boolean; meTtlMs?: number; uplink?: boolean } = {}): Promise<Harness> {
  const mode = opts.world ?? 'on';
  const tmp = tempDir();
  closers.push(tmp.cleanup);
  const fake = mode === 'on' ? await startFakeWorld() : undefined;
  if (fake) closers.push(fake.close);
  const config: WorldConfig = { enabled: mode !== 'off', dev: true, ...(fake ? { url: fake.base } : {}) };
  const file = join(tmp.dir, 'data', 'world.json');
  const store = new WorldSettingsStore(file);
  const terminal = opts.terminal ?? true;
  const late: { office?: Office } = {};
  const service = config.enabled
    ? new WorldService({
        config,
        terminal,
        store,
        client: fake ? new WorldClient({ baseUrl: fake.base, version: '9.9.9' }) : undefined,
        onChange: () => late.office?.markDirty(),
        meTtlMs: opts.meTtlMs,
      })
    : undefined;
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
    terminal,
    world: () => service?.meta() ?? { enabled: false, configured: false, state: 'off' },
  });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 0 });
  hub.start();
  closers.push(() => hub.stop());
  // O prédio, como no server/index.ts (com esperas curtas).
  const lastFile = join(tmp.dir, 'data', 'world-last-uplink.json');
  const uplink =
    opts.uplink && service && fake
      ? new BuildingUplink({
          url: worldSocketUrl(fake.base),
          version: '9.9.9',
          build: () => ({ commit: 'unknown', dirty: false }),
          locale: () => 'pt-BR',
          store,
          canAct: () => terminal,
          agents: () => office.list(),
          subscribe: (cb) => office.onChange(cb),
          lastFile,
          onGoodbye: (r) => service.goodbye(r),
          onLeft: () => service.leftElsewhere(),
          onChange: () => office.markDirty(),
          timing: { debounceMs: 20, minGapMs: 60, pingMs: 5_000, backoffMinMs: 20, backoffMaxMs: 60, closeWaitMs: 500 },
        })
      : undefined;
  if (uplink && service) {
    service.attachUplink(uplink);
    uplink.start();
    closers.push(() => uplink.stop());
  }
  // A cena Mundo, como no server/index.ts (só com o uplink).
  const viewer = uplink ? new WorldViewer() : undefined;
  if (uplink && viewer) {
    viewer.attach(uplink);
    uplink.attachCity(viewer);
    closers.push(() => viewer.stop());
  }
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    terminal,
    world: service ? createWorldRoutes(service, viewer) : undefined,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['my-mac.local']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  closers.push(() => new Promise<void>((ok) => server.close(() => ok())));
  closers.push(() => server.closeAllConnections());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hub, office, uplink, viewer, lastFile, service, store, file, world: fake };
}

/** Todas as respostas locais do teste, para conferir que o token nunca sai. */
const seen: string[] = [];

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; raw: string; headers: http.IncomingHttpHeaders }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = http.request(
      new URL(path, base),
      { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          seen.push(raw);
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          ok({ status: res.statusCode ?? 0, body: parsed, raw, headers: res.headers });
        });
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

describe('HABBLAUD_WORLD and HABBLAUD_WORLD_URL', () => {
  it('HABBLAUD_WORLD=0: 404 on all routes and meta.world off', async () => {
    const s = await start({ world: 'off' });
    for (const [m, p] of [['GET', '/api/world/status'], ['POST', '/api/world/login'], ['PUT', '/api/world/character'], ['GET', '/api/world']]) {
      expect((await call(s.base, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(404);
    }
    expect(s.hub.current().meta.world).toEqual({ enabled: false, configured: false, state: 'off' });
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(false);
  });

  it('no URL (HABBLAUD_WORLD_URL refused): feature off (meta.world without enabled), status off and the rest 409 not_configured', async () => {
    const s = await start({ world: 'no-url' });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: false, state: 'off' });
    const r = await call(s.base, 'POST', '/api/world/register', REGISTER);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_configured');
    expect((await call(s.base, 'PUT', '/api/world/character', CHARACTER)).body.error.code).toBe('not_configured');
    expect((await call(s.base, 'GET', '/api/world/devices')).status).toBe(409);
    expect(s.hub.current().meta.world).toEqual({ enabled: false, configured: false, state: 'off' });
  });

  it('parseWorldConfig: only https/wss; http://127.0.0.1 in development mode; only the origin', () => {
    const p = (url: string | undefined, extra: NodeJS.ProcessEnv = {}, argv: string[] = []) =>
      parseWorldConfig({ HABBLAUD_WORLD_URL: url, ...extra }, argv);
    // Sem HABBLAUD_WORLD_URL (ou vazia), o servidor do mundo padrão; definida, vale a definida (e recusada não cai no padrão).
    expect(p(undefined)).toEqual({ enabled: true, dev: false, url: DEFAULT_WORLD_URL, defaultUrl: true });
    expect(p('  ')).toEqual({ enabled: true, dev: false, url: DEFAULT_WORLD_URL, defaultUrl: true });
    expect(DEFAULT_WORLD_URL).toBe('https://server.habblaud.com');
    expect(p('https://server.habblaud.com')).toEqual({ enabled: true, dev: false, url: 'https://server.habblaud.com' });
    expect(p('https://other.example.com')).toEqual({ enabled: true, dev: false, url: 'https://other.example.com' });
    expect(p('wss://server.habblaud.com/').url).toBe('https://server.habblaud.com');
    expect(p('https://server.habblaud.com:8443').url).toBe('https://server.habblaud.com:8443');
    expect(p('http://server.habblaud.com').warning).toMatch(/https/);
    expect(p('http://127.0.0.1:4848').url).toBeUndefined();
    expect(p('http://127.0.0.1:4848').warning).toMatch(/development/);
    expect(p('http://127.0.0.1:4848', {}, ['--dev']).url).toBe('http://127.0.0.1:4848');
    expect(p('ws://127.0.0.1:4848', { HABBLAUD_WORLD_DEV: '1' }).url).toBe('http://127.0.0.1:4848');
    expect(p('http://localhost:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('http://10.0.0.5:4848', {}, ['--dev']).url).toBeUndefined();
    // O servidor do mundo no host, visto de dentro do container do Habblaud (docker-compose.yml: extra_hosts).
    expect(p('http://host.docker.internal:4848', { HABBLAUD_WORLD_DEV: '1' }).url).toBe('http://host.docker.internal:4848');
    expect(p('ws://host.docker.internal:4848', {}, ['--dev']).url).toBe('http://host.docker.internal:4848');
    expect(p('http://host.docker.internal:4848').url).toBeUndefined();
    expect(p('http://host.docker.internal:4848').warning).toMatch(/host\.docker\.internal.*development/);
    expect(p('http://x.host.docker.internal:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('http://host.docker.internal.evil.com:4848', {}, ['--dev']).url).toBeUndefined();
    expect(p('https://host.docker.internal:4848').url).toBe('https://host.docker.internal:4848');
    for (const bad of ['https://user:pw@server.habblaud.com', 'https://server.habblaud.com/v1', 'https://server.habblaud.com/?x=1', 'https://x/#a', 'nothing']) {
      expect(p(bad).url, bad).toBeUndefined();
      expect(p(bad).warning, bad).toBeTruthy();
      // O aviso não repete a URL (pode ter senha).
      expect(p(bad).warning).not.toContain('pw@');
    }
    expect(p('https://server.habblaud.com', { HABBLAUD_WORLD: '0' })).toEqual({ enabled: false, dev: false });
    expect(p(undefined, { HABBLAUD_WORLD: 'off' })).toEqual({ enabled: false, dev: false });
    expect(worldSocketUrl('https://server.habblaud.com')).toBe('wss://server.habblaud.com/v1/socket');
    expect(worldSocketUrl('http://127.0.0.1:4848')).toBe('ws://127.0.0.1:4848/v1/socket');
    expect(worldSocketUrl('http://host.docker.internal:4848')).toBe('ws://host.docker.internal:4848/v1/socket');
  });
});

describe('docker-compose.yml', () => {
  it('passes on to the container every Habblaud World variable that the server reads', () => {
    const compose = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    const config = readFileSync(join(import.meta.dirname, '..', 'config.ts'), 'utf8');
    const read = [...new Set([...config.matchAll(/env\.(HABBLAUD_WORLD[A-Z_]*)/g)].map((m) => m[1]))].sort();
    expect(read).toEqual(['HABBLAUD_WORLD', 'HABBLAUD_WORLD_DEV', 'HABBLAUD_WORLD_URL']);
    for (const key of read) expect(compose, key).toMatch(new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}$`, 'm'));
  });

  it('the container finds the host at host.docker.internal (local world server, also on Linux)', () => {
    const compose = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^ {4}extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"$/m);
  });
});

describe('locks', () => {
  it('Host that is not local: 403 local_only (network IP or a name from HABBLAUD_ALLOWED_HOSTS)', async () => {
    const s = await start();
    for (const host of ['192.168.0.10:4747', 'my-mac.local:4747']) {
      const r = await call(s.base, 'GET', '/api/world/status', undefined, { Host: host });
      expect(r.status, host).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect((await call(s.base, 'GET', '/api/world/status', undefined, { Host: 'localhost:4747' })).status).toBe(200);
    expect((await call(s.base, 'GET', '/api/access', undefined, { Host: '192.168.0.10:4747' })).body.world).toBe(false);
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(true);
  });

  it('terminal lock off: status says it cannot be done and the actions get 403 terminal_off', async () => {
    const s = await start({ terminal: false });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: false, configured: true, state: 'logged_out', lastError: 'terminal_off' });
    const r = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('terminal_off');
    expect(s.world!.requests).toEqual([]);
    expect((await call(s.base, 'GET', '/api/access')).body.world).toBe(false);
  });

  it('CSRF: body that is not JSON and another origin are blocked before the route', async () => {
    const s = await start();
    const form = await call(s.base, 'POST', '/api/world/logout', undefined, { 'Content-Type': 'text/plain' });
    expect(form.status).toBe(415);
    const other = await call(s.base, 'POST', '/api/world/logout', {}, { Origin: 'https://evil-site.com' });
    expect(other.status).toBe(403);
  });

  it('unknown route 404 and wrong method 405', async () => {
    const s = await start();
    expect((await call(s.base, 'GET', '/api/world/nothing')).body.error.code).toBe('not_found');
    const r = await call(s.base, 'GET', '/api/world/login');
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
    expect((await call(s.base, 'POST', '/api/world/status', {})).status).toBe(405);
  });
});

describe('validation before going to the world server', () => {
  it('email, password, code, language and character', async () => {
    const s = await start();
    const code = async (m: string, p: string, b: unknown) => {
      const r = await call(s.base, m, p, b);
      return `${r.status} ${r.body?.error?.code}`;
    };
    expect(await code('POST', '/api/world/register', { email: 'no-at-sign', password: PASSWORD, name: NAME })).toBe('400 invalid_email');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: 'short', name: NAME })).toBe('400 password_invalid');
    // O nome de jogador é obrigatório e é conferido antes da senha, como no servidor do mundo.
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: 'short' })).toBe('422 name_invalid');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: PASSWORD, name: 'Admin' })).toBe('422 name_blocked');
    expect(await code('POST', '/api/world/register', { email: EMAIL, password: PASSWORD, name: 'a!' })).toBe('422 name_invalid');
    expect(await code('POST', '/api/world/register', { ...REGISTER, locale: 'de' })).toBe('400 invalid');
    expect(await code('POST', '/api/world/register', { ...REGISTER, invite: '../x' })).toBe('400 invalid');
    expect(await code('POST', '/api/world/verify', { email: EMAIL, code: 'abc' })).toBe('400 invalid_code');
    expect(await code('POST', '/api/world/login', { email: EMAIL })).toBe('400 password_invalid');
    expect(await code('POST', '/api/world/register', [1, 2])).toBe('400 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, name: 'Admin' })).toBe('422 name_blocked');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, name: 'A​na' })).toBe('422 name_invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, traits: ['timidez', 'piadas'] })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, intro: 'emacs' })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/character', { ...CHARACTER, parts: { skin: 'red' } })).toBe('422 invalid');
    expect(await code('PUT', '/api/world/visibility', { mode: 'live' })).toBe('422 invalid');
    // Válido, mas sem ter entrado.
    expect(await code('PUT', '/api/world/character', CHARACTER)).toBe('401 not_logged_in');
    expect(await code('GET', '/api/world/devices', undefined)).toBe('401 not_logged_in');
    // Nada disso chegou ao servidor do mundo.
    expect(s.world!.requests).toEqual([]);
  });
});

describe('end to end with the fake world server', () => {
  it('sign-up → verification → waitlist → sign in → character → sign out, without the token leaving world.json', async () => {
    setQuiet(false);
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    seen.length = 0;
    const s = await start({ meTtlMs: 60_000 });
    const w = s.world!;
    const snapshots: string[] = [];
    const snap = () => {
      const cur = s.hub.current();
      snapshots.push(JSON.stringify(cur));
      return cur.meta.world;
    };
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out' });

    // Cadastro: o servidor local busca e resolve o ALTCHA sozinho, e manda tos e o idioma.
    const reg = await call(s.base, 'POST', '/api/world/register', { ...REGISTER, name: '  Ana   Pixel ', locale: 'es', invite: 'invite_1' });
    expect(reg.status).toBe(202);
    expect(reg.body).toEqual({});
    const sent = w.requests.find((r) => r.path === '/v1/auth/register')!;
    expect(sent.body).toMatchObject({ email: EMAIL, password: PASSWORD, name: NAME, locale: 'es', tos: 'v1', invite: 'invite_1' });
    expect(w.accounts.get(EMAIL)?.verified).toBe(false);
    // O nome já reservado por outra conta: 409 name_taken, com o mesmo status e código do servidor do mundo.
    const taken = await call(s.base, 'POST', '/api/world/register', { ...REGISTER, email: 'bia@example.com', name: 'ana pixel' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: { code: 'name_taken' } });

    // Código errado: o erro do servidor do mundo volta com o mesmo status e o código.
    const wrong = await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: { code: 'invalid_code' } });

    // Verificação: entra, grava o world.json (600) e fica na lista de espera.
    const ver = await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: `${FAKE_CODE.slice(0, 3)} ${FAKE_CODE.slice(3)}` });
    expect(ver.status).toBe(200);
    expect(ver.body).toMatchObject({ available: true, configured: true, state: 'waiting', account: { emailMasked: 'a***@example.com', access: 'waiting' } });
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(s.file, 'utf8'));
    expect(first).toMatchObject({ deviceId: 'dev_1', email: EMAIL, access: 'waiting' });
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'waiting' });

    const waiting = await call(s.base, 'GET', '/api/world/status');
    expect(waiting.body.state).toBe('waiting');
    expect(waiting.body.player).toBeUndefined();
    // O nome do cadastro, reservado enquanto não há personagem.
    expect(waiting.body.account).toEqual({ emailMasked: 'a***@example.com', access: 'waiting', reservedName: NAME });
    expect(waiting.body.devices).toEqual([{ id: 'dev_1', label: 'Dispositivo 1', createdAt: expect.any(String), lastSeenAt: expect.any(String), current: true }]);

    // Entrar de novo troca o dispositivo e revoga o anterior no servidor do mundo.
    const login = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.state).toBe('waiting');
    const second = JSON.parse(readFileSync(s.file, 'utf8'));
    expect(second.deviceId).toBe('dev_2');
    expect(second.token).not.toBe(first.token);
    expect(w.devices.has(first.token)).toBe(false);
    expect(w.devices.has(second.token)).toBe(true);

    // Personagem (já na lista de espera): o nome é a reserva do cadastro, e o pedido vai sem `name` (um nome no corpo
    // nem sai daqui); o que o servidor manda a mais não passa.
    const { name: _unused, ...noName } = CHARACTER;
    const ch = await call(s.base, 'PUT', '/api/world/character', { ...noName, name: 'Other Name' });
    expect(ch.status).toBe(200);
    expect(ch.body).toEqual({ ...CHARACTER, visibility: expect.any(Object), updatedAt: '2026-10-15T12:00:00Z', country: 'BR' });
    expect(w.requests.filter((r) => r.path === '/v1/me/player').map((r) => 'name' in (r.body ?? {}))).toEqual([false]);
    expect(JSON.parse(readFileSync(s.file, 'utf8')).player.name).toBe('Ana Pixel');

    const vis = { mode: 'discreet', closed: true, hideCountry: true, tokensVisible: false, leaderboard: false, compactions: false };
    expect((await call(s.base, 'PUT', '/api/world/visibility', vis)).body).toEqual(vis);
    const st = await call(s.base, 'GET', '/api/world/status');
    expect(st.body.player).toMatchObject({ name: 'Ana Pixel', visibility: vis });
    expect(st.body.account).not.toHaveProperty('reservedName');
    // Editando: o nome vai arrumado quando vem, e ausente mantém.
    const ed = await call(s.base, 'PUT', '/api/world/character', { ...CHARACTER, name: '  Ana   Nova ' });
    expect(ed.body.name).toBe('Ana Nova');
    expect((await call(s.base, 'PUT', '/api/world/character', noName)).body.name).toBe('Ana Nova');
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect((await call(s.base, 'GET', '/api/world/devices')).body.devices.map((d: { id: string }) => d.id)).toEqual(['dev_2']);

    // Liberado pelo lote: a próxima leitura (refresh) muda o estado e o snapshot.
    w.accounts.get(EMAIL)!.access = 'approved';
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.state).toBe('approved');
    // Com o personagem criado, a cena Mundo fica disponível (sem uplink neste teste, sem `building`).
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'approved', scene: { available: true } });

    // Sair: revoga no servidor e apaga o world.json.
    const out = await call(s.base, 'POST', '/api/world/logout', {});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ available: true, configured: true, state: 'logged_out' });
    expect(existsSync(s.file)).toBe(false);
    expect(w.devices.size).toBe(0);
    expect(snap()).toEqual({ enabled: true, configured: true, state: 'logged_out' });

    // O Bearer só foi nas rotas da conta, nunca na URL, e o token nunca apareceu do lado de cá.
    for (const r of w.requests) {
      const needs = r.path.startsWith('/v1/me') || r.path === '/v1/auth/logout';
      expect(!!r.authorization, `${r.method} ${r.path}`).toBe(needs);
      expect(r.path).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
    for (const token of [first.token, second.token]) {
      for (const text of [...seen, ...snapshots, ...logs]) expect(text).not.toContain(token);
    }
  });

  it('old account, without reservation: creating the character requires the name (and it goes in the request)', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    delete s.world!.accounts.get(EMAIL)!.reservedName;
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.account).not.toHaveProperty('reservedName');
    const { name: _unused, ...noName } = CHARACTER;
    const missing = await call(s.base, 'PUT', '/api/world/character', noName);
    expect(`${missing.status} ${missing.body.error.code}`).toBe('422 name_invalid');
    expect(s.world!.requests.some((r) => r.path === '/v1/me/player')).toBe(false);
    const ch = await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect(ch.status).toBe(200);
    expect(s.world!.requests.find((r) => r.path === '/v1/me/player')!.body).toMatchObject({ name: NAME });
  });

  it('401 from the world server (token revoked somewhere else): deletes the session from here', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.devices.clear();
    const r = await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'session_expired' });
    expect(s.hub.current().meta.world?.state).toBe('logged_out');
  });

  it('world server down: status with what is known and lastError; signing out deletes from here anyway', async () => {
    const s = await start({ meTtlMs: 0 });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    await s.world!.close();
    const st = await call(s.base, 'GET', '/api/world/status?refresh=1');
    expect(st.body).toMatchObject({ state: 'waiting', account: { access: 'waiting' }, player: { name: 'Ana Pixel' }, lastError: 'network' });
    const out = await call(s.base, 'POST', '/api/world/logout', {});
    expect(out.body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'network' });
    expect(existsSync(s.file)).toBe(false);
  });

  it('login that asks for ALTCHA: solves and tries again; unverified email comes back as 403', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    const unverified = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('email_not_verified');
    s.world!.accounts.get(EMAIL)!.verified = true;
    s.world!.options.loginNeedsAltcha = true;
    const r = await call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(200);
    const logins = s.world!.requests.filter((q) => q.path === '/v1/auth/login');
    expect(logins.map((q) => typeof q.body?.altcha)).toEqual(['undefined', 'undefined', 'string']);
  });

  it('resend code and forgot password solve the ALTCHA; changing the password of this account signs out here', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    expect((await call(s.base, 'POST', '/api/world/resend', { email: EMAIL })).status).toBe(202);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    expect((await call(s.base, 'POST', '/api/world/password/forgot', { email: EMAIL })).status).toBe(202);
    const reset = await call(s.base, 'POST', '/api/world/password/reset', { email: EMAIL, code: FAKE_CODE, password: 'another very long password' });
    expect(reset.status).toBe(204);
    expect(reset.raw).toBe('');
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body.state).toBe('logged_out');
  });

  it('revoking its own device signs out here; revoking another only updates the list', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    // Outro computador da mesma conta.
    await new WorldClient({ baseUrl: s.world!.base, version: '1' }).login({ email: EMAIL, password: PASSWORD });
    const ids = (await call(s.base, 'GET', '/api/world/devices')).body.devices.map((d: { id: string }) => d.id);
    expect(ids).toEqual(['dev_1', 'dev_2']);
    expect((await call(s.base, 'POST', '/api/world/devices/dev_2/revoke', {})).status).toBe(204);
    expect((await call(s.base, 'GET', '/api/world/status')).body.devices.map((d: { id: string }) => d.id)).toEqual(['dev_1']);
    expect((await call(s.base, 'POST', '/api/world/devices/does-not-exist/revoke', {})).body.error.code).toBe('not_found');
    expect((await call(s.base, 'POST', '/api/world/devices/dev_1/revoke', {})).status).toBe(204);
    expect(existsSync(s.file)).toBe(false);
    expect((await call(s.base, 'GET', '/api/world/status')).body.state).toBe('logged_out');
  });

  it('two tabs signing in at the same time: one operation at a time (the second login revokes the first)', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.options.delayMs = 20;
    const [a, b] = await Promise.all([
      call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD }),
      call(s.base, 'POST', '/api/world/login', { email: EMAIL, password: PASSWORD }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Só o dispositivo da última entrada continua valendo.
    expect(s.world!.devices.size).toBe(1);
    expect([...s.world!.devices.keys()][0]).toBe(s.store.get()?.token);
  });

  it('Habblaud restart: the session comes back from world.json', async () => {
    const s = await start();
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    const again = new WorldSettingsStore(s.file);
    expect(again.load()).toMatchObject({ deviceId: 'dev_1', email: EMAIL, access: 'waiting' });
  });
});

async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waiting: ${what}`);
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

describe('the building in the world (uplink) through the routes', () => {
  it('approved with character: the building goes up; status, snapshot, last upload, theme, pause and resume', async () => {
    seen.length = 0;
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:4242', account: '.claude', sessionId: 'sess-x', cwd: '/Users/ana/secret-project', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    // Na lista de espera, com ou sem personagem: nada de prédio.
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toBeUndefined();
    expect(w.ws.connections).toHaveLength(0);

    // Aprovada: o prédio conecta sozinho e manda o pacote.
    w.accounts.get(EMAIL)!.access = 'approved';
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.state).toBe('approved');
    await waitFor(() => w.ws.uplinks.length === 1 && !!s.uplink!.status().lastAck, 'first upload');
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toEqual({ connected: true, paused: false, floors: 1, agents: 1, lastUplinkAt: expect.any(Number), lastAck: { ok: true } });
    expect(s.hub.current().meta.world?.building).toEqual({ connected: true, paused: false, floors: 1, agents: 1, lastUplinkAt: st.building.lastUplinkAt });

    // Ver o que foi enviado: o mesmo objeto que chegou ao servidor.
    const last = (await call(s.base, 'GET', '/api/world/last-uplink')).body;
    expect(last).toEqual({ at: st.building.lastUplinkAt, bytes: w.ws.uplinks[0].bytes, uplink: w.ws.uplinks[0].uplink, ack: { ok: true, at: expect.any(Number), bytes: w.ws.uplinks[0].bytes } });
    expect(JSON.stringify(last)).not.toMatch(/secret-project|Users|\.claude|sess-x/);
    expect(statSync(s.lastFile).mode & 0o777).toBe(0o600);

    // Tema: grava e manda o pacote com o tema novo; fora da lista, 422.
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'christmas' })).body).toEqual({ theme: 'christmas' });
    await waitFor(() => w.ws.uplinks.some((u) => u.uplink.theme === 'christmas'), 'theme in the packet');
    expect((await call(s.base, 'GET', '/api/world/status')).body.theme).toBe('christmas');
    expect(JSON.parse(readFileSync(s.file, 'utf8')).theme).toBe('christmas');
    const bad = await call(s.base, 'PUT', '/api/world/theme', { theme: 'easter' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid');

    // Pausar: quando a resposta chega, a conexão já fechou; o servidor do mundo é avisado.
    const paused = await call(s.base, 'POST', '/api/world/pause', {});
    expect(paused.status).toBe(200);
    expect(w.ws.open).toHaveLength(0);
    expect(paused.body.building).toMatchObject({ connected: false, paused: true });
    expect(JSON.parse(readFileSync(s.file, 'utf8')).paused).toBe(true);
    await waitFor(() => w.requests.some((r) => r.path === '/v1/me/building/pause'), 'pause on the server');
    expect(s.hub.current().meta.world?.building).toMatchObject({ connected: false, paused: true });

    // Retomar: avisa o servidor e reconecta, com o pacote inteiro.
    const sent = w.ws.uplinks.length;
    const resumed = await call(s.base, 'POST', '/api/world/resume', {});
    expect(resumed.status).toBe(200);
    expect(resumed.body.building.paused).toBe(false);
    await waitFor(() => w.ws.uplinks.length === sent + 1, 'back');
    expect(w.requests.map((r) => r.path)).toContain('/v1/me/building/resume');
    expect(w.ws.connections).toHaveLength(2);

    // O token nunca aparece do lado de cá.
    const token = s.store.get()!.token;
    for (const text of [...seen, JSON.stringify(s.hub.current()), readFileSync(s.lastFile, 'utf8')]) expect(text).not.toContain(token);

    // Sair: fecha o prédio e a última remessa some.
    await call(s.base, 'POST', '/api/world/logout', {});
    await waitFor(() => w.ws.open.length === 0, 'closed');
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect(existsSync(s.lastFile)).toBe(false);
    // O tema escolhido fica.
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({ theme: 'christmas' });
  });

  it('pause and resume right after: the world server receives them in order, and the building stays lit', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:7', account: '.claude', sessionId: 'sess-7', cwd: '/p/a', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');
    // A resposta da pausa demora: sem a fila, o resume chegaria antes e o prédio ficaria pausado lá.
    w.options.pauseDelayMs = 80;
    await call(s.base, 'POST', '/api/world/pause', {});
    await call(s.base, 'POST', '/api/world/resume', {});
    await waitFor(() => w.ws.uplinks.length === 2, 'back');
    // Espera a pausa atrasada terminar do lado do servidor.
    await new Promise((ok) => setTimeout(ok, 150));
    const order = w.requests.filter((r) => r.path.startsWith('/v1/me/building/')).map((r) => r.path);
    expect(order).toEqual(['/v1/me/building/pause', '/v1/me/building/resume']);
    expect(w.accounts.get(EMAIL)!.buildingPaused).toBe(false);
  });

  it('leaving the world: closes the building before answering, the server removes the building and nothing reconnects; going back to the world (join) brings it back', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:8', account: '.claude', sessionId: 'sess-8', cwd: '/p/b', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');

    const left = await call(s.base, 'POST', '/api/world/leave', {});
    expect(left.status).toBe(200);
    // Quando a resposta chega, a conexão já fechou e o DELETE já foi.
    expect(w.ws.open).toHaveLength(0);
    expect(w.accounts.get(EMAIL)!.buildingLeft).toBe(1);
    const del = w.requests.find((r) => r.method === 'DELETE');
    expect(del).toMatchObject({ path: '/v1/me/building', body: undefined });
    expect(left.body.building).toMatchObject({ connected: false, paused: true, left: true });
    expect(s.hub.current().meta.world?.building).toMatchObject({ connected: false, paused: true, left: true });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    // A conta e o personagem continuam; o prédio não volta sozinho (bem mais que a espera da reconexão).
    await new Promise((ok) => setTimeout(ok, 200));
    expect(w.ws.connections).toHaveLength(1);
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st).toMatchObject({ state: 'approved', player: { name: 'Ana Pixel' }, building: { left: true } });

    // Voltar ao mundo: o join responde antes de reconectar, e o pacote seguinte é aceito (um prédio novo).
    const back = await call(s.base, 'POST', '/api/world/join', {});
    expect(back.status).toBe(200);
    expect(w.requests.filter((r) => r.path === '/v1/me/building/join')).toHaveLength(1);
    expect(w.accounts.get(EMAIL)!.left).toBe(false);
    expect(back.body.building).toMatchObject({ paused: false });
    expect(back.body.building.left).toBeUndefined();
    await waitFor(() => w.ws.uplinks.length === 2, 'back in the world');
    await waitFor(() => existsSync(s.lastFile) && JSON.parse(readFileSync(s.lastFile, 'utf8')).ack?.ok === true, 'packet accepted');
    expect(JSON.parse(readFileSync(s.file, 'utf8')).left).toBeUndefined();
  });

  it('going back to the world without a good response: the error comes back and nothing changes (still out of the world, without connection)', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');
    expect((await call(s.base, 'POST', '/api/world/leave', {})).status).toBe(200);
    w.options.buildingFailures = 1;
    const r = await call(s.base, 'POST', '/api/world/join', {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('unavailable');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    await new Promise((ok) => setTimeout(ok, 120));
    expect(w.ws.connections).toHaveLength(1);
    // A página antiga que chama /resume fora do mundo também passa pelo join.
    const old = await call(s.base, 'POST', '/api/world/resume', {});
    expect(old.status).toBe(200);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/join')).toHaveLength(2);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/resume')).toHaveLength(0);
    await waitFor(() => w.ws.uplinks.length === 2, 'back in the world');
  });

  it('going back to the world without having left (only paused) is a resume: notifies /resume, not /join, and reconnects', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');
    await call(s.base, 'POST', '/api/world/pause', {});
    expect(w.ws.open).toHaveLength(0);
    const r = await call(s.base, 'POST', '/api/world/join', {});
    expect(r.status).toBe(200);
    expect(r.body.building).toMatchObject({ paused: false });
    await waitFor(() => w.ws.uplinks.length === 2, 'back');
    await waitFor(() => w.accounts.get(EMAIL)!.buildingPaused === false, 'resumed on the server');
    expect(w.requests.filter((q) => q.path === '/v1/me/building/join')).toHaveLength(0);
    expect(w.requests.filter((q) => q.path === '/v1/me/building/resume')).toHaveLength(1);
  });

  it('left the world on another computer: the packet refused with left records the exit and the pause and the connection does not come back', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    s.office.addMain({ id: '.claude:9', account: '.claude', sessionId: 'sess-9', cwd: '/p/c', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');
    // O outro computador saiu do mundo; a mudança seguinte do escritório vai e volta recusada.
    w.accounts.get(EMAIL)!.left = true;
    s.office.addMain({ id: '.claude:10', account: '.claude', sessionId: 'sess-10', cwd: '/p/d', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await waitFor(() => w.ws.uplinks.length === 2, 'second upload');
    await waitFor(() => w.ws.open.length === 0, 'connection closed');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toMatchObject({ connected: false, paused: true, left: true, lastAck: { ok: false, error: 'left' } });
    expect(s.hub.current().meta.world?.building).toMatchObject({ left: true });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(w.ws.connections).toHaveLength(1);
  });

  it('the /v1/me with left: true (left on another computer) also leaves this one out of the world', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    w.accounts.get(EMAIL)!.left = true;
    const st = (await call(s.base, 'GET', '/api/world/status?refresh=1')).body;
    expect(st.building).toMatchObject({ paused: true, left: true });
    await waitFor(() => w.ws.open.length === 0, 'no connection');
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({ paused: true, left: true });
  });

  it('leaving the world without a good response from the server: the error comes back, the building stays only paused and the pause is notified', async () => {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1, 'first upload');
    w.options.buildingFailures = 1;
    const r = await call(s.base, 'POST', '/api/world/leave', {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('unavailable');
    expect(w.ws.open).toHaveLength(0);
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.building).toMatchObject({ connected: false, paused: true });
    expect(st.building.left).toBeUndefined();
    await waitFor(() => w.accounts.get(EMAIL)!.buildingPaused === true, 'pause on the server');
    expect(w.accounts.get(EMAIL)!.buildingLeft).toBeUndefined();
  });

  it('no account: theme is saved, pause and resume ask for the account, last upload empty', async () => {
    const s = await start({ uplink: true });
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' })).body).toEqual({ theme: 'halloween' });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({ theme: 'halloween' });
    for (const path of ['/api/world/pause', '/api/world/resume', '/api/world/leave', '/api/world/join']) {
      const r = await call(s.base, 'POST', path, {});
      expect(r.status, path).toBe(401);
      expect(r.body.error.code).toBe('not_logged_in');
    }
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect((await call(s.base, 'GET', '/api/world/status')).body).toEqual({ available: true, configured: true, state: 'logged_out', theme: 'halloween' });
  });

  it('approved without character: no building in the status or in the snapshot', async () => {
    const s = await start({ uplink: true });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    s.world!.accounts.get(EMAIL)!.access = 'approved';
    const st = (await call(s.base, 'GET', '/api/world/status?refresh=1')).body;
    expect(st.state).toBe('approved');
    expect(st.building).toBeUndefined();
    expect(s.hub.current().meta.world?.building).toBeUndefined();
    expect(s.world!.ws.connections).toHaveLength(0);
  });

  it('without the terminal lock: theme, pause and resume refuse; status and last upload respond', async () => {
    const s = await start({ uplink: true, terminal: false });
    for (const [method, path] of [['PUT', '/api/world/theme'], ['POST', '/api/world/pause'], ['POST', '/api/world/resume'], ['POST', '/api/world/leave'], ['POST', '/api/world/join']] as const) {
      const r = await call(s.base, method, path, method === 'PUT' ? { theme: 'none' } : {});
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).status).toBe(200);
    expect((await call(s.base, 'GET', '/api/world/status')).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ a cena Mundo (Fase 3)

interface SseClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  events(): Array<{ event: string; data: any }>;
  close(): void;
}

/** Abre o SSE e vai juntando o que chega (para os testes: sem EventSource no Node). */
function openStream(base: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((ok, fail) => {
    const req = http.request(new URL('/api/world/stream', base), { method: 'GET', headers }, (res) => {
      const c: SseClient = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: '',
        events: () =>
          c.body
            .split('\n\n')
            .filter((b) => b.startsWith('event: '))
            .map((b) => {
              const [ev, data] = b.split('\n');
              return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
            }),
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (d: string) => (c.body += d));
      res.on('error', () => undefined);
      ok(c);
    });
    req.on('error', fail);
    req.end();
  });
}

describe('the World scene through the routes (stream and commands)', () => {
  async function approved() {
    const s = await start({ uplink: true });
    const w = s.world!;
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => s.uplink!.connected, 'connection accepted');
    return { s, w, conn: () => w.ws.open[0]! };
  }

  it('the stream sends the snapshot, turns on the city (view), passes on what comes from the world and, when closed, sends view.off', async () => {
    const { s, conn } = await approved();
    expect(conn().messages.filter((m) => m.t === 'view')).toHaveLength(0);
    const sse = await openStream(s.base);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    await waitFor(() => sse.events().length >= 1, 'snapshot');
    const snap = sse.events()[0];
    expect(snap.event).toBe('world.snapshot');
    expect(snap.data).toMatchObject({ connected: true, viewing: true, district: 'centro', me: { id: 'acc_1', name: 'Ana Pixel' }, chunks: [], players: [] });
    expect(typeof snap.data.stream).toBe('string');
    await waitFor(() => conn().messages.some((m) => m.t === 'view'), 'view on the world server');

    conn().send({ t: 'pos', x: 21, y: 15 });
    conn().send({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    conn().send({ t: 'player.join', player: { id: 'p_2', name: 'Zeca', look: 'm', parts: {}, traits: ['games', 'cafeina'], likesReceived: 0, pos: { x: 25, y: 15, dir: 'w', moving: true }, where: 'street' } });
    conn().send({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [] });
    await waitFor(() => conn().messages.some((m) => m.t === 'resync'), 'resync of the jump');
    expect(conn().messages.find((m) => m.t === 'resync')).toEqual({ t: 'resync', chunk: 'centro:0,0' });
    expect(sse.events().filter((e) => e.event === 'world').map((e) => e.data.t)).toEqual(['pos', 'area', 'player.join']);
    // Nada do prédio (nem o token) no stream.
    expect(sse.body).not.toContain(s.store.get()!.token);
    expect(sse.body).not.toContain('uplink');

    // Comandos: só o último move de cada lote vai ao servidor do mundo.
    const stream = snap.data.stream;
    const r = await call(s.base, 'POST', '/api/world/cmd', {
      stream,
      cmds: [
        { t: 'move', x: 22, y: 15, dir: 'e', moving: true },
        { t: 'move', x: 23, y: 15, dir: 'e', moving: true, extra: 'does not go up' },
        { t: 'profile', playerId: 'p_2' },
      ],
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ sent: 2 });
    await waitFor(() => conn().messages.some((m) => m.t === 'profile'), 'commands on the world server');
    const city = conn().messages.filter((m) => m.t === 'move' || m.t === 'profile');
    expect(city).toEqual([{ t: 'move', x: 23, y: 15, dir: 'e', moving: true }, { t: 'profile', playerId: 'p_2' }]);
    // O que não é da cena nunca passa.
    for (const bad of [{ t: 'hello', v: 1, token: 'x' }, { t: 'uplink', uplink: {} }]) {
      const b = await call(s.base, 'POST', '/api/world/cmd', { stream, cmds: [bad] });
      expect(b.status).toBe(400);
      expect(b.body.error.code).toBe('invalid');
    }
    expect((await call(s.base, 'POST', '/api/world/cmd', { stream: 'none', cmds: [{ t: 'view' }] })).body.error.code).toBe('no_stream');

    sse.close();
    await waitFor(() => conn().messages.some((m) => m.t === 'view.off'), 'view.off');
    expect(s.viewer!.size).toBe(0);
  });

  it('paused and out of the world you can walk in the city: the connection stays (or comes back) only with the scene open and without any uplink', async () => {
    const { s, w, conn } = await approved();
    await waitFor(() => w.ws.uplinks.length >= 1, 'first upload');
    const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    /** O que a cena pode mandar com o prédio pausado ou fora do mundo. */
    const SCENE_ONLY = new Set(['hello', 'view', 'view.off', 'move', 'profile', 'ping', 'pong']);
    const sse = await openStream(s.base);
    await waitFor(() => conn().messages.some((m) => m.t === 'view'), 'view');
    const first = conn();
    const stream = sse.events()[0].data.stream;

    // Pausa com a cena aberta: a conexão continua, o tema novo (que mudaria o pacote) não sobe.
    expect((await call(s.base, 'POST', '/api/world/pause', {})).status).toBe(200);
    const sent = w.ws.uplinks.length;
    const fromPause = first.messages.length;
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'christmas' })).status).toBe(200);
    s.office.markDirty();
    await sleep(250);
    expect(first.open).toBe(true);
    expect(w.ws.uplinks).toHaveLength(sent);
    const move = await call(s.base, 'POST', '/api/world/cmd', { stream, cmds: [{ t: 'move', x: 22, y: 15, dir: 'e', moving: true }] });
    expect(move.status).toBe(202);
    await waitFor(() => first.messages.some((m) => m.t === 'move'), 'move while paused');
    // O cartão e o selo: pausado e apagado (a conexão da cena não acende o prédio).
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ connected: false, paused: true });
    expect(s.service!.meta().scene).toEqual({ available: true });

    // Fechada a cena: `view.off` e a conexão de quem está pausado fecha.
    sse.close();
    await waitFor(() => first.messages.some((m) => m.t === 'view.off'), 'view.off');
    await waitFor(() => !first.open, 'connection closed');
    expect(first.messages.slice(fromPause).every((m) => SCENE_ONLY.has(m.t as string))).toBe(true);

    // A cena de novo, ainda pausado: conexão nova com `hello` e `view`, e nenhum pacote (nem o do welcome).
    const sse2 = await openStream(s.base);
    await waitFor(() => w.ws.open.length === 1 && w.ws.open[0] !== first && w.ws.open[0]!.messages.some((m) => m.t === 'view'), 'view on the new connection');
    const second = w.ws.open[0]!;
    await sleep(250);
    expect(w.ws.uplinks).toHaveLength(sent);
    expect(second.messages.map((m) => m.t)).toEqual(['hello', 'view']);

    // Retomar com a cena aberta: o pacote inteiro sai pela mesma conexão, já com o tema novo.
    expect((await call(s.base, 'POST', '/api/world/resume', {})).status).toBe(200);
    await waitFor(() => w.ws.uplinks.length > sent, 'packet after resuming');
    expect(w.ws.uplinks.at(-1)).toMatchObject({ conn: second.id, uplink: { theme: 'christmas' } });
    expect(second.open).toBe(true);

    // Sair do mundo com a cena aberta: a conexão continua, sem pacote; o comando ainda vai.
    expect((await call(s.base, 'POST', '/api/world/leave', {})).status).toBe(200);
    const atLeave = w.ws.uplinks.length;
    const fromLeave = second.messages.length;
    expect((await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' })).status).toBe(200);
    await sleep(250);
    expect(w.ws.uplinks).toHaveLength(atLeave);
    expect(second.open).toBe(true);
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ connected: false, paused: true, left: true });
    const stream2 = sse2.events()[0].data.stream;
    expect((await call(s.base, 'POST', '/api/world/cmd', { stream: stream2, cmds: [{ t: 'profile', playerId: 'p_2' }] })).status).toBe(202);
    await waitFor(() => second.messages.some((m) => m.t === 'profile'), 'profile out of the world');
    sse2.close();
    await waitFor(() => !second.open, 'connection closed out of the world');
    expect(second.messages.slice(fromLeave).every((m) => SCENE_ONLY.has(m.t as string))).toBe(true);
    expect(w.ws.open).toHaveLength(0);
  });

  it('banned or suspended: the World button disappears (scene.available false) and the city does not open', async () => {
    const { s, conn } = await approved();
    expect(s.service!.meta().scene).toEqual({ available: true });
    conn().send({ t: 'goodbye', reason: 'suspended' });
    await waitFor(() => !s.uplink!.connected, 'connection closed');
    expect(s.service!.meta().scene).toEqual({ available: false });
    expect((await call(s.base, 'GET', '/api/world/status')).body.building).toMatchObject({ stopped: 'suspended' });
  });

  it('the stream only opens from the page itself: Origin from another site or Sec-Fetch-Site cross-site get 403', async () => {
    const { s, conn } = await approved();
    const refused: Array<Record<string, string>> = [{ Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }];
    for (const headers of refused) {
      const r = await call(s.base, 'GET', '/api/world/stream', undefined, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect(conn().messages.some((m) => m.t === 'view')).toBe(false);
    // A própria página (mesma origem) abre.
    const port = new URL(s.base).port;
    const ok = await openStream(s.base, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    ok.close();
  });

  it('at most 4 streams; the fifth gets 429 too_many_streams', async () => {
    const { s } = await approved();
    const open: SseClient[] = [];
    for (let i = 0; i < 4; i++) open.push(await openStream(s.base));
    expect(open.map((o) => o.status)).toEqual([200, 200, 200, 200]);
    const fifth = await call(s.base, 'GET', '/api/world/stream');
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('too_many_streams');
    open.forEach((o) => o.close());
  });

  it('locks: without the terminal lock, 403; without URL, 409; without account, the stream opens without connection', async () => {
    const off = await start({ uplink: true, terminal: false });
    for (const [method, path] of [['GET', '/api/world/stream'], ['POST', '/api/world/cmd']] as const) {
      const r = await call(off.base, method, path, method === 'GET' ? undefined : { stream: 'x', cmds: [{ t: 'view' }] });
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    const noUrl = await start({ world: 'no-url' });
    for (const [method, path] of [['GET', '/api/world/stream'], ['POST', '/api/world/cmd']] as const) {
      const r = await call(noUrl.base, method, path, method === 'GET' ? undefined : { stream: 'x', cmds: [{ t: 'view' }] });
      expect(r.status, path).toBe(409);
      expect(r.body.error.code).toBe('not_configured');
    }
    const none = await start({ uplink: true });
    const sse = await openStream(none.base);
    await waitFor(() => sse.events().length >= 1, 'snapshot');
    expect(sse.events()[0].data).toMatchObject({ connected: false, viewing: false });
    expect(none.world!.ws.connections).toHaveLength(0);
    sse.close();
  });
});

describe('the account and the data (Phase 6)', () => {
  async function approved(opts: { building?: Record<string, unknown> } = {}) {
    const s = await start({ uplink: true });
    const w = s.world!;
    if (opts.building) w.ws.options.building = opts.building;
    s.office.addMain({ id: '.claude:6', account: '.claude', sessionId: 'sess-6', cwd: '/p/f6', role: 'Main agent', startedAt: Date.now(), status: 'working' });
    await call(s.base, 'POST', '/api/world/register', REGISTER);
    await call(s.base, 'POST', '/api/world/verify', { email: EMAIL, code: FAKE_CODE });
    await call(s.base, 'PUT', '/api/world/character', CHARACTER);
    w.accounts.get(EMAIL)!.access = 'approved';
    await call(s.base, 'GET', '/api/world/status?refresh=1');
    await waitFor(() => w.ws.uplinks.length === 1 && existsSync(s.lastFile), 'first upload');
    return { s, w };
  }

  it('delete account: code requested, wrong code does not delete, the right one closes the building and deletes the whole world.json before answering', async () => {
    seen.length = 0;
    const { s, w } = await approved();
    // Um tema escolhido: sair da conta o deixaria no world.json; excluir apaga o arquivo inteiro.
    await call(s.base, 'PUT', '/api/world/theme', { theme: 'halloween' });
    const token = s.store.get()!.token;

    const asked = await call(s.base, 'POST', '/api/world/delete-account', {});
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({});
    expect(w.requests.find((r) => r.path === '/v1/me/delete')).toMatchObject({ method: 'POST', authorization: `Bearer ${token}` });

    // Fora do formato, recusado aqui; errado, recusado lá: nada muda.
    expect((await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '12' })).body.error.code).toBe('invalid_code');
    expect(w.requests.filter((r) => r.path === '/v1/me/delete/confirm')).toHaveLength(0);
    const wrong = await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_code');
    expect(s.store.get()?.token).toBe(token);
    expect(w.ws.open).toHaveLength(1);

    const done = await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: '123 456' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'account_deleted' });
    expect(w.requests.filter((r) => r.path === '/v1/me/delete/confirm').map((r) => r.body)).toEqual([{ code: '000000' }, { code: FAKE_CODE }]);
    // Quando a resposta chega: a conexão fechou, o world.json (tema junto) e a última remessa sumiram.
    expect(w.ws.open).toHaveLength(0);
    expect(existsSync(s.file)).toBe(false);
    expect(existsSync(s.lastFile)).toBe(false);
    expect(s.store.get()).toBeUndefined();
    expect((await call(s.base, 'GET', '/api/world/last-uplink')).body).toEqual({});
    expect(s.hub.current().meta.world).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    // Nada reconecta, e o status continua dizendo por quê.
    await new Promise((ok) => setTimeout(ok, 200));
    expect(w.ws.open).toHaveLength(0);
    expect((await call(s.base, 'GET', '/api/world/status')).body.lastError).toBe('account_deleted');
    // Sem conta, as rotas da conta pedem a conta.
    expect((await call(s.base, 'POST', '/api/world/delete-account', {})).body.error.code).toBe('not_logged_in');
    for (const text of seen) expect(text).not.toContain(token);
  });

  it('goodbye deleted (account deleted on another computer): the session and world.json disappear from here', async () => {
    const { s, w } = await approved();
    w.ws.open[0].goodbye('deleted');
    await waitFor(() => !s.store.get() && !existsSync(s.file), 'session deleted');
    await waitFor(() => !existsSync(s.lastFile), 'last upload deleted');
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'account_deleted' });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(w.ws.connections).toHaveLength(1);
  });

  it('download my data: the JSON as an attachment, once a day; only from the page itself; HEAD does not use up the quota', async () => {
    const { s, w } = await approved();
    const head = await call(s.base, 'HEAD', '/api/world/export');
    expect(head.status).toBe(200);
    const refused: Array<Record<string, string>> = [{ Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of refused) {
      const r = await call(s.base, 'GET', '/api/world/export', undefined, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body.error.code).toBe('local_only');
    }
    expect(w.requests.filter((r) => r.path === '/v1/me/export')).toHaveLength(0);

    const r = await call(s.base, 'GET', '/api/world/export', undefined, { 'Sec-Fetch-Site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="habblaud-world-dados.json"');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ format: 'habblaud-world-export', version: 1, account: { email: EMAIL }, player: { name: 'Ana Pixel' }, likesGiven: [], blocks: [], reportsMade: [] });
    expect(w.requests.find((q) => q.path === '/v1/me/export')?.method).toBe('GET');
    // A segunda no mesmo dia: 429, com a espera.
    const again = await call(s.base, 'GET', '/api/world/export');
    expect(again.status).toBe(429);
    expect(again.body.error).toEqual({ code: 'rate_limited', retryAfter: 86400 });
    expect(again.headers['retry-after']).toBe('86400');
  });

  it('download my data and delete: without account 401, without the terminal lock 403, without URL 409', async () => {
    const s = await start();
    expect((await call(s.base, 'GET', '/api/world/export')).body.error.code).toBe('not_logged_in');
    expect((await call(s.base, 'POST', '/api/world/delete-account/confirm', { code: FAKE_CODE })).body.error.code).toBe('not_logged_in');
    const off = await start({ terminal: false });
    for (const [m, p] of [['GET', '/api/world/export'], ['POST', '/api/world/delete-account'], ['POST', '/api/world/delete-account/confirm']]) {
      const r = await call(off.base, m, p, m === 'GET' ? undefined : { code: FAKE_CODE });
      expect(r.status, p).toBe(403);
      expect(r.body.error.code).toBe('terminal_off');
    }
    const noUrl = await start({ world: 'no-url' });
    expect((await call(noUrl.base, 'GET', '/api/world/export')).body.error.code).toBe('not_configured');
    expect(s.world!.requests).toEqual([]);
    expect(off.world!.requests).toEqual([]);
  });

  it('inactivity warning: goes in the visibility PUT only when sent; out of format, 422', async () => {
    const { s, w } = await approved();
    const vis = { mode: 'live', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false };
    expect((await call(s.base, 'PUT', '/api/world/visibility', { ...vis, notifyInactivity: 'yes' })).body.error.code).toBe('invalid');
    expect((await call(s.base, 'PUT', '/api/world/visibility', vis)).status).toBe(200);
    expect('notifyInactivity' in (w.requests.at(-1)!.body ?? {})).toBe(false);
    const off = await call(s.base, 'PUT', '/api/world/visibility', { ...vis, notifyInactivity: false });
    expect(off.body).toEqual({ ...vis, notifyInactivity: false });
    expect(w.requests.at(-1)!.body).toEqual({ ...vis, notifyInactivity: false });
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.player.visibility.notifyInactivity).toBe(false);
  });

  it('maintenance: the status says so (503 maintenance), the building tries again with a wait and comes back when it ends', async () => {
    const { s, w } = await approved();
    w.options.maintenance = true;
    w.ws.open[0].goodbye('deploy');
    const st = await call(s.base, 'GET', '/api/world/status?refresh=1');
    expect(st.body.lastError).toBe('maintenance');
    expect((await call(s.base, 'POST', '/api/world/delete-account', {})).body.error.code).toBe('maintenance');
    // Recusado a cada hello, com a espera crescendo (20, 40, 60 ms nos testes): poucas tentativas, nunca em rajada.
    await new Promise((ok) => setTimeout(ok, 400));
    const tries = w.ws.connections.length;
    expect(tries).toBeGreaterThan(2);
    expect(tries).toBeLessThan(15);
    w.options.maintenance = false;
    await waitFor(() => s.uplink!.connected, 'back');
    await waitFor(() => w.ws.uplinks.length >= 2, 'packet again');
    expect((await call(s.base, 'GET', '/api/world/status?refresh=1')).body.lastError).toBeUndefined();
  });

  it('unverified and the account id: from the welcome to the status (never in the snapshot); the city updates the badge', async () => {
    const { s, w } = await approved({ building: { id: 'acc_1', floors: 1, agents: { total: 1, working: 1, waiting: 0, idle: 0 }, unverified: true } });
    const st = (await call(s.base, 'GET', '/api/world/status')).body;
    expect(st.account).toEqual({ emailMasked: 'a***@example.com', access: 'approved', id: 'acc_1' });
    expect(st.building.unverified).toBe(true);
    expect(JSON.stringify(s.hub.current().meta.world)).not.toMatch(/unverified|acc_1/);
    // A revisão tirou o selo: o patch da cidade (o prédio inteiro, com lot e sem o campo) atualiza.
    w.ws.open[0].send({ t: 'area.patch', chunk: 'centro:0,0', rev: 1, changes: [{ id: 'acc_1', lot: { district: 'centro', x: 0, y: 0 }, floors: 1 }] });
    await waitFor(() => !s.uplink!.status().unverified, 'stamp removed');
    w.ws.open[0].send({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [{ id: 'acc_1', unverified: true }] });
    await waitFor(() => s.uplink!.status().unverified === true, 'stamp back');
    // De outro prédio, nada muda.
    w.ws.open[0].send({ t: 'area', chunk: 'centro:0,0', rev: 3, buildings: [{ id: 'acc_9', unverified: false }] });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(s.uplink!.status().unverified).toBe(true);
  });
});
