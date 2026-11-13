// Habblaud World local routes (/api/world/*, server/world/http.ts): what the Habblaud page asks the local server,
// which talks to the world server for it. Only on the local port, with a local Host (never through the phone port),
// and everything that acts for the account only with the terminal lock (local bind). The device token never gets here.
//
//   GET  /api/world/status[?refresh=1]       → WorldStatus
//   POST /api/world/register                 {email, password, name, locale?, invite?} → 202 {} (name: the player name,
//                                                reserved on the waitlist; 422 name_invalid | name_blocked, 409 name_taken)
//   POST /api/world/verify                   {email, code} → 200 WorldStatus (signs in: saves the token on this computer)
//   POST /api/world/login                    {email, password} → 200 WorldStatus
//   POST /api/world/logout                   {} → 200 WorldStatus (deletes the token from here and revokes it on the server)
//   POST /api/world/resend                   {email} → 202 {}
//   POST /api/world/password/forgot          {email} → 202 {}
//   POST /api/world/password/reset           {email, code, password} → 204
//   PUT  /api/world/character                PlayerInput → 200 Player (when creating with a name reserved at sign-up,
//                                                without `name`)
//   PUT  /api/world/visibility               Visibility → 200 Visibility
//   GET  /api/world/devices                  → {devices: DeviceInfo[]}
//   POST /api/world/devices/:id/revoke       {} → 204 (this device itself: signs out here too)
//   PUT  /api/world/theme                    {theme: WorldThemeChoice} → 200 {theme} (with or without an account:
//                                                kept in world.json)
//   POST /api/world/pause                    {} → 200 WorldStatus (stops sending the packet before responding; the
//                                                connection closes, or stays only for the open World scene, without
//                                                `uplink`; notifies POST /v1/me/building/pause, documented in protocol.ts)
//   POST /api/world/resume                   {} → 200 WorldStatus (notifies POST /v1/me/building/resume and reopens the
//                                                uplink; with no response from the world server, tries again with a
//                                                growing wait)
//   POST /api/world/leave                    {} → 200 WorldStatus ("Leave the world": stops sending like the pause,
//                                                calls DELETE /v1/me/building and only then responds; the account and
//                                                the character stay)
//   POST /api/world/join                     {} → 200 WorldStatus ("Back to the world": POST /v1/me/building/join and,
//                                                with the response, clears the leave and the pause and reopens the
//                                                uplink; the next packet creates a new building, on another lot; without
//                                                having left, it is the resume)
//   GET  /api/world/last-uplink              → WorldLastUplink | {} (what was sent last, exact)
//
// The account and the data (Phase 6):
//   POST /api/world/delete-account           {} → 202 {} ("Delete account": POST /v1/me/delete sends the code to the email)
//   POST /api/world/delete-account/confirm   {code} → 200 WorldStatus (POST /v1/me/delete/confirm; with a good response,
//                                                closes the building connection and deletes the whole world.json: the
//                                                session disappears from here and the status comes back with no account,
//                                                with lastError `account_deleted`)
//   GET  /api/world/export                   → 200 WorldExport (the account JSON as it came from GET /v1/me/export),
//                                                attachment (habblaud-world-dados.json); once a day (429 rate_limited);
//                                                only from the page itself, like the stream (uses up the day's quota)
//   PUT  /api/world/visibility               also accepts `notifyInactivity` (optional): the email notice before
//                                                removing the building for inactivity
// Light social (Phase 5; server/world/social.ts), over the building connection, with the World scene open or not:
//   POST /api/world/summary/seen             {} → 204 (sends ↑ `summary.seen`: the owner saw "While you were away";
//                                                409 not_connected without the connection to the world)
//   POST /api/world/unblock                  {playerId} → 204 (sends ↑ `unblock`; removes from the blocked list here
//                                                right away and rereads /v1/me; 409 not_connected without the connection)
// The building code ("Go to HB-XXXX") goes straight in the scene's ↑ `teleport {code}`: the protocol's route
// GET /v1/buildings/:code (BuildingCodeResponse) is not used by the page.
//
// The World scene (Phase 3; server/world/viewer.ts), with the same locks and without the phone port:
//   GET  /api/world/stream                   → text/event-stream: `world.snapshot` (WorldSceneSnapshot) on connect and
//                                                on every restart (connection to the world open or dropped, `view`
//                                                again), `world` (WorldSceneMessage) with each city message as it
//                                                came, already in order and with no `rev` jump, and `: ping` every 15 s.
//                                                At most 4 open (429 too_many_streams). Opening the first sends
//                                                `view` to the world server; closing the last, `view.off`
//   POST /api/world/cmd                      {stream, cmds: WorldSceneCommand[]} → 202 {sent} (up to 5 batches/s per
//                                                stream, 20 commands per batch; of each batch, only the last `move` goes)
//
// Errors: {error: {code, message?, retryAfter?}} with the world server's status when they come from there (codes in
// WORLD_ERROR_CODES of the protocol; a new code passes as it came) or with the local codes below. The interface
// translates by `code`; `message` is only for whoever reads the log or uses curl.
import {
  WORLD_ERROR_CODES,
  type AfkMessage,
  type AppearanceParts,
  type AreaMessage,
  type AreaPatchMessage,
  type AwaySummary,
  type AwaySummaryMessage,
  type CityFireworksMessage,
  type CityStatusMessage,
  type KnockedMessage,
  type KnockMessage,
  type LikesTodayMessage,
  type StampMessage,
  type SummarySeenMessage,
  type TeleportMessage,
  type BlockMessage,
  type BuildingMessage,
  type BuildingPatchMessage,
  type DeviceInfo,
  type EnterMessage,
  type GoodbyeReason,
  type GreetingMessage,
  type GreetMessage,
  type IntroId,
  type LeaveMessage,
  type LikeMessage,
  type LikeUpdateMessage,
  type MinimapMessage,
  type MoveMessage,
  type NoticeMessage,
  type Player,
  type PlayerJoinMessage,
  type PlayerLeaveMessage,
  type PlayersMessage,
  type PosMessage,
  type ProfileMessage,
  type ProfileRequestMessage,
  type ReportMessage,
  type ResyncMessage,
  type TraitId,
  type ViewMessage,
  type ViewOffMessage,
  type VisitorsMessage,
  type WorldBuildingDetail,
  type WorldAccess,
  type WorldBuildingPublic,
  type WorldErrorCode,
  type UplinkAckError,
  type WorldPlayerPublic,
  type WorldPosition,
  type WorldTheme,
  type WorldUplink,
} from './protocol';

/**
 * Theme chosen in Settings › Appearance, kept in world.json (PUT /api/world/theme). The packet carries the theme already
 * resolved: the automatic one becomes the calendar theme (server/world/theme.ts).
 */
export const WORLD_THEME_CHOICES = ['auto', 'none', 'halloween', 'christmas'] as const;
export type WorldThemeChoice = 'auto' | WorldTheme;

export function isWorldThemeChoice(v: unknown): v is WorldThemeChoice {
  return typeof v === 'string' && (WORLD_THEME_CHOICES as readonly string[]).includes(v);
}

/** State of the account on this computer. */
export type WorldState = 'off' | 'logged_out' | 'waiting' | 'approved';

/** Why the building stopped uploading: the reason of the world server's `goodbye` (`deploy` only reconnects). */
export type WorldBuildingStop = Exclude<GoodbyeReason, 'deploy'>;

/**
 * The world server's response to the upload (`uplink.ack`): accepted (`at` and `bytes` counted by it) or refused with
 * the reason (`error`, only the codes of UPLINK_ACK_ERRORS; a code this version does not know becomes `internal`; `at`
 * is the time the refusal got here).
 */
export interface WorldUplinkAck {
  ok: boolean;
  error?: UplinkAckError;
  /** Time (ms). */
  at: number;
  bytes?: number;
}

/**
 * This computer's building in the world: GET /api/world/status → `building`, only with the account approved and the
 * character created. `floors` and `agents` are those of the last upload (before it, those the server sent in the
 * `welcome`; 0 with nothing).
 */
export interface WorldBuildingStatus {
  /**
   * WebSocket open and accepted (`welcome`) and the building uploading. Paused or out of the world it is always false:
   * the connection the World scene opens to walk around the city does not carry the building.
   */
  connected: boolean;
  /** Paused by the owner (POST /api/world/pause). */
  paused: boolean;
  floors: number;
  agents: number;
  /** Last upload (ms). */
  lastUplinkAt?: number;
  /** Response to the last upload (absent until it arrives). */
  lastAck?: { ok: boolean; error?: UplinkAckError };
  /**
   * The world server closed the connection and the building stopped: `banned`/`suspended` (account), `update` (old
   * version: update), `other-device` (the account connected somewhere else; comes back with "Resume" or on reopening
   * Habblaud), `waiting`, `no_player`, `unauthorized` (the account changed on the other side; the state here is updated).
   */
  stopped?: WorldBuildingStop;
  /**
* Left the world (POST /api/world/leave): the building was removed and no packet goes out until the join (new building,
* new lot).
*/
  left?: true;
  /** Visitors inside the building now (see WorldBuildingMeta.visitors). */
  visitors?: number;
  /**
   * The world marked the building as "unverified" (WorldBuildingPublic.unverified, from the `welcome` or the city): the
   * data looked implausible and is under review; the building stays out of leaderboards and highlights. It can be disputed.
   */
  unverified?: true;
  /** Likes received today (see WorldBuildingMeta.likesToday). */
  likesToday?: number;
  /** Knocks on the door since this Habblaud opened (see WorldBuildingMeta.knocks). */
  knocks?: number;
  /** "While you were away" not seen yet (↓ `away.summary` or /v1/me): visits, likes and stamps, without who. */
  summary?: AwaySummary;
  /** The building code ("HB-4F2K", from /v1/me), to send to a friend. */
  code?: string;
}

/**
* OfficeSnapshot.meta.world.building: the building summary (without the account), for the interface to show without
* asking for the status.
*/
export interface WorldBuildingMeta {
  connected: boolean;
  paused: boolean;
  floors: number;
  agents: number;
  lastUplinkAt?: number;
  /** Left the world (see WorldBuildingStatus.left). */
  left?: true;
  /**
* The world server stopped the building (`goodbye`); the reason goes only in the status, which does not reach the phone.
*/
  stopped?: true;
  /**
   * Visitors inside the building now (↓ `visitors {count}` on the building connection, Phase 4): absent before the first
   * count, without a connection and with the building closed to visits (closed, the server does not send even the 0).
   */
  visitors?: number;
  /** Likes received today (↓ `likes.today` or /v1/me; Phase 5): the "❤️ 3 today" chip in the bar. */
  likesToday?: number;
  /**
   * Knocks on the door since this Habblaud opened (↓ `knock {}`, no name; only with `knocks` on in the visibility):
   * the page shows the notice when the number goes up.
   */
  knocks?: number;
  /**
* There is a "While you were away" not seen yet (the summary itself goes only in the status, which does not reach the
* phone).
*/
  awaySummary?: true;
}

/** GET /api/world/last-uplink ("See what was sent"): the exact packet of the last upload, the bytes and the response. */
export interface WorldLastUplink {
  at: number;
  /** Bytes of the packet JSON (UTF-8), as the world server measures them. */
  bytes: number;
  uplink: WorldUplink;
  ack?: WorldUplinkAck;
}

/**
 * OfficeSnapshot.meta.world: only what the interface needs to decide whether to show the section (the snapshot also
 * goes to the phone and to the timeline: nothing of the account here).
 */
export interface WorldMeta {
  /**
   * The section shows: HABBLAUD_WORLD is not 0 and the world server was accepted (the default, server.habblaud.com, or a
   * valid HABBLAUD_WORLD_URL). With the URL refused the feature is off and nothing of World shows in the interface.
   */
  enabled: boolean;
  /** World server accepted (the default or a valid HABBLAUD_WORLD_URL). */
  configured: boolean;
  state: WorldState;
  /** The building in the world (only with the account approved and the character created). */
  building?: WorldBuildingMeta;
  /**
   * The World scene (Phase 3), only with World configured, the account approved and the character created; `available`
   * also asks for the terminal lock (the scene routes require it) and no stop for a ban, suspension, refused version or
   * another computer (the connection does not come back on its own). Paused or out of the world, it still holds (you walk
   * with the building off). The bar shows the World button with `available`.
   */
  scene?: WorldSceneMeta;
}

export interface WorldSceneMeta {
  available: boolean;
}

// --------------------------------------------------------------------------------------- the World scene (Phase 3)

/** The commands the browser can send in POST /api/world/cmd (nothing of the building: hello, uplink and ping never). */
export const WORLD_SCENE_COMMANDS = [
  'move', 'profile', 'resync', 'view', 'view.off', 'enter', 'leave', 'like', 'unlike', 'greet', 'block', 'unblock', 'report',
  'stamp', 'teleport', 'knock', 'summary.seen',
] as const;
export type WorldSceneCommand =
  | MoveMessage
  | ProfileRequestMessage
  | ResyncMessage
  | ViewMessage
  | ViewOffMessage
  | EnterMessage
  | LeaveMessage
  | LikeMessage
  | GreetMessage
  | BlockMessage
  | ReportMessage
  | StampMessage
  | TeleportMessage
  | KnockMessage
  | SummarySeenMessage;

/** Commands per batch (POST /api/world/cmd) and batches per second per stream. */
export const WORLD_SCENE_LIMITS = { cmdsPerBatch: 20, batchesPerSec: 5, streams: 4 } as const;

/**
 * The city messages the stream passes on (`world` event), as they came from the world server. The local server has
 * already checked the `rev` of the patches (a jump becomes `resync` and the patch does not pass) and dropped what is
 * not of the scene.
 */
export type WorldSceneMessage =
  | AreaMessage
  | AreaPatchMessage
  | PlayersMessage
  | PlayerJoinMessage
  | PlayerLeaveMessage
  | PosMessage
  | MinimapMessage
  | AfkMessage
  | ProfileMessage
  | NoticeMessage
  | LikeUpdateMessage
  | GreetingMessage
  | BuildingMessage
  | BuildingPatchMessage
  | VisitorsMessage
  | CityStatusMessage
  | CityFireworksMessage
  | LikesTodayMessage
  | AwaySummaryMessage
  | KnockedMessage;

export const WORLD_SCENE_MESSAGES = [
  'area', 'area.patch', 'players', 'player.join', 'player.leave', 'pos', 'minimap', 'afk', 'profile', 'notice', 'like.update',
  'greeting', 'building', 'building.patch', 'visitors',
  'city', 'city.fireworks', 'likes.today', 'away.summary', 'knock',
] as const satisfies readonly WorldSceneMessage['t'][];

/**
 * Inside a building (Phase 4, Visit scene): the interior the world server sent in the `building` (on entering or in the
 * `resync {building}`), with each `building.patch` already applied, and the building `rev` it is at.
 */
export interface WorldSceneInside {
  /** Building id (the owner's id). */
  id: string;
  rev: number;
  detail: WorldBuildingDetail;
}

/** The city (↓ `city`, Phase 5): lit buildings, the week's goal and the token range (both only with 10 buildings or more). */
export type WorldSceneCity = Omit<CityStatusMessage, 't'>;

/** Me in the scene: this account's player (from the `welcome`), without the visibility options. */
export interface WorldSceneMe {
  id: string;
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro?: IntroId;
  country?: string;
  /** This account's building (the building id is the owner's id), if it has one in the world. */
  buildingId?: string;
}

/** The buildings of a chunk, with the `rev` they are at. */
export interface WorldSceneChunk {
  chunk: string;
  rev: number;
  buildings: WorldBuildingPublic[];
}

/** The city state the local server has (`world.snapshot` event): the browser replaces all of its own with this one. */
export interface WorldSceneSnapshot {
  /** Id of this stream: goes in POST /api/world/cmd. */
  stream: string;
  /**
   * The connection to the world server is open (`welcome`). Without it (dropped, reconnecting, stopped by the server),
   * nothing comes down. Paused or out of the world, it opens only with the scene open, without the building packet.
   */
  connected: boolean;
  /** `view` sent: the world server is sending the area and the players. */
  viewing: boolean;
  /** District of the chunk ids (`<distrito>:<cx>,<cy>`), from the `welcome`. */
  district?: string;
  me?: WorldSceneMe;
  /** My position: that of the server's last `pos` (or of my id in a `players`) or that of the last `move` sent. */
  pos?: WorldPosition;
  /** The server sent `afk` and there has been no real command yet (walk, turn, `view`, `profile`). */
  afk: boolean;
  /** The subscribed chunks (only the 3×3 around my position). */
  chunks: WorldSceneChunk[];
  /** The other visible players (never me), with the most recent position. */
  players: WorldPlayerPublic[];
  /** The minimap (lit buildings per block), or null before the first one. */
  minimap: MinimapMessage['blocks'] | null;
  /** Inside a building: the interior (until the `pos` that says "back on the street"). Absent on the street. */
  inside?: WorldSceneInside;
  /** The last `city` (Phase 5): the world server sends one when the scene opens and then one per minute. */
  city?: WorldSceneCity;
  /** Likes my building received today (last ↓ `likes.today` of this connection). */
  likesToday?: number;
  /** The last "While you were away" of this connection, until the `summary.seen`. */
  summary?: AwaySummary;
}

/** GET /api/world/status (and the response of verify, login and logout). */
export interface WorldStatus {
  /** Acting for the account is possible in this Habblaud (terminal lock on: access only from the computer itself). */
  available: boolean;
  configured: boolean;
  state: WorldState;
  /**
   * `id`: the account's id in the world, when already known (from the `welcome` of the building connection); goes in the
   * subject of the appeal.
   * `reservedName`: the player name chosen at sign-up, reserved while there is no character (from `GET /v1/me`).
   */
  account?: { emailMasked: string; access: WorldAccess; id?: string; reservedName?: string };
  player?: Player;
  devices?: DeviceInfo[];
  /** Code of the last problem (worldLastError: only known codes), when the data may be stale. */
  lastError?: WorldKnownErrorCode;
  /** The building in the world (only with the account approved and the character created). */
  building?: WorldBuildingStatus;
  /** Theme saved for the building (PUT /api/world/theme); absent = 'auto'. */
  theme?: WorldThemeChoice;
  /** Who this account blocked (/v1/me; Phase 5): Settings › Habblaud World › Blocked. */
  blocked?: WorldBlockedPlayer[];
}

/** A blocked player (only the id the world gave and the name). */
export interface WorldBlockedPlayer {
  id: string;
  name: string;
}

export interface WorldErrorResponse {
  error: { code: string; message?: string; retryAfter?: number };
}

/**
 * Codes given by the local server itself. It also uses, with the same meaning, some of WORLD_ERROR_CODES (those of the
 * world server): invalid, invalid_code, password_invalid, name_invalid, name_blocked, invalid_json, too_large,
 * unsupported_media_type, method_not_allowed, not_found and internal (500: error of the local server itself).
 */
export const WORLD_LOCAL_ERROR_CODES = [
  'not_configured', // 409: no accepted world server (HABBLAUD_WORLD_URL refused)
  'local_only', // 403: through the phone port or with a Host that is not local
  'terminal_off', // 403: terminal lock off (port exposed on the network or HABBLAUD_TERMINAL=0)
  'not_logged_in', // 401: account action without having signed in
  'session_expired', // in lastError: the world server refused the token (revoked or expired) and the session was deleted
  'invalid_email', // 400
  'altcha_failed', // 502: the world server's anti-bot challenge had no solution
  'world_unreachable', // 502: no connection to the world server
  'world_timeout', // 504
  'world_bad_response', // 502: malformed response
  'world_error', // world server error with no readable code (same status)
  'storage_failed', // in lastError: could not write world.json (the session lasts only until a restart)
  'too_many_streams', // 429: the World scene is already open in 4 tabs
  'no_stream', // 409: command from a stream that is not open (the scene closed or the server restarted)
  'not_connected', // 409: command without the connection to the world server open
  'account_deleted', // in lastError: the account was deleted (from here or from another computer) and world.json, erased
  'network', // in lastError: no connection to the world server or no response in time
  'unknown', // in lastError: another problem (malformed response, a code this version does not know)
] as const;
export type WorldLocalErrorCode = (typeof WORLD_LOCAL_ERROR_CODES)[number];

/** Every known error code: those of the world server and those of the local server, without repeats. */
export const WORLD_KNOWN_ERROR_CODES: readonly (WorldErrorCode | WorldLocalErrorCode)[] = [...new Set([...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES])];
export type WorldKnownErrorCode = WorldErrorCode | WorldLocalErrorCode;

export function isWorldKnownErrorCode(v: unknown): v is WorldKnownErrorCode {
  return typeof v === 'string' && (WORLD_KNOWN_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * The code that goes in WorldStatus.lastError: only those on the list; no connection or no response in time becomes
 * `network`, and the rest (malformed response, error with no code, code this version does not know) becomes `unknown`.
 */
export function worldLastError(code: string): WorldKnownErrorCode {
  if (code === 'world_unreachable' || code === 'world_timeout') return 'network';
  if (code === 'world_bad_response' || code === 'world_error') return 'unknown';
  return isWorldKnownErrorCode(code) ? code : 'unknown';
}
