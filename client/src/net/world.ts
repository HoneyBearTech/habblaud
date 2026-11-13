// Habblaud World in the browser: the client of the local routes /api/world/* (the local Habblaud server talks to the
// world server; the device token never reaches the browser) and a FakeWorldApi for demo mode
// (?mock=1&world=...) and for the tests. Errors arrive as `{error: {code}}`; the interface translates the code
// (ui/world/world-model.ts) and never shows the server's `message`.
//
// Phase 2 (building in the world): `building` in meta.world and in the status, GET /api/world/last-uplink (the last
// upload, for "See what was sent"), POST /api/world/pause, /resume and /leave and PUT /api/world/theme. The building
// types come from shared/world/api.ts (the same as the local server's). Phase 3: POST /api/world/join ("Back to the
// world") and `meta.world.scene` (the World button); the scene talks to the local server through net/world-stream.ts.
// Phase 5 (light social features): likes of the day, knocks on the door and the "While you were away" on the building,
// the blocked ones in the status, "Let me know when someone knocks" (`knocks`) in the visibility and
// POST /api/world/summary/seen and /unblock. Phase 6: delete the account (POST /api/world/delete-account and
// /confirm), download the data (GET /api/world/export), the inactivity notice in the visibility, the account id in the
// status and the building's "unverified" badge.
import type { AppearanceParts } from '../../../shared/appearance';
import type { Locale } from '../../../shared/i18n';
import type { OfficeSnapshot } from '../../../shared/types';
import {
  isWorldThemeChoice,
  WORLD_KNOWN_ERROR_CODES,
  WORLD_THEME_CHOICES,
  type WorldBlockedPlayer,
  type WorldBuildingMeta,
  type WorldBuildingStatus,
  type WorldBuildingStop,
  type WorldKnownErrorCode,
  type WorldLastUplink,
  type WorldThemeChoice,
  type WorldUplinkAck,
} from '../../../shared/world/api';
import type { TraitId } from '../../../shared/world/traits';
import type { IntroId } from '../../../shared/world/intro';
import { parsePlayerName, playerNameKey } from '../../../shared/world/names-rules';
import { GOODBYE_REASONS, UPLINK_ACK_ERRORS, type AwaySummary, type UplinkAckError, type WorldUplink } from '../../../shared/world/protocol';
import { parseAwaySummary, summaryHasNews } from '../../../shared/world/scene';
import { seasonalThemeFor } from '../world/api';
import { emailLooksValid, passwordProblem, traitsValid, DEFAULT_VISIBILITY } from '../ui/world/world-model';

export type WorldServerState = 'off' | 'logged_out' | 'waiting' | 'approved';
export type WorldAccess = 'waiting' | 'approved';

// The building types are the local server's (shared/world/api.ts); the interface imports them from here.
export { WORLD_THEME_CHOICES };
export type { WorldBlockedPlayer, WorldBuildingMeta, WorldBuildingStatus, WorldBuildingStop, WorldLastUplink, WorldThemeChoice, WorldUplinkAck } from '../../../shared/world/api';

/** OfficeSnapshot.meta.world: what the interface needs to decide whether World shows up (and the building, in Phase 2). */
export type WorldMeta = NonNullable<OfficeSnapshot['meta']['world']>;

export interface WorldVisibility {
  mode: 'live' | 'discreet';
  closed: boolean;
  hideCountry: boolean;
  tokensVisible: boolean;
  leaderboard: boolean;
  compactions: boolean;
  /** Email notice before removing the building for inactivity; absent = the account default (on). */
  notifyInactivity?: boolean;
  /** Notify when someone knocks on the building's door (Phase 5, opt-in). */
  knocks: boolean;
}

export interface WorldPlayer {
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro: IntroId;
  /** ISO-2 seen by the server on the last connection; absent if hidden or unknown. */
  country?: string;
  visibility: WorldVisibility;
  updatedAt?: number | string;
  /** Moderation changed the name by force (the name comes as "???"): a new one is still to be chosen, with no 30-day wait. */
  mustRename?: true;
}

export interface WorldDevice {
  id: string;
  /** "Device N" (the server never uses the computer's name). */
  label: string;
  createdAt?: number | string;
  lastSeenAt?: number | string;
  current: boolean;
}

/** GET /api/world/status. */
export interface WorldStatus {
  available: boolean;
  configured: boolean;
  state: WorldServerState;
  /**
   * `id`: the account id in the world, when the local server already knows it (it goes in the subject of the email appeal).
   * `reservedName`: the player name chosen at sign-up, reserved while the character does not exist.
   */
  account?: { emailMasked: string; access: WorldAccess; id?: string; reservedName?: string };
  player?: WorldPlayer;
  devices?: WorldDevice[];
  /** Last error of the connection to the world (code), if any. */
  lastError?: string;
  /** The building (approved account): connection, pause, counts, the reply to the last upload and why it stopped. */
  building?: WorldBuildingStatus;
  /** Theme saved for the building (PUT /api/world/theme); absent = 'auto'. */
  theme?: WorldThemeChoice;
  /** Who the account blocked (Phase 5): Settings › Habblaud World › Blocked. */
  blocked?: WorldBlockedPlayer[];
}

export interface WorldCharacterInput {
  /** Absent on create with the name reserved at sign-up (the server uses the reservation); on edit, keeps the name. */
  name?: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro: IntroId;
}

/**
 * Codes the interface translates: those of the world server and of the local server (shared/world/), plus two of
 * its own: `offline` (the local Habblaud did not respond) and `forbidden` (403 with no code: the origin guard
 * refused the page).
 */
export const WORLD_UI_ERROR_CODES = [...WORLD_KNOWN_ERROR_CODES, 'offline', 'forbidden'] as const;
export type WorldErrorCode = WorldKnownErrorCode | 'offline' | 'forbidden';

export type WorldResult<T = null> = { ok: true; data: T } | { ok: false; code: WorldErrorCode; status: number };

export interface WorldClient {
  /** `refresh`: the local server rereads /v1/me before responding (the blocked list, for example). */
  status(refresh?: boolean): Promise<WorldResult<WorldStatus>>;
  /** `name`: the player name, reserved on the waitlist (422 name_invalid | name_blocked, 409 name_taken). */
  register(body: { email: string; password: string; name: string; locale: Locale }): Promise<WorldResult>;
  verify(body: { email: string; code: string }): Promise<WorldResult>;
  login(body: { email: string; password: string }): Promise<WorldResult>;
  logout(): Promise<WorldResult>;
  resend(body: { email: string }): Promise<WorldResult>;
  forgotPassword(body: { email: string }): Promise<WorldResult>;
  resetPassword(body: { email: string; code: string; password: string }): Promise<WorldResult>;
  saveCharacter(body: WorldCharacterInput): Promise<WorldResult>;
  saveVisibility(body: WorldVisibility): Promise<WorldResult>;
  devices(): Promise<WorldResult<WorldDevice[]>>;
  revokeDevice(id: string): Promise<WorldResult>;
  /** The last upload; `null` = nothing has left this computer yet. */
  lastUplink(): Promise<WorldResult<WorldLastUplink | null>>;
  /** Stops sending now (before the reply; the connection stays only for the open World scene): the building goes off. */
  pause(): Promise<WorldResult<{ paused: boolean }>>;
  /** Sends again: the building lights up again. */
  resume(): Promise<WorldResult<{ paused: boolean }>>;
  /** "Back to the world" after leaving: the world server accepts the return; the new building is born in another lot. */
  join(): Promise<WorldResult>;
  /** "Leave the world": the local server stops sending and the world server removes the building before the reply. */
  leave(): Promise<WorldResult>;
  /** The theme chosen in Appearance also applies to the building. */
  setTheme(theme: WorldThemeChoice): Promise<WorldResult>;
  /** "Delete account", first step: the confirmation code goes to the account's email. */
  requestAccountDeletion(): Promise<WorldResult>;
  /** "Delete account" with the code: the account leaves the world and this computer signs out of the account. */
  confirmAccountDeletion(body: { code: string }): Promise<WorldResult>;
  /** "Download my data": the account's JSON, already formatted for saving (once a day). */
  exportData(): Promise<WorldResult<string>>;
  /** The owner saw the "While you were away" (Phase 5). */
  summarySeen(): Promise<WorldResult>;
  /** Unblocks a player (Phase 5; needs the connection to the world). */
  unblock(playerId: string): Promise<WorldResult>;
}

// ------------------------------------------------------------------ defensive reading

const STATES: readonly WorldServerState[] = ['off', 'logged_out', 'waiting', 'approved'];

/** `meta.world` of the snapshot, checked (old server or malformed body: undefined = nothing of World). */
export function readWorldMeta(snap: OfficeSnapshot | null | undefined): WorldMeta | undefined {
  const w = snap?.meta.world as Partial<WorldMeta> | undefined;
  if (!w || typeof w !== 'object' || typeof w.enabled !== 'boolean') return undefined;
  const state = STATES.includes(w.state as WorldServerState) ? (w.state as WorldServerState) : 'off';
  const out: WorldMeta = { enabled: w.enabled, configured: w.configured === true, state };
  const building = parseBuildingMeta(w.building);
  if (building) out.building = building;
  if (isObject(w.scene) && typeof w.scene.available === 'boolean') out.scene = { available: w.scene.available };
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function epochMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Known refusal reason; a code from a newer server version becomes `internal` (as on the local server). */
function ackError(v: unknown): UplinkAckError {
  return typeof v === 'string' && (UPLINK_ACK_ERRORS as readonly string[]).includes(v) ? (v as UplinkAckError) : 'internal';
}

/** `{ok, error?}` of the status's `lastAck`. */
function parseAckState(v: unknown): { ok: boolean; error?: UplinkAckError } | undefined {
  if (!isObject(v) || typeof v.ok !== 'boolean') return undefined;
  return v.ok ? { ok: true } : { ok: false, error: ackError(v.error) };
}

/** The last upload's `ack`: accepted (with the bytes the world counted) or refused; with no time, out of format. */
function parseUplinkAck(v: unknown): WorldUplinkAck | undefined {
  const state = parseAckState(v);
  const at = isObject(v) ? epochMs(v.at) : undefined;
  if (!state || !at) return undefined;
  const ack: WorldUplinkAck = { ...state, at };
  if (state.ok && isObject(v) && typeof v.bytes === 'number' && Number.isFinite(v.bytes) && v.bytes >= 0) ack.bytes = Math.floor(v.bytes);
  return ack;
}

/** Reasons the building stops (`deploy` only reconnects and never gets here). */
const STOPS = GOODBYE_REASONS.filter((r): r is WorldBuildingStop => r !== 'deploy');

/** `building` of meta.world, checked (malformed body: no building). The stop comes only as yes/no. */
export function parseBuildingMeta(v: unknown): WorldBuildingMeta | undefined {
  if (!isObject(v)) return undefined;
  const b: WorldBuildingMeta = { connected: v.connected === true, paused: v.paused === true, floors: count(v.floors), agents: count(v.agents) };
  const at = epochMs(v.lastUplinkAt);
  if (at) b.lastUplinkAt = at;
  if (v.left === true) b.left = true;
  if (v.stopped === true) b.stopped = true;
  if (typeof v.visitors === 'number' && Number.isInteger(v.visitors) && v.visitors >= 0) b.visitors = Math.min(v.visitors, 999);
  // Phase 5: the day's likes, knocks since Habblaud opened and whether there is an unseen summary.
  if (typeof v.likesToday === 'number' && Number.isInteger(v.likesToday) && v.likesToday >= 0) b.likesToday = v.likesToday;
  if (count(v.knocks) > 0) b.knocks = count(v.knocks);
  if (v.awaySummary === true) b.awaySummary = true;
  return b;
}

/** The status's `building`, checked (malformed body: no building): with the last upload's reply and the stop reason. */
export function parseBuilding(v: unknown): WorldBuildingStatus | undefined {
  const meta = parseBuildingMeta(v);
  if (!meta || !isObject(v)) return undefined;
  const { stopped: _stopped, ...b } = meta;
  const st: WorldBuildingStatus = b;
  const ack = parseAckState(v.lastAck);
  if (ack) st.lastAck = ack;
  if ((STOPS as readonly unknown[]).includes(v.stopped)) st.stopped = v.stopped as WorldBuildingStop;
  if (v.unverified === true) st.unverified = true;
  const summary = parseAwaySummary(v.summary);
  if (summary && summaryHasNews(summary)) st.summary = summary;
  if (typeof v.code === 'string' && /^HB-[2-9A-HJKMNP-TV-Z]{4}$/.test(v.code)) st.code = v.code;
  return st;
}

/** `blocked` of the status: `[{id, name}]` (whatever is malformed is left out). */
export function parseBlockedList(v: unknown): WorldBlockedPlayer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((p): p is WorldBlockedPlayer => isObject(p) && typeof p.id === 'string' && !!p.id && typeof p.name === 'string').map((p) => ({ id: p.id, name: p.name }));
}

/** The snapshot's building as the card uses it before the first status (a stop's reason only comes in the status). */
export function buildingFromMeta(m: WorldBuildingMeta | undefined): WorldBuildingStatus | undefined {
  if (!m) return undefined;
  const { stopped: _stopped, ...b } = m;
  return b;
}

/**
 * Body of GET /api/world/last-uplink: `{}` (nothing has left yet) becomes null; out of format, undefined. The `uplink`
 * passes through as it came: the screen shows exactly what the local server stored.
 */
export function parseLastUplink(v: unknown): WorldLastUplink | null | undefined {
  if (!isObject(v)) return undefined;
  if (v.at === undefined && v.uplink === undefined) return null;
  const at = epochMs(v.at);
  if (!at || typeof v.bytes !== 'number' || !Number.isFinite(v.bytes) || !isObject(v.uplink)) return undefined;
  const out: WorldLastUplink = { at, bytes: Math.max(0, Math.floor(v.bytes)), uplink: v.uplink as unknown as WorldUplink };
  const ack = parseUplinkAck(v.ack);
  if (ack) out.ack = ack;
  return out;
}

function parseDevices(v: unknown): WorldDevice[] | null {
  const list = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.devices) ? v.devices : null;
  if (!list) return null;
  return list.filter((d): d is WorldDevice => isObject(d) && typeof d.id === 'string' && typeof d.label === 'string').map((d) => ({ ...d, current: d.current === true }));
}

/** Body of GET /api/world/status, checked; null if it is not the contract's format. */
export function parseWorldStatus(v: unknown): WorldStatus | null {
  if (!isObject(v) || !STATES.includes(v.state as WorldServerState)) return null;
  const out: WorldStatus = { available: v.available !== false, configured: v.configured === true, state: v.state as WorldServerState };
  const acc = v.account;
  if (isObject(acc) && typeof acc.emailMasked === 'string') {
    out.account = { emailMasked: acc.emailMasked, access: acc.access === 'approved' ? 'approved' : 'waiting' };
    if (typeof acc.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(acc.id)) out.account.id = acc.id;
    if (typeof acc.reservedName === 'string' && acc.reservedName && acc.reservedName.length <= 64) out.account.reservedName = acc.reservedName;
  }
  const p = v.player;
  if (isObject(p) && typeof p.name === 'string' && isObject(p.parts) && Array.isArray(p.traits)) {
    out.player = {
      ...(p as unknown as WorldPlayer),
      look: p.look === 'm' ? 'm' : 'f',
      visibility: { ...DEFAULT_VISIBILITY, ...(isObject(p.visibility) ? (p.visibility as Partial<WorldVisibility>) : {}) },
    };
    if (p.mustRename !== true) delete out.player.mustRename;
  }
  const devices = v.devices === undefined ? null : parseDevices(v.devices);
  if (devices) out.devices = devices;
  if (typeof v.lastError === 'string' && v.lastError) out.lastError = v.lastError;
  const building = parseBuilding(v.building);
  if (building) out.building = building;
  if (isWorldThemeChoice(v.theme)) out.theme = v.theme;
  const blocked = parseBlockedList(v.blocked);
  if (blocked) out.blocked = blocked;
  return out;
}

/** Error code: `{error: {code}}` from the contract; otherwise by the HTTP status (guard, route turned off...). */
export function worldErrorCode(status: number, body: unknown): WorldErrorCode {
  const err = isObject(body) ? body.error : undefined;
  const code = isObject(err) ? err.code : undefined;
  if (typeof code === 'string' && (WORLD_UI_ERROR_CODES as readonly string[]).includes(code)) return code as WorldErrorCode;
  if (status === 404) return 'not_configured';
  if (status === 429) return 'rate_limited';
  if (status === 403) return 'forbidden';
  return 'unknown';
}

// ------------------------------------------------------------------ HTTP client

/** Timeout per request: sign-up solves the anti-bot challenge and computes the password hash before responding. */
export const WORLD_TIMEOUT_MS = 45_000;

export class HttpWorldApi implements WorldClient {
  constructor(
    // Arrow: the browser's fetch refuses to be called as a method of another object ("Illegal invocation").
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly base = '/api/world',
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: object): Promise<WorldResult<T>> {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(WORLD_TIMEOUT_MS) };
    // The server's guard only accepts POST/PUT with a JSON body (even an empty one).
    if (method !== 'GET') Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, init);
    } catch {
      return { ok: false, code: 'offline', status: 0 };
    }
    let data: unknown = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, code: worldErrorCode(res.status, data), status: res.status };
  }

  private async done(p: Promise<WorldResult<unknown>>): Promise<WorldResult> {
    const r = await p;
    return r.ok ? { ok: true, data: null } : r;
  }

  async status(refresh = false): Promise<WorldResult<WorldStatus>> {
    const r = await this.call<unknown>('GET', refresh ? '/status?refresh=1' : '/status');
    if (!r.ok) return r;
    const s = parseWorldStatus(r.data);
    return s ? { ok: true, data: s } : { ok: false, code: 'unknown', status: 200 };
  }

  register(body: { email: string; password: string; name: string; locale: Locale }) {
    return this.done(this.call('POST', '/register', body));
  }
  verify(body: { email: string; code: string }) {
    return this.done(this.call('POST', '/verify', body));
  }
  login(body: { email: string; password: string }) {
    return this.done(this.call('POST', '/login', body));
  }
  logout() {
    return this.done(this.call('POST', '/logout'));
  }
  resend(body: { email: string }) {
    return this.done(this.call('POST', '/resend', body));
  }
  forgotPassword(body: { email: string }) {
    return this.done(this.call('POST', '/password/forgot', body));
  }
  resetPassword(body: { email: string; code: string; password: string }) {
    return this.done(this.call('POST', '/password/reset', body));
  }
  saveCharacter(body: WorldCharacterInput) {
    return this.done(this.call('PUT', '/character', body));
  }
  saveVisibility(body: WorldVisibility) {
    return this.done(this.call('PUT', '/visibility', body));
  }
  async devices(): Promise<WorldResult<WorldDevice[]>> {
    const r = await this.call<unknown>('GET', '/devices');
    if (!r.ok) return r;
    const list = parseDevices(r.data);
    return list ? { ok: true, data: list } : { ok: false, code: 'unknown', status: 200 };
  }
  revokeDevice(id: string) {
    return this.done(this.call('POST', `/devices/${encodeURIComponent(id)}/revoke`));
  }
  async lastUplink(): Promise<WorldResult<WorldLastUplink | null>> {
    const r = await this.call<unknown>('GET', '/last-uplink');
    if (!r.ok) return r;
    const last = parseLastUplink(r.data);
    return last === undefined ? { ok: false, code: 'unknown', status: 200 } : { ok: true, data: last };
  }
  pause() {
    return this.paused('/pause', true);
  }
  resume() {
    return this.paused('/resume', false);
  }
  leave() {
    return this.done(this.call('POST', '/leave'));
  }
  join() {
    return this.done(this.call('POST', '/join'));
  }
  setTheme(theme: WorldThemeChoice) {
    return this.done(this.call('PUT', '/theme', { theme }));
  }
  requestAccountDeletion() {
    return this.done(this.call('POST', '/delete-account'));
  }
  confirmAccountDeletion(body: { code: string }) {
    return this.done(this.call('POST', '/delete-account/confirm', body));
  }
  async exportData(): Promise<WorldResult<string>> {
    const r = await this.call<unknown>('GET', '/export');
    if (!r.ok) return r;
    return isObject(r.data) ? { ok: true, data: `${JSON.stringify(r.data, null, 2)}\n` } : { ok: false, code: 'unknown', status: 200 };
  }
  summarySeen() {
    return this.done(this.call('POST', '/summary/seen'));
  }
  unblock(playerId: string) {
    return this.done(this.call('POST', '/unblock', { playerId }));
  }

  /** POST /pause and /resume → WorldStatus; its `building.paused` is what counts (without the field: what was asked). */
  private async paused(path: string, expected: boolean): Promise<WorldResult<{ paused: boolean }>> {
    const r = await this.call<unknown>('POST', path);
    if (!r.ok) return r;
    const b = isObject(r.data) ? r.data.building : undefined;
    return { ok: true, data: { paused: isObject(b) && typeof b.paused === 'boolean' ? b.paused : expected } };
  }
}

// ------------------------------------------------------------------ fake server (demo and tests)

export interface FakeWorldOptions {
  /** Initial state: no server ('off': nothing of World shows), no account, or a sample account already signed in (waiting or approved). */
  state?: WorldServerState;
  /** Wait for each response, in ms (default 450; 0 in tests). */
  delayMs?: number;
  now?: () => number;
}

interface FakeBuilding {
  connected: boolean;
  paused: boolean;
  /** Left the world (stays paused until resuming, which brings a "new" building). */
  left?: true;
  /** The "world" stopped the building (goodbye), until resuming. */
  stopped?: WorldBuildingStop;
  /** The "world" marked the building as "unverified". */
  unverified?: true;
  last: WorldLastUplink | null;
  /** When it lit up (the fake visits start a few seconds later; the day's likes go up 1 per minute). */
  since: number;
  /** Visitors now, fixed by `setVisitors` (without that: the visit demo, by the clock). */
  visitors?: number;
  /** Light social (Phase 5): the code, the summary until it is seen and the blocked players (made-up names). */
  code: string;
  summary?: AwaySummary;
  blocked: WorldBlockedPlayer[];
  /** When "Let me know when someone knocks" was turned on (the 1st knock arrives 8 s later, and another every 45 s). */
  knocksOn?: number;
}

/** Fake visits in the demo building: nobody in the first seconds, then 1 and, a little later, 2. */
export function fakeVisitorsAt(ms: number): number {
  return ms < 8_000 ? 0 : ms < 20_000 ? 1 : 2;
}

/** The fake's "While you were away": visits, likes and stamps, without who. */
export const FAKE_SUMMARY: Readonly<AwaySummary> = {
  since: '2026-10-14',
  visits: 5,
  likes: 12,
  stamps: [
    { stampId: 'visited', count: 2 },
    { stampId: 'coffee', count: 1 },
    { stampId: 'rocket', count: 1 },
  ],
};

/** The fake's blocked players (made-up names). */
const FAKE_BLOCKED: readonly WorldBlockedPlayer[] = [
  { id: 'p_spam', name: 'Spam Bot 3000' },
  { id: 'p_troll', name: 'Corner Troll' },
];

interface FakeAccount {
  email: string;
  password: string;
  verified: boolean;
  access: WorldAccess;
  player?: WorldPlayer;
  /** The player name from sign-up, reserved until the character exists. */
  reservedName?: string;
  devices: WorldDevice[];
  /** The building: it is born with the account approved and with a character. */
  building?: FakeBuilding;
  /** "Delete account" requested (the code is FAKE_CODE). */
  deleteRequested?: boolean;
  /** Data exports (the second gets 429, like the real one, one per day). */
  exports?: number;
}

/**
 * What the fake's building "sends": the example from section 3.3 of the plan (docs/world/privacidade.md), with the
 * complete parts in the three agents (the plan abbreviates two with "..."). The theme is swapped for the theme in
 * effect on each upload.
 */
export const FAKE_UPLINK: Readonly<WorldUplink> = {
  v: 1,
  version: '1.0.0',
  theme: 'halloween',
  floors: [
    {
      id: 'f_8c1e5f7a2b',
      agents: [
        {
          id: 'a_3f9d2c7e', kind: 'main', provider: 'claude', status: 'working', look: 'f', name: 'Marina',
          parts: {
            skin: '#e8b48c', hair: '#2b1d14', hairStyle: 'bob', eyes: '#3b5a7a', top: '#4a6fa5', topStyle: 'hoodie',
            bottom: '#2f3542', bottomStyle: 'pants', shoes: '#ffffff', accessory: 'glasses', accessoryColor: '#222222', facialHair: 'none',
          },
        },
        {
          id: 'a_71c0b5a9', kind: 'sub', parentId: 'a_3f9d2c7e', provider: 'claude', status: 'working', look: 'm', name: 'Caio',
          parts: {
            skin: '#c68642', hair: '#1c1c1c', hairStyle: 'short', eyes: '#4a3728', top: '#3d8b5f', topStyle: 'tshirt',
            bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#3a2a20', accessory: 'headphones', accessoryColor: '#1f1f24', facialHair: 'stubble',
          },
        },
      ],
    },
    {
      id: 'f_02aa91c4de',
      agents: [
        {
          id: 'a_b2e74d10', kind: 'main', provider: 'codex', status: 'idle', look: 'm', name: 'Rafael',
          parts: {
            skin: '#8d5524', hair: '#0f0f0f', hairStyle: 'buzz', eyes: '#2b1d14', top: '#a5463d', topStyle: 'polo',
            bottom: '#4b5563', bottomStyle: 'shorts', shoes: '#f2f2f2', accessory: 'none', accessoryColor: '#222222', facialHair: 'beard',
          },
        },
      ],
    },
  ],
};

/** Size of a packet as it goes on the wire (compact JSON in UTF-8). */
export function uplinkBytes(uplink: WorldUplink): number {
  return new TextEncoder().encode(JSON.stringify(uplink)).length;
}

/** Email of the sample account for the 'waiting' and 'approved' states. */
export const FAKE_EMAIL = 'you@example.com';
/** Password of the sample account. */
export const FAKE_PASSWORD = 'a really long password';
/** The code that the FakeWorldApi "email" sends (the screen shows it in demo mode). */
export const FAKE_CODE = '123456';

/** Names the fake says are already in use (to see the error in the demo). */
const FAKE_TAKEN = ['marina', 'caio', 'rafael'];

function maskEmail(email: string): string {
  const [user, domain = ''] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

/**
 * Fake World server, all in memory: sign-up with the code FAKE_CODE, waitlist, character,
 * visibility and devices. `failNext` simulates an error on the next call; `approve` approves the current account.
 */
export class FakeWorldApi implements WorldClient {
  private readonly accounts = new Map<string, FakeAccount>();
  private session: { email: string; deviceId: string } | null = null;
  private configured: boolean;
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly failures: WorldErrorCode[] = [];
  private readonly listeners = new Set<() => void>();
  private resends: number[] = [];
  private deviceSeq = 0;
  /** Building theme (world.json on the real server). */
  private theme: WorldThemeChoice = 'auto';
  /** Code with which the "world" refuses the uploads (null: accepts). */
  private rejectCode: UplinkAckError | null = null;
  /** The status's lastError (the deleted account leaves `account_deleted` until signing in again). */
  private lastError: WorldErrorCode | null = null;

  constructor(opts: FakeWorldOptions = {}) {
    this.delayMs = opts.delayMs ?? 450;
    this.now = opts.now ?? Date.now;
    const state = opts.state ?? 'logged_out';
    this.configured = state !== 'off';
    if (state === 'waiting' || state === 'approved') {
      const now = this.now();
      const acc: FakeAccount = { email: FAKE_EMAIL, password: FAKE_PASSWORD, verified: true, access: state, devices: [], reservedName: 'Pixel Dev' };
      if (state === 'approved') {
        delete acc.reservedName;
        acc.player = {
          name: 'Pixel Dev',
          look: 'f',
          parts: {
            skin: '#d69f78', hair: '#2b2530', hairStyle: 'bob', eyes: '#2f5f9e', top: '#4a86d8', topAccent: '#f4f4f0',
            topStyle: 'hoodie', bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#ececec', accessory: 'glasses',
            accessoryColor: '#2b2b33', facialHair: 'none',
          },
          traits: ['cafeina', 'games'],
          intro: 'night_owl',
          country: 'BR',
          visibility: { ...DEFAULT_VISIBILITY },
          updatedAt: now,
        };
        this.ensureBuilding(acc);
      }
      this.accounts.set(FAKE_EMAIL, acc);
      const current = this.addDevice(acc);
      acc.devices.unshift({ id: 'fake-old', label: 'Dispositivo 2', createdAt: now - 21 * 86_400_000, lastSeenAt: now - 3 * 86_400_000, current: false });
      this.session = { email: FAKE_EMAIL, deviceId: current.id };
    }
  }

  /** What the snapshot would say in `meta.world` (no server, like the real one: turned off, nothing shows). */
  meta(): WorldMeta {
    const meta: WorldMeta = { enabled: this.configured, configured: this.configured, state: this.state() };
    const b = this.buildingOf(this.current());
    if (b) {
      // summary and code only in the status (local), like the real one: here, only whether there is an unseen summary
      const { lastAck: _ack, stopped, summary, code: _code, ...building } = b;
      meta.building = stopped ? { ...building, stopped: true } : building;
      if (summary) meta.building.awaySummary = true;
    }
    // The demo mode World scene (FakeWorldStream) exists with the account approved and the character created.
    if (b) meta.scene = { available: true };
    return meta;
  }

  /** Building theme in effect (the chosen one, before resolving the automatic one). */
  worldTheme(): WorldThemeChoice {
    return this.theme;
  }

  /** Visitors in the fake building (tests and screenshots); null goes back to the demo by the clock. */
  setVisitors(n: number | null): void {
    const b = this.current()?.building;
    if (!b) return;
    if (n === null) delete b.visitors;
    else b.visitors = Math.max(0, Math.floor(n));
    this.changed();
  }

  /** The "world" starts refusing the uploads with this code (null: accepts again); sends an upload right away. */
  rejectUplinks(code: UplinkAckError | null): void {
    this.rejectCode = code;
    const acc = this.current();
    if (acc?.building?.connected) this.sendUplink(acc);
    this.changed();
  }

  /** The "world" stops the building with a `goodbye` (update, another computer...), until resuming. */
  stopBuilding(reason: WorldBuildingStop): void {
    const b = this.current()?.building;
    if (!b || b.paused) return;
    b.connected = false;
    b.stopped = reason;
    this.changed();
  }

  /** The "world" marks (or unmarks) the account's building as "unverified". */
  markUnverified(on: boolean): void {
    const b = this.current()?.building;
    if (!b) return;
    if (on) b.unverified = true;
    else delete b.unverified;
    this.changed();
  }

  /** The "world" enters (or leaves) maintenance: the status has `maintenance` and the building is cut off until it ends. */
  setMaintenance(on: boolean): void {
    const b = this.current()?.building;
    this.lastError = on ? 'maintenance' : null;
    if (b && !b.paused && !b.stopped) b.connected = !on;
    this.changed();
  }

  /** The connection to the world drops (the real server retries on its own; here, until pausing and resuming). */
  dropConnection(): void {
    const b = this.current()?.building;
    if (!b || b.paused) return;
    b.connected = false;
    this.changed();
  }

  /** Notifies when the state changes (the interface redraws, as it would with a new snapshot). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** The next call fails with this code (tests and demo). */
  failNext(code: WorldErrorCode): void {
    this.failures.push(code);
  }

  /** Moderation forcibly changes the character name of the signed-in account (becomes "???" until another is chosen). */
  forceRename(): void {
    const acc = this.current();
    if (!acc?.player) return;
    acc.player = { ...acc.player, name: '???', mustRename: true };
    this.changed();
  }

  /** Releases the signed-in account from the waitlist (the server panel would do this by batch). */
  approve(): void {
    const acc = this.current();
    if (!acc) return;
    acc.access = 'approved';
    this.ensureBuilding(acc);
    this.changed();
  }

  /** Lights the building of the approved account with a character, with the first upload (the real uplink does it). */
  private ensureBuilding(acc: FakeAccount): void {
    if (acc.building || acc.access !== 'approved' || !acc.player) return;
    acc.building = { connected: true, paused: false, last: null, code: 'HB-4F2K', summary: structuredClone(FAKE_SUMMARY), blocked: [...FAKE_BLOCKED], since: this.now() };
    this.sendUplink(acc);
  }

  /** One upload: the 3.3 example with the theme resolved by the date; the reply from the "world" comes right away. */
  private sendUplink(acc: FakeAccount): void {
    const b = acc.building;
    if (!b || b.paused) return;
    const at = this.now();
    const uplink: WorldUplink = { ...structuredClone(FAKE_UPLINK as WorldUplink), theme: seasonalThemeFor(this.theme, new Date(at)) };
    const bytes = uplinkBytes(uplink);
    const ack: WorldUplinkAck = this.rejectCode ? { ok: false, error: this.rejectCode, at } : { ok: true, at, bytes };
    b.last = { at, bytes, uplink, ack };
  }

  private buildingOf(acc: FakeAccount | undefined): WorldBuildingStatus | undefined {
    const b = acc?.building;
    if (!b) return undefined;
    const floors = b.last?.uplink.floors ?? [];
    const out: WorldBuildingStatus = { connected: b.connected, paused: b.paused, floors: floors.length, agents: floors.reduce((n, f) => n + f.agents.length, 0) };
    if (b.last) {
      out.lastUplinkAt = b.last.at;
      if (b.last.ack) out.lastAck = b.last.ack.ok ? { ok: true } : { ok: false, error: b.last.ack.error };
    }
    if (b.left) out.left = true;
    if (b.stopped) out.stopped = b.stopped;
    // visitors: only when lit and open to visits (closed, the world does not send even the 0)
    if (b.connected && !b.paused && !b.left && !acc?.player?.visibility.closed) out.visitors = b.visitors ?? fakeVisitorsAt(this.now() - b.since);
    if (b.unverified) out.unverified = true;
    // Phase 5: 3 likes today and one more per minute; knocks with "Let me know when someone knocks" turned on.
    const now = this.now();
    out.likesToday = 3 + Math.floor(Math.max(0, now - b.since) / 60_000);
    if (b.knocksOn !== undefined && acc.player?.visibility.knocks && b.connected) {
      const knocks = Math.floor((now - b.knocksOn - 8_000) / 45_000) + 1;
      if (knocks > 0) out.knocks = knocks;
    }
    if (b.summary) out.summary = structuredClone(b.summary);
    out.code = b.code;
    return out;
  }

  private state(): WorldServerState {
    if (!this.configured) return 'off';
    const acc = this.current();
    return acc ? acc.access : 'logged_out';
  }

  private current(): FakeAccount | undefined {
    return this.session ? this.accounts.get(this.session.email) : undefined;
  }

  private changed(): void {
    this.listeners.forEach((cb) => cb());
  }

  private addDevice(acc: FakeAccount): WorldDevice {
    const now = this.now();
    acc.devices.forEach((d) => (d.current = false));
    const used = new Set(acc.devices.map((d) => d.label));
    let n = 1;
    while (used.has(`Dispositivo ${n}`)) n++;
    const device: WorldDevice = { id: `fake-${++this.deviceSeq}`, label: `Dispositivo ${n}`, createdAt: now, lastSeenAt: now, current: true };
    acc.devices.push(device);
    return device;
  }

  /**
   * Responds after the wait; a pending `failNext` becomes this response's error. Only the writes (`write`) notify
   * listeners: a read that notified would make the interface reread the status nonstop.
   */
  private async reply<T>(run: () => WorldResult<T>, write = true): Promise<WorldResult<T>> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const fail = this.failures.shift();
    if (fail) return { ok: false, code: fail, status: fail === 'offline' ? 0 : 400 };
    if (!this.configured) return { ok: false, code: 'not_configured', status: 404 };
    const r = run();
    if (r.ok && write) this.changed();
    return r;
  }

  private static ok(): WorldResult {
    return { ok: true, data: null };
  }

  private static fail(code: WorldErrorCode, status = 400): WorldResult<never> {
    return { ok: false, code, status };
  }

  status(): Promise<WorldResult<WorldStatus>> {
    return this.reply(() => {
      const acc = this.current();
      const state = this.state();
      const status: WorldStatus = { available: true, configured: this.configured, state };
      if (acc) {
        status.account = { emailMasked: maskEmail(acc.email), access: acc.access };
        if (!acc.player && acc.reservedName) status.account.reservedName = acc.reservedName;
        if (acc.player) status.player = structuredClone(acc.player);
        status.devices = structuredClone(acc.devices);
        const building = this.buildingOf(acc);
        if (building) status.building = building;
        if (acc.building) status.blocked = structuredClone(acc.building.blocked);
      }
      if (this.theme !== 'auto') status.theme = this.theme;
      if (this.lastError) status.lastError = this.lastError;
      return { ok: true, data: status };
    }, false);
  }

  register(body: { email: string; password: string; name: string; locale: Locale }): Promise<WorldResult> {
    return this.reply(() => {
      // Like the real server: the name is checked before the password and stays reserved for the account.
      const name = parsePlayerName(body.name);
      if (!name.ok) return FakeWorldApi.fail(name.code, 422);
      if (this.nameTaken(name.key, undefined)) return FakeWorldApi.fail('name_taken', 409);
      if (!emailLooksValid(body.email) || passwordProblem(body.password, body.email)) return FakeWorldApi.fail('invalid', 422);
      const email = body.email.trim().toLowerCase();
      // An already registered email gets the same response (never reveals who has an account).
      if (!this.accounts.has(email)) this.accounts.set(email, { email, password: body.password, verified: false, access: 'waiting', devices: [], reservedName: name.name });
      return FakeWorldApi.ok();
    });
  }

  /** The name (by key) is already another account's: the fixed FAKE_TAKEN ones, a sign-up reservation or a character. */
  private nameTaken(key: string, self: FakeAccount | undefined): boolean {
    if (FAKE_TAKEN.includes(key)) return true;
    for (const o of this.accounts.values()) {
      if (o === self) continue;
      const other = o.player?.name ?? o.reservedName;
      if (other && playerNameKey(other) === key) return true;
    }
    return false;
  }

  verify(body: { email: string; code: string }): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.accounts.get(body.email.trim().toLowerCase());
      if (!acc || body.code !== FAKE_CODE) return FakeWorldApi.fail('invalid_code');
      acc.verified = true;
      this.session = { email: acc.email, deviceId: this.addDevice(acc).id };
      this.lastError = null;
      return FakeWorldApi.ok();
    });
  }

  login(body: { email: string; password: string }): Promise<WorldResult> {
    return this.reply(() => {
      const email = body.email.trim().toLowerCase();
      if (email.startsWith('banido@')) return FakeWorldApi.fail('banned', 403);
      const acc = this.accounts.get(email);
      if (!acc || acc.password !== body.password) return FakeWorldApi.fail('invalid_credentials', 401);
      if (!acc.verified) return FakeWorldApi.fail('email_not_verified', 403);
      this.session = { email, deviceId: this.addDevice(acc).id };
      this.lastError = null;
      return FakeWorldApi.ok();
    });
  }

  logout(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (acc && this.session) {
        const id = this.session.deviceId;
        acc.devices = acc.devices.filter((d) => d.id !== id);
      }
      this.session = null;
      return FakeWorldApi.ok();
    });
  }

  resend(_body: { email: string }): Promise<WorldResult> {
    return this.reply(() => {
      const now = this.now();
      this.resends = this.resends.filter((t) => now - t < 3_600_000);
      if (this.resends.length >= 3) return FakeWorldApi.fail('rate_limited', 429);
      this.resends.push(now);
      return FakeWorldApi.ok();
    });
  }

  forgotPassword(_body: { email: string }): Promise<WorldResult> {
    return this.reply(() => FakeWorldApi.ok());
  }

  resetPassword(body: { email: string; code: string; password: string }): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.accounts.get(body.email.trim().toLowerCase());
      if (!acc || body.code !== FAKE_CODE) return FakeWorldApi.fail('invalid_code');
      if (passwordProblem(body.password, body.email)) return FakeWorldApi.fail('invalid', 422);
      acc.password = body.password;
      acc.verified = true;
      // Changing the password disconnects all devices (this one too).
      acc.devices = [];
      if (this.session?.email === acc.email) this.session = null;
      return FakeWorldApi.ok();
    });
  }

  saveCharacter(body: WorldCharacterInput): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      // Creating with the sign-up reservation, the name IS the reservation; editing without `name`, keeps it.
      const raw = !acc.player && acc.reservedName ? acc.reservedName : body.name === undefined && acc.player ? acc.player.name : body.name;
      const name = parsePlayerName(raw);
      if (!name.ok) return FakeWorldApi.fail(name.code, 422);
      if (this.nameTaken(name.key, acc) && playerNameKey(acc.player?.name ?? '') !== name.key) return FakeWorldApi.fail('name_taken', 409);
      if (!traitsValid(body.traits)) return FakeWorldApi.fail('invalid', 422);
      delete acc.reservedName;
      acc.player = {
        name: name.name,
        look: body.look,
        parts: { ...body.parts },
        traits: [...body.traits],
        intro: body.intro,
        country: 'BR',
        visibility: acc.player?.visibility ?? { ...DEFAULT_VISIBILITY },
        updatedAt: this.now(),
      };
      this.ensureBuilding(acc);
      return FakeWorldApi.ok();
    });
  }

  saveVisibility(body: WorldVisibility): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc?.player) return FakeWorldApi.fail('invalid', 422);
      const was = acc.player.visibility.knocks;
      acc.player.visibility = { ...body };
      if (body.hideCountry) delete acc.player.country;
      else acc.player.country = 'BR';
      if (acc.building && body.knocks && !was) acc.building.knocksOn = this.now();
      return FakeWorldApi.ok();
    });
  }

  devices(): Promise<WorldResult<WorldDevice[]>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      return { ok: true, data: structuredClone(acc.devices) };
    }, false);
  }

  revokeDevice(id: string): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      if (!acc.devices.some((d) => d.id === id)) return FakeWorldApi.fail('invalid', 404);
      acc.devices = acc.devices.filter((d) => d.id !== id);
      if (this.session?.deviceId === id) this.session = null;
      return FakeWorldApi.ok();
    });
  }

  lastUplink(): Promise<WorldResult<WorldLastUplink | null>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      return { ok: true, data: acc.building?.last ? structuredClone(acc.building.last) : null };
    }, false);
  }

  pause(): Promise<WorldResult<{ paused: boolean }>> {
    return this.setPaused(true);
  }

  resume(): Promise<WorldResult<{ paused: boolean }>> {
    return this.setPaused(false);
  }

  private setPaused(paused: boolean): Promise<WorldResult<{ paused: boolean }>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      const b = acc.building;
      if (!b) return FakeWorldApi.fail('no_player', 409);
      b.paused = paused;
      // Like the real one: pausing turns the building off (the badge stops showing "in the world"); resuming (also after
      // leaving the world or after a stop) reconnects and sends the whole packet.
      b.connected = !paused;
      if (!paused) {
        delete b.left;
        delete b.stopped;
      }
      this.sendUplink(acc);
      return { ok: true, data: { paused } };
    });
  }

  /** "Back to the world": like resuming, but only makes sense after leaving (without having left, nothing changes). */
  join(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      const b = acc.building;
      if (!b) return FakeWorldApi.fail('no_player', 409);
      if (b.left) {
        delete b.left;
        delete b.stopped;
        b.paused = false;
        b.connected = true;
        this.sendUplink(acc);
      }
      return FakeWorldApi.ok();
    });
  }

  leave(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      const b = acc.building;
      if (!b) return FakeWorldApi.fail('no_player', 409);
      b.paused = true;
      b.connected = false;
      b.left = true;
      delete b.stopped;
      return FakeWorldApi.ok();
    });
  }

  setTheme(theme: WorldThemeChoice): Promise<WorldResult> {
    return this.reply(() => {
      if (!WORLD_THEME_CHOICES.includes(theme)) return FakeWorldApi.fail('invalid', 422);
      this.theme = theme;
      const acc = this.current();
      if (acc?.building?.connected) this.sendUplink(acc);
      return FakeWorldApi.ok();
    });
  }

  requestAccountDeletion(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      acc.deleteRequested = true;
      return FakeWorldApi.ok();
    }, false);
  }

  /** With the code: the account is gone (and the theme, like the deleted world.json); the status is `account_deleted`. */
  confirmAccountDeletion(body: { code: string }): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      if (!acc.deleteRequested || body.code !== FAKE_CODE) return FakeWorldApi.fail('invalid_code');
      this.accounts.delete(acc.email);
      this.session = null;
      this.theme = 'auto';
      this.lastError = 'account_deleted';
      return FakeWorldApi.ok();
    });
  }

  summarySeen(): Promise<WorldResult> {
    return this.reply(() => {
      const b = this.current()?.building;
      if (!b) return FakeWorldApi.fail('not_logged_in', 401);
      delete b.summary;
      return FakeWorldApi.ok();
    });
  }

  exportData(): Promise<WorldResult<string>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      acc.exports = (acc.exports ?? 0) + 1;
      if (acc.exports > 1) return FakeWorldApi.fail('rate_limited', 429);
      // The WorldExport format (protocol.ts), with fake data only.
      const data = {
        format: 'habblaud-world-export',
        version: 1,
        exportedAt: new Date(this.now()).toISOString(),
        account: { email: acc.email, access: acc.access, notifyInactivity: acc.player?.visibility.notifyInactivity !== false },
        player: acc.player ?? null,
        visibility: acc.player?.visibility ?? null,
        devices: acc.devices.map((d) => ({ label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, revokedAt: null })),
        building: acc.building ? { floors: acc.building.last?.uplink.floors.length ?? 0, likes: 0 } : null,
        likesGiven: [],
        blocks: [],
        reportsMade: [],
        stampsReceived: [],
      };
      return { ok: true, data: `${JSON.stringify(data, null, 2)}\n` };
    }, false);
  }

  /** Like the real one: `unblock` goes over the world connection (paused and without the city open, it cannot). */
  unblock(playerId: string): Promise<WorldResult> {
    return this.reply(() => {
      const b = this.current()?.building;
      if (!b) return FakeWorldApi.fail('not_logged_in', 401);
      if (!b.connected) return FakeWorldApi.fail('not_connected', 409);
      b.blocked = b.blocked.filter((p) => p.id !== playerId);
      return FakeWorldApi.ok();
    });
  }
}

// ------------------------------------------------------------------ where the data comes from

export interface WorldSource {
  /** null = nothing of World on this page. */
  readonly client: WorldClient | null;
  /** Demo mode: FakeWorldApi responds (no server, no access locks). */
  readonly fake: boolean;
  /** The `meta.world` in effect. */
  meta(): WorldMeta | undefined;
  /** Notifies when the state changes outside the snapshots (only the fake). */
  onChange?(cb: () => void): () => void;
}

/** `?world=` of demo mode: the initial state of FakeWorldApi (without the parameter, World does not show). */
export function fakeWorldStateFrom(search: string): WorldServerState | null {
  const params = new URLSearchParams(search);
  if (!params.has('world')) return null;
  const v = params.get('world') ?? '';
  return (STATES as readonly string[]).includes(v) ? (v as WorldServerState) : 'logged_out';
}

/**
 * This page's World: under ?mock=1, FakeWorldApi only with `&world=` (the README screenshots in demo mode
 * still have nothing of World, which is off by default); outside it, the local routes and the `meta.world` of
 * the live snapshot.
 */
export function worldSource(store: { mock: boolean; readonly liveSnapshot: OfficeSnapshot | null }, search = typeof location === 'undefined' ? '' : location.search): WorldSource {
  if (store.mock) {
    const state = fakeWorldStateFrom(search);
    if (!state) return { client: null, fake: true, meta: () => undefined };
    const fake = new FakeWorldApi({ state });
    return { client: fake, fake: true, meta: () => fake.meta(), onChange: (cb) => fake.onChange(cb) };
  }
  return { client: new HttpWorldApi(), fake: false, meta: () => readWorldMeta(store.liveSnapshot) };
}
