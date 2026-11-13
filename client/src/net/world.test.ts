import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../../shared/types';
import { fullParts, draftAppearance } from '../ui/world/world-model';
import {
  buildingFromMeta,
  FAKE_CODE,
  FAKE_EMAIL,
  FAKE_PASSWORD,
  FAKE_UPLINK,
  FakeWorldApi,
  HttpWorldApi,
  fakeWorldStateFrom,
  parseBuilding,
  parseLastUplink,
  parseWorldStatus,
  readWorldMeta,
  uplinkBytes,
  worldErrorCode,
  worldSource,
  type WorldCharacterInput,
} from './world';

type Call = { url: string; init?: RequestInit };

function recorder(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status }));
  }) as unknown as typeof fetch;
  return { calls, api: new HttpWorldApi(fetchImpl) };
}

const snap = (world: unknown): OfficeSnapshot => ({ meta: { world } }) as unknown as OfficeSnapshot;

const CHARACTER: WorldCharacterInput = {
  name: 'Pixel Dev',
  look: 'f',
  parts: fullParts(draftAppearance('f')),
  traits: ['cafeina', 'games'],
  intro: 'coffee',
};

describe('HttpWorldApi', () => {
  it('each action goes to the contract route, with JSON (even empty) in the POST/PUT', async () => {
    const { calls, api } = recorder(202, {});
    await api.register({ email: 'a@b.co', password: 'x'.repeat(12), name: 'Ana Pixel', locale: 'pt-BR' });
    await api.verify({ email: 'a@b.co', code: '123456' });
    await api.login({ email: 'a@b.co', password: 'x'.repeat(12) });
    await api.logout();
    await api.resend({ email: 'a@b.co' });
    await api.forgotPassword({ email: 'a@b.co' });
    await api.resetPassword({ email: 'a@b.co', code: '123456', password: 'y'.repeat(12) });
    await api.saveCharacter(CHARACTER);
    await api.saveVisibility({ mode: 'discreet', closed: true, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false, knocks: false });
    await api.revokeDevice('d/1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST /api/world/register',
      'POST /api/world/verify',
      'POST /api/world/login',
      'POST /api/world/logout',
      'POST /api/world/resend',
      'POST /api/world/password/forgot',
      'POST /api/world/password/reset',
      'PUT /api/world/character',
      'PUT /api/world/visibility',
      'POST /api/world/devices/d%2F1/revoke',
    ]);
    for (const c of calls) {
      expect(c.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(typeof c.init?.body).toBe('string');
    }
    expect(calls[3].init?.body).toBe('{}');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ email: 'a@b.co', password: 'x'.repeat(12), name: 'Ana Pixel', locale: 'pt-BR' });
    expect(JSON.parse(String(calls[7].init?.body))).toEqual(CHARACTER);
  });

  it('GET with no body; the status comes checked', async () => {
    const { calls, api } = recorder(200, { available: true, configured: true, state: 'waiting', account: { emailMasked: 'yo***@example.com', access: 'waiting' } });
    const r = await api.status();
    expect(calls[0].url).toBe('/api/world/status');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(r).toEqual({ ok: true, data: { available: true, configured: true, state: 'waiting', account: { emailMasked: 'yo***@example.com', access: 'waiting' } } });
  });

  it('malformed status becomes an error, not made-up state', async () => {
    expect((await recorder(200, { state: 'dancing' }).api.status()).ok).toBe(false);
    expect((await recorder(200, '<html>').api.status()).ok).toBe(false);
  });

  it('devices: accepts the bare list or inside {devices}', async () => {
    const list = [{ id: 'd1', label: 'Dispositivo 1', current: true }, { id: 'd2', label: 'Dispositivo 2' }];
    const a = await recorder(200, list).api.devices();
    const b = await recorder(200, { devices: list }).api.devices();
    expect(a).toEqual(b);
    expect(a.ok && a.data.map((d) => d.current)).toEqual([true, false]);
  });

  it('contract error: the code comes from the body and the status goes along', async () => {
    const r = await recorder(409, { error: { code: 'name_taken', message: 'Name taken' } }).api.saveCharacter(CHARACTER);
    expect(r).toEqual({ ok: false, code: 'name_taken', status: 409 });
  });

  it('no code (guard, route turned off, empty body): decides by the HTTP status', async () => {
    expect(await recorder(403, { error: 'Origin not allowed.' }).api.logout()).toMatchObject({ code: 'forbidden' });
    expect(await recorder(404, undefined).api.status()).toMatchObject({ code: 'not_configured' });
    expect(await recorder(429, '').api.resend({ email: 'a@b.co' })).toMatchObject({ code: 'rate_limited' });
    expect(await recorder(500, { error: { code: 'something_new' } }).api.logout()).toMatchObject({ code: 'unknown' });
  });

  it('no response from Habblaud: offline', async () => {
    const api = new HttpWorldApi((() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch);
    expect(await api.login({ email: 'a@b.co', password: 'x' })).toEqual({ ok: false, code: 'offline', status: 0 });
  });

  it('worldErrorCode only accepts the known codes', () => {
    expect(worldErrorCode(400, { error: { code: 'invalid_code' } })).toBe('invalid_code');
    expect(worldErrorCode(400, { error: { code: '__proto__' } })).toBe('unknown');
  });
});

describe('meta.world and status', () => {
  it('readWorldMeta: missing, malformed or with an unknown state', () => {
    expect(readWorldMeta(null)).toBeUndefined();
    expect(readWorldMeta(snap(undefined))).toBeUndefined();
    expect(readWorldMeta(snap({ configured: true }))).toBeUndefined();
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'waiting' }))).toEqual({ enabled: true, configured: true, state: 'waiting' });
    expect(readWorldMeta(snap({ enabled: true, state: 'zzz' }))).toEqual({ enabled: true, configured: false, state: 'off' });
  });

  it('readWorldMeta: the World scene (Phase 3) only with a boolean `available`', () => {
    const base = { enabled: true, configured: true, state: 'approved' };
    expect(readWorldMeta(snap({ ...base, scene: { available: true } }))?.scene).toEqual({ available: true });
    expect(readWorldMeta(snap({ ...base, scene: { available: false, extra: 1 } }))?.scene).toEqual({ available: false });
    expect(readWorldMeta(snap({ ...base, scene: { available: 'yes' } }))).not.toHaveProperty('scene');
    expect(readWorldMeta(snap({ ...base, scene: [] }))).not.toHaveProperty('scene');
  });

  it('parseWorldStatus fills in the character visibility with the defaults', () => {
    const s = parseWorldStatus({ state: 'approved', configured: true, player: { name: 'Pixel', look: 'm', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee', visibility: { mode: 'discreet' } } });
    expect(s?.player?.visibility).toEqual({ mode: 'discreet', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false, knocks: false });
  });

  it('parseWorldStatus: mustRename only when it is true', () => {
    const player = { name: '???', look: 'm', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee' };
    expect(parseWorldStatus({ state: 'approved', player: { ...player, mustRename: true } })?.player?.mustRename).toBe(true);
    expect(parseWorldStatus({ state: 'approved', player: { ...player, mustRename: 1 } })?.player).not.toHaveProperty('mustRename');
  });
});

describe('FakeWorldApi', () => {
  const fake = (state?: ConstructorParameters<typeof FakeWorldApi>[0]) => new FakeWorldApi({ delayMs: 0, ...state });

  it('sign-up → code → waitlist → approved', async () => {
    const api = fake();
    expect(api.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    expect((await api.register({ email: 'nova@example.com', password: 'correct horse battery', name: 'Nova Pixel', locale: 'pt-BR' })).ok).toBe(true);
    expect(await api.verify({ email: 'nova@example.com', code: '000000' })).toMatchObject({ ok: false, code: 'invalid_code' });
    expect((await api.verify({ email: 'nova@example.com', code: FAKE_CODE })).ok).toBe(true);
    expect(api.meta().state).toBe('waiting');
    // The sign-up name stays reserved until the character exists.
    const st = await api.status();
    expect(st.ok && st.data.account).toEqual({ emailMasked: 'no***@example.com', access: 'waiting', reservedName: 'Nova Pixel' });
    api.approve();
    expect(api.meta().state).toBe('approved');
  });

  it('sign-up: the name is checked before the password and cannot be in use; creating the character uses the reservation', async () => {
    const api = fake({ state: 'waiting' });
    await api.logout();
    expect(await api.register({ email: 'x@example.com', password: 'short', name: 'a!', locale: 'pt-BR' })).toMatchObject({ code: 'name_invalid', status: 422 });
    expect(await api.register({ email: 'x@example.com', password: 'correct horse battery', name: 'Admin', locale: 'pt-BR' })).toMatchObject({ code: 'name_blocked' });
    // "Pixel Dev" is the reservation of the demo account; "Marina" belongs to a fixed character.
    expect(await api.register({ email: 'x@example.com', password: 'correct horse battery', name: 'pixel dev', locale: 'pt-BR' })).toMatchObject({ code: 'name_taken', status: 409 });
    expect(await api.register({ email: 'x@example.com', password: 'correct horse battery', name: 'MARINA', locale: 'pt-BR' })).toMatchObject({ code: 'name_taken' });
    expect((await api.register({ email: 'x@example.com', password: 'correct horse battery', name: 'Xis Pixel', locale: 'pt-BR' })).ok).toBe(true);
    await api.verify({ email: 'x@example.com', code: FAKE_CODE });
    // Without `name` in the body: the character is born with the reservation; with `name`, it is ignored.
    const { name: _name, ...rest } = CHARACTER;
    expect((await api.saveCharacter(rest)).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.player?.name).toBe('Xis Pixel');
    expect(st.ok && st.data.account).not.toHaveProperty('reservedName');
  });

  it('name changed by force: the status asks for a new name and saving the character resolves it', async () => {
    const api = fake({ state: 'approved' });
    api.forceRename();
    const before = await api.status();
    expect(before.ok && before.data.player).toMatchObject({ name: '???', mustRename: true });
    const p = before.ok ? before.data.player! : null;
    expect((await api.saveCharacter({ name: 'Pixel Nova', look: p!.look, parts: p!.parts, traits: p!.traits, intro: p!.intro })).ok).toBe(true);
    const after = await api.status();
    expect(after.ok && after.data.player?.name).toBe('Pixel Nova');
    expect(after.ok && after.data.player).not.toHaveProperty('mustRename');
  });

  it('login: wrong credentials, unconfirmed email, banned', async () => {
    const api = fake();
    await api.register({ email: 'nova@example.com', password: 'correct horse battery', name: 'Nova Pixel', locale: 'pt-BR' });
    expect(await api.login({ email: 'nova@example.com', password: 'some other password' })).toMatchObject({ code: 'invalid_credentials' });
    expect(await api.login({ email: 'nova@example.com', password: 'correct horse battery' })).toMatchObject({ code: 'email_not_verified' });
    expect(await api.login({ email: 'banido@example.com', password: 'correct horse battery' })).toMatchObject({ code: 'banned' });
    expect(await api.login({ email: 'nobody@example.com', password: 'correct horse battery' })).toMatchObject({ code: 'invalid_credentials' });
  });

  it('sign-up with an email that already exists answers the same (does not reveal who has an account)', async () => {
    const api = fake({ state: 'waiting' });
    await api.logout();
    expect((await api.register({ email: FAKE_EMAIL, password: 'correct horse battery', name: 'Another Person', locale: 'pt-BR' })).ok).toBe(true);
    // The old password still works.
    expect((await api.login({ email: FAKE_EMAIL, password: FAKE_PASSWORD })).ok).toBe(true);
  });

  it('character: name in use, reserved, invalid and traits that do not go together (editing: the name comes from the body)', async () => {
    const api = fake({ state: 'approved' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'Marina' })).toMatchObject({ code: 'name_taken' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'Admin' })).toMatchObject({ code: 'name_blocked' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'a!' })).toMatchObject({ code: 'name_invalid' });
    expect(await api.saveCharacter({ ...CHARACTER, traits: ['timidez', 'piadas'] })).toMatchObject({ code: 'invalid' });
    expect((await api.saveCharacter(CHARACTER)).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.player).toMatchObject({ name: 'Pixel Dev', traits: ['cafeina', 'games'], intro: 'coffee', country: 'BR' });
  });

  it('visibility only with a character; hiding the country removes the country from the profile', async () => {
    const api = fake({ state: 'approved' });
    const vis = { mode: 'live', closed: false, hideCountry: true, tokensVisible: false, leaderboard: false, compactions: false, knocks: false } as const;
    expect((await api.saveVisibility(vis)).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.player?.visibility).toEqual(vis);
    expect(st.ok && st.data.player?.country).toBeUndefined();
    const fresh = fake({ state: 'waiting' });
    expect(await fresh.saveVisibility(vis)).toMatchObject({ code: 'invalid' });
  });

  it('devices: revoking another one removes it from the list; revoking this one signs out', async () => {
    const api = fake({ state: 'approved' });
    const list = await api.devices();
    expect(list.ok && list.data.map((d) => [d.label, d.current])).toEqual([['Dispositivo 2', false], ['Dispositivo 1', true]]);
    const other = list.ok ? list.data.find((d) => !d.current)! : null;
    expect((await api.revokeDevice(other!.id)).ok).toBe(true);
    const after = await api.devices();
    expect(after.ok && after.data).toHaveLength(1);
    const me = after.ok ? after.data[0] : null;
    await api.revokeDevice(me!.id);
    expect(api.meta().state).toBe('logged_out');
  });

  it('forgot the password: wrong code, right code changes the password and disconnects everything', async () => {
    const api = fake({ state: 'waiting' });
    expect((await api.forgotPassword({ email: FAKE_EMAIL })).ok).toBe(true);
    expect(await api.resetPassword({ email: FAKE_EMAIL, code: '111111', password: 'a new very long password' })).toMatchObject({ code: 'invalid_code' });
    expect((await api.resetPassword({ email: FAKE_EMAIL, code: FAKE_CODE, password: 'a new very long password' })).ok).toBe(true);
    expect(api.meta().state).toBe('logged_out');
    expect(await api.login({ email: FAKE_EMAIL, password: FAKE_PASSWORD })).toMatchObject({ code: 'invalid_credentials' });
    expect((await api.login({ email: FAKE_EMAIL, password: 'a new very long password' })).ok).toBe(true);
  });

  it('resend the code: 3 per hour', async () => {
    let now = 1_000_000;
    const api = fake({ now: () => now });
    for (let i = 0; i < 3; i++) expect((await api.resend({ email: 'a@b.co' })).ok).toBe(true);
    expect(await api.resend({ email: 'a@b.co' })).toMatchObject({ code: 'rate_limited' });
    now += 3_600_001;
    expect((await api.resend({ email: 'a@b.co' })).ok).toBe(true);
  });

  it('failNext simulates a network error or a world server error on the next call', async () => {
    const api = fake({ state: 'waiting' });
    api.failNext('network');
    expect(await api.status()).toMatchObject({ ok: false, code: 'network' });
    expect((await api.status()).ok).toBe(true);
  });

  it('no server configured: everything answers not_configured', async () => {
    const api = fake({ state: 'off' });
    expect(api.meta()).toEqual({ enabled: false, configured: false, state: 'off' });
    expect(await api.login({ email: 'a@b.co', password: 'x' })).toMatchObject({ code: 'not_configured' });
  });

  it('notifies whoever listens when the state changes', async () => {
    const api = fake();
    let n = 0;
    const off = api.onChange(() => n++);
    await api.register({ email: 'nova@example.com', password: 'correct horse battery', name: 'Nova Pixel', locale: 'pt-BR' });
    await api.verify({ email: 'nova@example.com', code: FAKE_CODE });
    expect(n).toBe(2);
    // Reading does not notify (otherwise the interface would reread the status nonstop).
    await api.status();
    await api.devices();
    expect(n).toBe(2);
    off();
    api.approve();
    expect(n).toBe(2);
  });
});

describe('where the data comes from', () => {
  it('?world= chooses the initial state of the fake (unknown value: no account)', () => {
    expect(fakeWorldStateFrom('?mock=1')).toBeNull();
    expect(fakeWorldStateFrom('?mock=1&world')).toBe('logged_out');
    expect(fakeWorldStateFrom('?mock=1&world=waiting')).toBe('waiting');
    expect(fakeWorldStateFrom('?world=xyz')).toBe('logged_out');
  });

  it('demo mode without &world: nothing from the World (the old screenshots do not change)', () => {
    const src = worldSource({ mock: true, liveSnapshot: null }, '?mock=1');
    expect(src.client).toBeNull();
    expect(src.meta()).toBeUndefined();
  });

  it('demo mode with &world: the fake answers (approved: with the building in the world)', () => {
    const src = worldSource({ mock: true, liveSnapshot: null }, '?mock=1&world=approved');
    expect(src.fake).toBe(true);
    expect(src.client).toBeInstanceOf(FakeWorldApi);
    expect(src.meta()).toEqual({
      enabled: true,
      configured: true,
      state: 'approved',
      // Phase 5: likes of the day (3 and one more per minute) and the unseen summary of demo mode
      building: { connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: expect.any(Number), visitors: 0, likesToday: 3, awaySummary: true },
      scene: { available: true },
    });
    expect(worldSource({ mock: true, liveSnapshot: null }, '?mock=1&world=waiting').meta()).toEqual({ enabled: true, configured: true, state: 'waiting' });
  });

  it('live: local routes and the meta.world of the live snapshot', () => {
    const store = { mock: false, liveSnapshot: snap({ enabled: true, configured: true, state: 'logged_out' }) };
    const src = worldSource(store, '?world=waiting');
    expect(src.client).toBeInstanceOf(HttpWorldApi);
    expect(src.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
  });
});

// ------------------------------------------------------------------ Phase 2: building in the world

describe('building: local routes of Phase 2', () => {
  it('last upload, pause, resume, leave the world and theme go to the contract routes', async () => {
    const { calls, api } = recorder(200, {});
    await api.lastUplink();
    await api.pause();
    await api.resume();
    await api.leave();
    await api.join();
    await api.setTheme('christmas');
    expect(calls.map((c) => `${c.init?.method} ${c.url} ${c.init?.body ?? ''}`.trim())).toEqual([
      'GET /api/world/last-uplink',
      'POST /api/world/pause {}',
      'POST /api/world/resume {}',
      'POST /api/world/leave {}',
      'POST /api/world/join {}',
      'PUT /api/world/theme {"theme":"christmas"}',
    ]);
  });

  it('last upload: {} is "nothing has left yet"; the packet comes as it was stored; out of format is an error', async () => {
    expect(await recorder(200, {}).api.lastUplink()).toEqual({ ok: true, data: null });
    const body = { at: 1_760_000_000_000, bytes: 1174, uplink: FAKE_UPLINK, ack: { ok: true, at: 1_760_000_000_050 } };
    expect(await recorder(200, body).api.lastUplink()).toEqual({ ok: true, data: body });
    expect(await recorder(200, { at: 'yesterday', uplink: {} }).api.lastUplink()).toMatchObject({ ok: false, code: 'unknown' });
    expect(await recorder(401, { error: { code: 'not_logged_in' } }).api.lastUplink()).toMatchObject({ ok: false, code: 'not_logged_in' });
  });

  it('the refused response without a code (or with one this version does not know) becomes "internal"; malformed numbers become 0', () => {
    expect(parseLastUplink({ at: 5, bytes: 10, uplink: { v: 1 }, ack: { ok: false, at: 6 } })?.ack).toEqual({ ok: false, error: 'internal', at: 6 });
    expect(parseLastUplink({ at: 5, bytes: 10, uplink: { v: 1 }, ack: { ok: false, error: 'new', at: 6 } })?.ack).toEqual({ ok: false, error: 'internal', at: 6 });
    // Accepted: the bytes the world counted; without a time, the answer does not count.
    expect(parseLastUplink({ at: 5, bytes: 10, uplink: { v: 1 }, ack: { ok: true, at: 6, bytes: 10 } })?.ack).toEqual({ ok: true, at: 6, bytes: 10 });
    expect(parseLastUplink({ at: 5, bytes: 10, uplink: { v: 1 }, ack: { ok: true } })?.ack).toBeUndefined();
    expect(parseBuilding({ connected: 'yes', paused: true, floors: -3, agents: 2.7, lastUplinkAt: 'now', lastAck: { ok: false, error: 'rate' } })).toEqual({
      connected: false,
      paused: true,
      floors: 0,
      agents: 2,
      lastAck: { ok: false, error: 'rate' },
    });
    expect(parseBuilding('building')).toBeUndefined();
  });

  it('pause and resume return the WorldStatus: its building.paused holds; without the field, what was asked', async () => {
    expect(await recorder(200, { state: 'approved', building: { paused: true } }).api.pause()).toEqual({ ok: true, data: { paused: true } });
    expect(await recorder(200, { state: 'approved', building: { paused: true } }).api.resume()).toEqual({ ok: true, data: { paused: true } });
    expect(await recorder(200, '').api.resume()).toEqual({ ok: true, data: { paused: false } });
    expect(await recorder(409, { error: { code: 'no_player' } }).api.pause()).toMatchObject({ ok: false, code: 'no_player' });
    expect(await recorder(503, { error: { code: 'unavailable' } }).api.leave()).toMatchObject({ ok: false, code: 'unavailable', status: 503 });
  });

  it('status: the reason for the stop (only the known ones), out of the world and the stored theme', () => {
    const base = { connected: false, paused: true, floors: 1, agents: 1 };
    expect(parseWorldStatus({ state: 'approved', building: { ...base, stopped: 'update', left: true }, theme: 'christmas' })).toMatchObject({
      building: { ...base, stopped: 'update', left: true },
      theme: 'christmas',
    });
    const odd = parseWorldStatus({ state: 'approved', building: { ...base, stopped: 'deploy', left: 'yes' }, theme: 'easter' });
    expect(odd?.building).toEqual(base);
    expect(odd?.theme).toBeUndefined();
    // In the snapshot, the stop is only yes/no (the reason does not go to the phone).
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'approved', building: { ...base, stopped: true } }))?.building).toEqual({ ...base, stopped: true });
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'approved', building: { ...base, stopped: 'update' } }))?.building).toEqual(base);
    expect(buildingFromMeta({ ...base, stopped: true, left: true })).toEqual({ ...base, left: true });
  });

  it('meta.world and the status bring the building, checked', () => {
    const building = { connected: true, paused: false, floors: 3, agents: 5, lastUplinkAt: 1_760_000_000_000 };
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'approved', building }))).toEqual({ enabled: true, configured: true, state: 'approved', building });
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'approved', building: 7 }))).toEqual({ enabled: true, configured: true, state: 'approved' });
    const st = parseWorldStatus({ state: 'approved', configured: true, building: { ...building, lastAck: { ok: false, error: 'limits' } } });
    expect(st?.building).toEqual({ ...building, lastAck: { ok: false, error: 'limits' } });
  });
});

describe('FakeWorldApi: building', () => {
  const OCT = Date.UTC(2026, 9, 15, 12);
  const JULY = Date.UTC(2026, 6, 1, 12);
  const clock = (start: number) => {
    let t = start;
    return { now: () => t, tick: (ms: number) => (t += ms) };
  };

  it('fake visitors (Phase 4): nobody in the first seconds, then 1 and 2; setVisitors fixes it; paused, nothing', async () => {
    const c = clock(OCT);
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: c.now });
    expect(api.meta().building?.visitors).toBe(0);
    c.tick(9_000);
    expect(api.meta().building?.visitors).toBe(1);
    c.tick(15_000);
    expect(api.meta().building?.visitors).toBe(2);
    api.setVisitors(5);
    expect(api.meta().building?.visitors).toBe(5);
    expect((await api.status()).ok && (await api.status() as { data: { building?: { visitors?: number } } }).data.building?.visitors).toBe(5);
    await api.pause();
    expect(api.meta().building).not.toHaveProperty('visitors');
  });

  it('the example from 3.3: random ids in the protocol format, parents present, complete pieces', () => {
    const agents = FAKE_UPLINK.floors.flatMap((f) => f.agents);
    for (const f of FAKE_UPLINK.floors) expect(f.id).toMatch(/^f_[0-9a-f]{10}$/);
    for (const a of agents) {
      expect(a.id).toMatch(/^a_[0-9a-f]{8}$/);
      expect(Object.keys(a.parts)).toHaveLength(12);
      if (a.kind === 'sub') expect(agents.map((x) => x.id)).toContain(a.parentId);
    }
    expect(uplinkBytes(FAKE_UPLINK)).toBe(new TextEncoder().encode(JSON.stringify(FAKE_UPLINK)).length);
  });

  it('approved: building lit, the sample upload with the theme of the day and the accepted response', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => OCT });
    const st = await api.status();
    expect(st.ok && st.data.building).toMatchObject({ connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: OCT, lastAck: { ok: true }, visitors: 0 });
    const last = await api.lastUplink();
    const bytes = uplinkBytes({ ...FAKE_UPLINK, theme: 'halloween' });
    expect(last.ok && last.data).toEqual({ at: OCT, bytes, uplink: { ...FAKE_UPLINK, theme: 'halloween' }, ack: { ok: true, at: OCT, bytes } });
    // Outside October, the automatic one sends the original look.
    const july = await new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => JULY }).lastUplink();
    expect(july.ok && july.data?.uplink.theme).toBe('none');
  });

  it('on the waitlist, without an account or without a character: no building', async () => {
    expect(new FakeWorldApi({ state: 'waiting', delayMs: 0 }).meta()).not.toHaveProperty('building');
    expect(await new FakeWorldApi({ state: 'logged_out', delayMs: 0 }).lastUplink()).toMatchObject({ ok: false, code: 'not_logged_in' });
    const api = new FakeWorldApi({ state: 'waiting', delayMs: 0 });
    // The waiting sample account has no character: approved, still with no building; with the character, it lights up.
    api.approve();
    expect(api.meta()).not.toHaveProperty('building');
    expect(await api.pause()).toMatchObject({ ok: false, code: 'no_player' });
    expect(await api.lastUplink()).toEqual({ ok: true, data: null });
    expect((await api.saveCharacter(CHARACTER)).ok).toBe(true);
    expect(api.meta().building).toMatchObject({ connected: true, paused: false, floors: 2, agents: 3 });
  });

  it('pausing turns it off and stops sending; resuming lights it up and sends the whole packet again', async () => {
    const c = clock(OCT);
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: c.now });
    let n = 0;
    api.onChange(() => n++);
    c.tick(60_000);
    expect(await api.pause()).toEqual({ ok: true, data: { paused: true } });
    expect(api.meta().building).toMatchObject({ connected: false, paused: true, floors: 2, agents: 3, lastUplinkAt: OCT });
    // Paused, changing the theme sends nothing.
    await api.setTheme('christmas');
    expect(api.meta().building?.lastUplinkAt).toBe(OCT);
    c.tick(60_000);
    expect(await api.resume()).toEqual({ ok: true, data: { paused: false } });
    expect(api.meta().building).toMatchObject({ connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: OCT + 120_000, visitors: expect.any(Number) });
    const last = await api.lastUplink();
    expect(last.ok && last.data?.uplink.theme).toBe('christmas');
    expect(n).toBe(3);
  });

  it('theme: saves the choice, resolves the automatic one and refuses a value outside the list', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => OCT });
    expect(api.worldTheme()).toBe('auto');
    expect((await api.setTheme('none')).ok).toBe(true);
    expect(api.worldTheme()).toBe('none');
    const last = await api.lastUplink();
    expect(last.ok && last.data?.uplink.theme).toBe('none');
    expect(await api.setTheme('carnival' as 'none')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refused upload: the status and the last upload bring the reason', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => OCT });
    api.rejectUplinks('limits');
    const st = await api.status();
    expect(st.ok && st.data.building?.lastAck).toEqual({ ok: false, error: 'limits' });
    const last = await api.lastUplink();
    expect(last.ok && last.data?.ack).toEqual({ ok: false, error: 'limits', at: OCT });
    expect(api.meta().building).not.toHaveProperty('lastAck');
  });

  it('leave the world: off and out of the world until coming back, which sends the whole packet again', async () => {
    const c = clock(OCT);
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: c.now });
    expect((await api.leave()).ok).toBe(true);
    expect(api.meta().building).toMatchObject({ connected: false, paused: true, left: true });
    const st = await api.status();
    expect(st.ok && st.data.building).toMatchObject({ left: true });
    c.tick(60_000);
    expect(await api.join()).toEqual({ ok: true, data: null });
    expect(api.meta().building).toMatchObject({ connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: OCT + 60_000, visitors: expect.any(Number) });
    // Without having left, going back changes nothing (and does not send another upload).
    c.tick(60_000);
    expect((await api.join()).ok).toBe(true);
    expect(api.meta().building?.lastUplinkAt).toBe(OCT + 60_000);
  });

  it('stopped by the "world": the status brings the reason, the meta only "stopped"; resuming brings it back', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => OCT });
    api.stopBuilding('other-device');
    const st = await api.status();
    expect(st.ok && st.data.building?.stopped).toBe('other-device');
    expect(api.meta().building).toMatchObject({ connected: false, stopped: true });
    await api.resume();
    expect(api.meta().building).not.toHaveProperty('stopped');
  });

  it('the status brings the stored theme (absent in automatic)', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => OCT });
    expect((await api.status()).ok && (await api.status()).ok).toBe(true);
    const before = await api.status();
    expect(before.ok && before.data.theme).toBeUndefined();
    await api.setTheme('halloween');
    const after = await api.status();
    expect(after.ok && after.data.theme).toBe('halloween');
  });

  it('dropped connection: reconnecting until it resumes; signing out removes the building from the meta', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0 });
    api.dropConnection();
    expect(api.meta().building).toMatchObject({ connected: false, paused: false });
    await api.logout();
    expect(api.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
  });
});

describe('account and data (Phase 6)', () => {
  it('deleting the account and downloading the data go to the contract routes; the JSON comes formatted for saving', async () => {
    const { calls, api } = recorder(200, { account: { email: 'a@b.co' }, likesGiven: [] });
    expect(await api.requestAccountDeletion()).toEqual({ ok: true, data: null });
    expect(await api.confirmAccountDeletion({ code: '123456' })).toEqual({ ok: true, data: null });
    const exp = await api.exportData();
    expect(exp).toEqual({ ok: true, data: '{\n  "account": {\n    "email": "a@b.co"\n  },\n  "likesGiven": []\n}\n' });
    expect(calls.map((c) => `${c.init?.method} ${c.url} ${c.init?.body ?? ''}`)).toEqual([
      'POST /api/world/delete-account {}',
      'POST /api/world/delete-account/confirm {"code":"123456"}',
      'GET /api/world/export ',
    ]);
    expect((await recorder(200, [1]).api.exportData()).ok).toBe(false);
    expect(await recorder(429, { error: { code: 'rate_limited', retryAfter: 86400 } }).api.exportData()).toMatchObject({ ok: false, code: 'rate_limited', status: 429 });
    expect(await recorder(503, { error: { code: 'maintenance' } }).api.status()).toMatchObject({ ok: false, code: 'maintenance', status: 503 });
  });

  it('status: the account id (only a clean id) and the "unverified" badge of the building', () => {
    const base = { available: true, configured: true, state: 'approved' };
    expect(parseWorldStatus({ ...base, account: { emailMasked: 'a***@b.co', access: 'approved', id: 'acc_1' } })?.account).toEqual({ emailMasked: 'a***@b.co', access: 'approved', id: 'acc_1' });
    expect(parseWorldStatus({ ...base, account: { emailMasked: 'a***@b.co', access: 'approved', id: '<x>' } })?.account).toEqual({ emailMasked: 'a***@b.co', access: 'approved' });
    expect(parseBuilding({ connected: true, paused: false, floors: 1, agents: 1, unverified: true })?.unverified).toBe(true);
    expect(parseBuilding({ connected: true, paused: false, floors: 1, agents: 1, unverified: 'yes' })?.unverified).toBeUndefined();
    expect(parseWorldStatus({ ...base, player: { name: 'P', look: 'f', parts: {}, traits: [], intro: 'hello', visibility: { notifyInactivity: false } } })?.player?.visibility.notifyInactivity).toBe(false);
  });

  it('FakeWorldApi: deleting the account asks for the code; the right one removes the account and leaves the notice; export once a day', async () => {
    const api = new FakeWorldApi({ delayMs: 0, state: 'approved' });
    await api.setTheme('halloween');
    const data = await api.exportData();
    expect(data.ok && JSON.parse(data.data)).toMatchObject({ account: { email: FAKE_EMAIL }, player: { name: 'Pixel Dev' } });
    expect(await api.exportData()).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await api.confirmAccountDeletion({ code: FAKE_CODE })).toMatchObject({ ok: false, code: 'invalid_code' });
    expect((await api.requestAccountDeletion()).ok).toBe(true);
    expect(await api.confirmAccountDeletion({ code: '000000' })).toMatchObject({ ok: false, code: 'invalid_code' });
    expect((await api.confirmAccountDeletion({ code: FAKE_CODE })).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data).toEqual({ available: true, configured: true, state: 'logged_out', lastError: 'account_deleted' });
    expect(api.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    expect(await api.login({ email: FAKE_EMAIL, password: FAKE_PASSWORD })).toMatchObject({ ok: false, code: 'invalid_credentials' });
  });

  it('FakeWorldApi: maintenance in the status and the building without a connection until it ends', async () => {
    const api = new FakeWorldApi({ delayMs: 0, state: 'approved' });
    api.setMaintenance(true);
    let st = await api.status();
    expect(st.ok && st.data).toMatchObject({ lastError: 'maintenance', building: { connected: false } });
    api.setMaintenance(false);
    st = await api.status();
    expect(st.ok && st.data.lastError).toBeUndefined();
    expect(st.ok && st.data.building?.connected).toBe(true);
  });

  it('FakeWorldApi: the "world" marks the building as unverified and the inactivity notice stays in the visibility', async () => {
    const api = new FakeWorldApi({ delayMs: 0, state: 'approved' });
    api.markUnverified(true);
    let st = await api.status();
    expect(st.ok && st.data.building?.unverified).toBe(true);
    api.markUnverified(false);
    st = await api.status();
    expect(st.ok && st.data.building?.unverified).toBeUndefined();
    const vis = st.ok ? st.data.player!.visibility : undefined;
    expect((await api.saveVisibility({ ...vis!, notifyInactivity: false })).ok).toBe(true);
    st = await api.status();
    expect(st.ok && st.data.player?.visibility.notifyInactivity).toBe(false);
  });
});
