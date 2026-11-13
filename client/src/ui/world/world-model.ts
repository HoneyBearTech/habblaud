// Habblaud World in the interface, pure part (no DOM): when the World window and the launch popups show, the
// section's state machine, the password, player name and trait rules and the text of each error. They are checks
// ahead of time, to answer right away: the server is the one that decides (the name, for example, still goes
// through the list of blocked words, which only it has). Also the "Your building" card (Phase 2): state, counts,
// reason for a refused upload, the top bar chip and when the theme goes to the world. Phase 6: the "Account and
// data" screen (inactivity warning, download the data, delete the account), the appeal by email (suspended or
// banned account, "unverified" building) and the world's maintenance. The interface is in settings-world.ts,
// building.ts, world-chip.ts and world-popups.ts.
import { PART_KEYS, type AppearanceParts } from '../../../../shared/appearance';
import type { Appearance } from '../../art/api';
import { appearanceFromSeed } from '../../art/character/appearance';
import { PLAYER_TRAITS } from '../../../../shared/world/protocol';
import { parsePlayerTraits, traitsClash, type TraitId } from '../../../../shared/world/traits';
import type { WorldBuildingStatus, WorldBuildingStop, WorldErrorCode, WorldLastUplink, WorldMeta, WorldServerState, WorldVisibility } from '../../net/world';
import { UPLINK_ACK_ERRORS, type WorldUplink } from '../../../../shared/world/protocol';
import { formatInt, relativeTime } from '../format';
import { isWorldKnownErrorCode } from '../../../../shared/world/api';
import { isIntroId } from '../../../../shared/world/intro';
import { parsePlayerName, type PlayerNameProblem } from '../../../../shared/world/names-rules';
import { tr } from '../../../../shared/i18n';

// ------------------------------------------------------------------ when it shows

/**
 * - hidden: nothing of World (no `meta.world`, `enabled: false`, no World server configured, which is the default:
 *   the feature stays off and nothing shows; or the phone page through the remote port);
 * - local_only: opened from another address or without the terminal lock: the account routes answer 403;
 * - active: you can create an account, sign in, edit the character...
 */
export type WorldSectionMode = 'hidden' | 'local_only' | 'active';

export interface WorldGate {
  /** Phone page (remote port with login). */
  remote: boolean;
  /** Page opened from the computer itself (local Host). */
  local: boolean;
  /** meta.terminal: Habblaud is only reachable from the computer itself (the lock on the account actions). */
  terminal: boolean;
  /** Demo mode with the FakeWorldApi: with no server, no lock applies. */
  fake: boolean;
}

export function worldSectionMode(meta: WorldMeta | undefined, gate: WorldGate): WorldSectionMode {
  if (!meta?.enabled || !meta.configured || meta.state === 'off' || gate.remote) return 'hidden';
  if (!gate.fake && (!gate.local || !gate.terminal)) return 'local_only';
  return 'active';
}

// ------------------------------------------------------------------ the launch popups (world-popups.ts)

/**
 * Has the character been created yet? The local server only puts `scene` (and `building`) in meta.world with the
 * account cleared and the character created (server/world/service.ts: `hasBuilding`); demo mode does the same.
 * Before that the meta says nothing about the character (the snapshot goes to the phone and to the timeline), and
 * that is enough here.
 */
export function hasCharacter(meta: WorldMeta | undefined): boolean {
  return !!meta && (meta.scene !== undefined || meta.building !== undefined);
}

/** Key of the old invite card (up to 0.11): only the value `never` ("Don't show again") still applies. */
export const INVITE_SEEN_KEY = 'habblaud:world-invite-seen';
/** Launch popup: JSON `{shown, last}` (how many times it appeared and when the last one was, in ms) or `never`. */
export const LAUNCH_KEY = 'habblaud:world-launch';
/** "You're on the waitlist" popup: `1` after it appears. */
export const WAITLIST_SEEN_KEY = 'habblaud:world-waitlist-seen';
/** "Access granted!" popup: `1` after it appears. */
export const APPROVED_SEEN_KEY = 'habblaud:world-approved-seen';

/** "Not now": the launch popup comes back after 3 days... */
export const LAUNCH_RETURN_MS = 3 * 24 * 60 * 60 * 1000;
/** ...and appears at most 3 times in total (the first one and two reminders). */
export const LAUNCH_MAX_SHOWS = 3;

export type WorldPopupKind = 'launch' | 'waitlist' | 'approved';

/** What this browser has already seen of the popups (localStorage; without it, it holds only for the page). */
export interface WorldPopupMemory {
  /** Launch: how many times it appeared and when the last one was; `never` = "Don't show again" or account created. */
  launch: { shown: number; last: number } | 'never' | null;
  waitlistSeen: boolean;
  approvedSeen: boolean;
}

export interface WorldPopupDecision {
  show: WorldPopupKind | null;
  /** The memory after this read (with the popup counted), or null if nothing changes. */
  memory: WorldPopupMemory | null;
}

export const EMPTY_POPUP_MEMORY: WorldPopupMemory = { launch: null, waitlistSeen: false, approvedSeen: false };

/** Reads the popup memory from the raw keys (old `never` counts as "never"; `shown` doesn't block the new launch). */
export function parsePopupMemory(raw: { launch: string | null; legacy: string | null; waitlist: string | null; approved: string | null }): WorldPopupMemory {
  let launch: WorldPopupMemory['launch'] = null;
  if (raw.launch === 'never' || raw.legacy === 'never') launch = 'never';
  else if (raw.launch) {
    try {
      const v = JSON.parse(raw.launch) as { shown?: unknown; last?: unknown };
      if (v && typeof v === 'object' && typeof v.shown === 'number' && typeof v.last === 'number' && Number.isFinite(v.shown) && Number.isFinite(v.last)) {
        launch = { shown: Math.max(0, Math.floor(v.shown)), last: Math.max(0, v.last) };
      }
    } catch {
      // malformed value: as if it had never appeared
    }
  }
  return { launch, waitlistSeen: raw.waitlist !== null, approvedSeen: raw.approved !== null };
}

/** What to write to each key (null = delete). */
export function serializePopupMemory(m: WorldPopupMemory): { launch: string | null; waitlist: string | null; approved: string | null } {
  return {
    launch: m.launch === 'never' ? 'never' : m.launch ? JSON.stringify(m.launch) : null,
    waitlist: m.waitlistSeen ? '1' : null,
    approved: m.approvedSeen ? '1' : null,
  };
}

/**
 * Which Habblaud World popup to show now (only one at a time, by the account state), and what to write to memory:
 * - launch: no account ("New: Habblaud World"); comes back every 3 days up to 3 times, or never again after
 *   "Don't show again" or an account being created (any state other than `logged_out` writes `never`);
 * - waitlist: on the waitlist, once per browser (right after signup or on opening the page already waiting);
 * - approved: access granted and character not created yet, once per browser.
 * Only from the computer itself with the World server configured; never in the timelapse, in demo mode or through the
 * phone port. The memory is written when the popup appears (closing the page with it open counts).
 */
export function nextWorldPopup(meta: WorldMeta | undefined, gate: WorldGate & { replaying: boolean }, memory: WorldPopupMemory, now: number): WorldPopupDecision {
  if (gate.fake || gate.replaying || worldSectionMode(meta, gate) !== 'active' || !meta) return { show: null, memory: null };
  if (meta.state === 'logged_out') {
    const l = memory.launch;
    if (l === 'never') return { show: null, memory: null };
    if (l && (l.shown >= LAUNCH_MAX_SHOWS || now - l.last < LAUNCH_RETURN_MS)) return { show: null, memory: null };
    return { show: 'launch', memory: { ...memory, launch: { shown: (l?.shown ?? 0) + 1, last: now } } };
  }
  // With an account (waiting or granted), the launch never appears again.
  const base: WorldPopupMemory = memory.launch === 'never' ? memory : { ...memory, launch: 'never' };
  const changed = base !== memory;
  if (meta.state === 'waiting' && !memory.waitlistSeen) return { show: 'waitlist', memory: { ...base, waitlistSeen: true } };
  if (meta.state === 'approved' && !memory.approvedSeen && !hasCharacter(meta)) return { show: 'approved', memory: { ...base, approvedSeen: true } };
  return { show: null, memory: changed ? base : null };
}

// ------------------------------------------------------------------ section state machine

export type WorldScreen =
  // no account (state 'logged_out')
  | 'welcome'
  | 'register'
  | 'login'
  | 'verify'
  | 'forgot'
  | 'reset'
  // with an account ('waiting' or 'approved')
  | 'home'
  | 'character'
  | 'visibility'
  | 'devices'
  // "Account and data" (Phase 6): inactivity notice, download the data and delete the account
  | 'account'
  // Blocked (Phase 5): who you blocked, to unblock
  | 'blocked';

/** Short notice at the top of the section after an action (goes away on the next navigation). */
export type WorldFlash = 'code_sent' | 'code_resent' | 'password_changed' | 'signed_out' | 'character_saved' | 'device_revoked';

export interface WorldUi {
  /** Account state according to the last GET /api/world/status (before it, the one from the snapshot). */
  server: WorldServerState | null;
  screen: WorldScreen;
  /** Typed email: goes from signup to the code, from "Forgot password" to the new password and to login. */
  email: string;
  /** Player name typed at signup: comes back filled in if the person returns from the code screen. */
  name: string;
  flash: WorldFlash | null;
}

export type WorldUiEvent =
  | { type: 'server'; state: WorldServerState }
  | { type: 'go'; screen: WorldScreen }
  /** Signup accepted (with the player name reserved) or login with an email not confirmed yet: the code went to the email. */
  | { type: 'code_sent'; email: string; name?: string }
  /** "Forgot password": the code for the new password went to the email. */
  | { type: 'reset_code_sent'; email: string }
  | { type: 'password_changed' }
  /** Signed in (code confirmed or login): the notice on the entry screen no longer holds. */
  | { type: 'signed_in' }
  | { type: 'flash'; flash: WorldFlash };

const SIGNED_OUT: readonly WorldScreen[] = ['welcome', 'register', 'login', 'verify', 'forgot', 'reset'];
const SIGNED_IN: readonly WorldScreen[] = ['home', 'character', 'visibility', 'devices', 'account', 'blocked'];

/** Possible screens in each account state (the first one is the entry screen). */
export function screensFor(state: WorldServerState): readonly WorldScreen[] {
  if (state === 'waiting' || state === 'approved') return SIGNED_IN;
  if (state === 'logged_out') return SIGNED_OUT;
  return [];
}

export function initialWorldUi(): WorldUi {
  return { server: null, screen: 'welcome', email: '', name: '', flash: null };
}

/** Does the screen still hold for the account state? If not, back to the entry one (e.g. signed out → welcome). */
function fit(s: WorldUi): WorldUi {
  if (!s.server) return s;
  const allowed = screensFor(s.server);
  if (!allowed.length || allowed.includes(s.screen)) return s;
  return { ...s, screen: allowed[0] };
}

export function worldReduce(s: WorldUi, e: WorldUiEvent): WorldUi {
  switch (e.type) {
    case 'server':
      return fit({ ...s, server: e.state });
    case 'go':
      return fit({ ...s, screen: e.screen, flash: null });
    case 'code_sent':
      return fit({ ...s, screen: 'verify', email: e.email, name: e.name ?? s.name, flash: 'code_sent' });
    case 'reset_code_sent':
      return fit({ ...s, screen: 'reset', email: e.email, flash: 'code_sent' });
    case 'password_changed':
      return fit({ ...s, screen: 'login', flash: 'password_changed' });
    case 'signed_in':
      return { ...s, flash: null };
    case 'flash':
      return { ...s, flash: e.flash };
  }
}

// ------------------------------------------------------------------ email, code and password

export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim();
}

export function emailLooksValid(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Email code: only the digits of what was typed or pasted ("123 456" works). */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function codeLooksValid(raw: string): boolean {
  return /^\d{6}$/.test(normalizeCode(raw));
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordProblem = 'short' | 'long' | 'email' | 'repeated';

/**
 * Password rules that can be checked without the server: 12 to 128 characters (in NFC), different from the email and
 * not just repetition ("aaaaaaaaaaaa", "abcabcabcabc"). The list of leaked passwords is checked by the server.
 */
export function passwordProblem(password: string, email = ''): PasswordProblem | null {
  const p = password.normalize('NFC');
  const n = [...p].length;
  if (n < PASSWORD_MIN) return 'short';
  if (n > PASSWORD_MAX) return 'long';
  const mail = normalizeEmail(email).toLowerCase();
  const lower = p.toLowerCase();
  if (mail && (lower === mail || lower === mail.split('@')[0])) return 'email';
  if (/^(.+?)\1+$/su.test(p)) return 'repeated';
  return null;
}

export function passwordProblemText(p: PasswordProblem): string {
  switch (p) {
    case 'short':
      return tr('The password needs at least 12 characters.');
    case 'long':
      return tr('The password can have at most 128 characters.');
    case 'email':
      return tr("The password can't be your email.");
    case 'repeated':
      return tr('The password can\'t be just a repetition (like "aaaaaaaaaaaa").');
  }
}

// ------------------------------------------------------------------ player name

// Rules and uniqueness key: shared/world/names-rules.ts (the same as the world server's, minus the list of blocked
// words, which only it has). Only the text for each reason lives here.

export function nameProblemText(p: PlayerNameProblem): string {
  switch (p) {
    case 'type':
    case 'length':
      return tr('The name needs 3 to 20 characters.');
    case 'invisible':
      return tr('Remove invisible characters and special spaces from the name.');
    case 'chars':
      return tr('Use only letters, numbers, space, _ - and . in the name.');
    case 'scripts':
      return tr('Use letters from a single alphabet in the name.');
    case 'no_letter':
      return tr('The name needs at least one letter.');
    case 'reserved':
      return tr('This name is reserved. Pick another one.');
  }
}

// ------------------------------------------------------------------ traits

// Ids, labels, pairs that don't go together and choice validation: shared/world/traits.ts (same as the server's).

/**
 * Can trait `t` be checked with the ones already chosen? The chosen ones always can (to uncheck); the others can't when
 * there are already 3 or when they don't go with one of them (`with` says which).
 */
export function traitBlock(selected: readonly TraitId[], t: TraitId): { reason: 'full' } | { reason: 'clash'; with: TraitId } | null {
  if (selected.includes(t)) return null;
  const clash = selected.find((s) => traitsClash(s, t));
  if (clash) return { reason: 'clash', with: clash };
  if (selected.length >= PLAYER_TRAITS.max) return { reason: 'full' };
  return null;
}

/** Checks or unchecks (no effect if the trait is blocked). */
export function toggleTrait(selected: readonly TraitId[], t: TraitId): TraitId[] {
  if (selected.includes(t)) return selected.filter((s) => s !== t);
  return traitBlock(selected, t) ? [...selected] : [...selected, t];
}

/** 2 or 3 known traits, no repeats and no pairs that don't go together (parsePlayerTraits, the server's rule). */
export function traitsValid(traits: readonly unknown[]): traits is TraitId[] {
  return parsePlayerTraits(traits) !== null;
}

// ------------------------------------------------------------------ character

/** Fixed seed of the draft: the player has no seed (the full `parts` counts), so it only gives the starting point. */
export const PLAYER_DRAFT_SEED = 0x5eed;

/**
 * All the appearance parts (the 13 in PART_KEYS). The world character goes without a seed: a partial `parts` would be
 * completed a different way in each place that draws it.
 */
export function fullParts(a: Appearance): AppearanceParts {
  const full: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = k === 'facialHair' ? (a.facialHair ?? 'none') : k === 'bottomStyle' ? (a.bottomStyle ?? 'pants') : a[k];
    full[k] = v;
  }
  return full as AppearanceParts;
}

/** Starting appearance of the editor: the saved character's (parts on top of the fixed seed) or a random pick. */
export function draftAppearance(look: 'f' | 'm', parts?: AppearanceParts, seed = PLAYER_DRAFT_SEED): Appearance {
  return appearanceFromSeed(seed, { look, parts });
}

export type CharacterProblem = { field: 'name'; problem: PlayerNameProblem } | { field: 'traits' } | { field: 'intro' };

/** What is missing to save the character (the first problem), or null. */
export function characterProblem(d: { name: string; traits: readonly TraitId[]; intro: string | null }): CharacterProblem | null {
  const name = parsePlayerName(d.name);
  if (!name.ok) return { field: 'name', problem: name.problem };
  if (!traitsValid(d.traits)) return { field: 'traits' };
  if (!d.intro || !isIntroId(d.intro)) return { field: 'intro' };
  return null;
}

// ------------------------------------------------------------------ visibility

export const DEFAULT_VISIBILITY: Readonly<WorldVisibility> = {
  mode: 'live',
  closed: false,
  hideCountry: false,
  tokensVisible: true,
  leaderboard: false,
  compactions: false,
  knocks: false,
};

/** The switches on the visibility screen (the inactivity notice is in "Account and data"). */
export type VisibilitySwitch = Exclude<keyof WorldVisibility, 'mode' | 'notifyInactivity'>;

/** Order of the switches on the screen. */
export const VISIBILITY_SWITCHES: readonly VisibilitySwitch[] = ['closed', 'hideCountry', 'tokensVisible', 'leaderboard', 'compactions', 'knocks'];

// ------------------------------------------------------------------ account and data (Phase 6)

/** Is the email notice before the building is removed for inactivity on? With no information, the account default: yes. */
export function notifyInactivityOn(v: Pick<WorldVisibility, 'notifyInactivity'> | undefined): boolean {
  return v?.notifyInactivity !== false;
}

/** File name of "Download my data" (the same as the attachment of GET /api/world/export). */
export const EXPORT_FILENAME = 'habblaud-world-dados.json';

/** Where appeals go (account suspended or banned, building "unverified") and requests about the data. */
export const APPEAL_EMAIL = 'privacidade@habblaud.com';

/** Fixed appeal subject (in Portuguese: it is the inbox filter of whoever handles it), with the account id when known. */
export const APPEAL_SUBJECT = 'Recurso Habblaud World';

/** The "Appeal by email" link: mailto to APPEAL_EMAIL with the subject and, if there is one, the account id. */
export function appealMailto(accountId?: string): string {
  const id = accountId && /^[A-Za-z0-9_-]{1,64}$/.test(accountId) ? accountId : '';
  return `mailto:${APPEAL_EMAIL}?subject=${encodeURIComponent(id ? `${APPEAL_SUBJECT} ${id}` : APPEAL_SUBJECT)}`;
}

/** The badge of a building marked as "unverified" (WorldBuildingPublic.unverified), for the city card. */
export function unverifiedLabel(): string {
  return tr('Unverified');
}

/** What the badge means, for whoever sees the building in the city (the badge's hint on the card). */
export function unverifiedHint(): string {
  return tr("This building's numbers looked unusual and are under review; meanwhile, it stays out of leaderboards and highlights.");
}

// ------------------------------------------------------------------ errors

/** What the interface was doing: the same code ("invalid") means different things in each action. */
export type WorldAction =
  | 'status'
  | 'register'
  | 'verify'
  | 'login'
  | 'logout'
  | 'resend'
  | 'forgot'
  | 'reset'
  | 'character'
  | 'visibility'
  | 'devices'
  | 'revoke'
  | 'pause'
  | 'resume'
  | 'join'
  | 'leave'
  | 'sent'
  | 'theme'
  /** A World scene command (POST /api/world/cmd) refused by the local server. */
  | 'scene'
  /** "Download my data" (GET /api/world/export). */
  | 'export'
  /** "Delete account" (ask for the code or confirm). */
  | 'delete'
  /** The inactivity notice (PUT /api/world/visibility). */
  | 'inactivity'
  /** Phase 5: "While you were away" seen and Unblock. */
  | 'summary'
  | 'unblock';

/**
 * Text of an error (the server's `message`, in English, never appears). The switch covers every WorldErrorCode (the
 * compiler demands a text for each new code); a code this version doesn't know gets the generic text.
 */
export function worldErrorText(raw: WorldErrorCode | string, action: WorldAction): string {
  const code: WorldErrorCode = isWorldKnownErrorCode(raw) || raw === 'offline' || raw === 'forbidden' ? raw : 'unknown';
  switch (code) {
    case 'invalid_code':
      return tr('Wrong or expired code. Check the email or ask for another code.');
    case 'invalid_credentials':
      return tr("Email or password don't match.");
    case 'email_not_verified':
      return tr('Your email still needs confirming: we sent a new code.');
    case 'banned':
      return tr('This account was banned from Habblaud World. To appeal, reply to the ban email.');
    case 'suspended':
      return tr('This account is suspended from Habblaud World for now.');
    case 'unauthorized':
    case 'not_logged_in':
    case 'session_expired':
      return tr('The Habblaud World session on this computer has ended. Sign in again.');
    case 'name_taken':
      return tr('This name is already taken in the world. Pick another one.');
    case 'name_invalid':
      return tr('Invalid name: 3 to 20 characters, with letters from a single alphabet, numbers, space, _ - and .');
    case 'name_blocked':
      return tr("This name isn't allowed. Pick another one.");
    case 'name_cooldown':
      return tr('The name can only be changed once every 30 days.');
    case 'password_invalid':
      return tr('The password must be 12 to 128 characters long.');
    case 'password_weak':
      return tr("Weak password: don't use your email, your player name or just repetition.");
    case 'password_pwned':
      return tr('This password appears in known data breaches. Choose another one.');
    case 'invalid_email':
      return tr('Invalid email. Check the address.');
    case 'altcha_required':
    case 'altcha_invalid':
    case 'altcha_failed':
      return tr("The anti-bot check didn't pass. Try again in a moment.");
    case 'device_limit':
      return tr('This account already has 3 computers; revoke one in Devices.');
    case 'no_player':
      return tr('Create your character first.');
    case 'unavailable':
      return tr('Habblaud World is under maintenance. Try again later.');
    case 'maintenance':
      return tr("The world is under maintenance; we'll try again in a moment.");
    case 'not_found':
      return action === 'revoke' ? tr('This device is no longer on the account.') : tr("The Habblaud World server couldn't find what was requested.");
    case 'invalid_json':
    case 'too_large':
    case 'unsupported_media_type':
    case 'method_not_allowed':
      return tr("The request was sent in a format the server doesn't accept. Update Habblaud and try again.");
    case 'not_configured':
      return tr("Habblaud World isn't turned on in this Habblaud (HABBLAUD_WORLD_URL was rejected; see the server log).");
    case 'rate_limited':
      return action === 'export'
        ? tr('You can download your data once a day. Try again tomorrow.')
        : tr('Too many attempts in a row. Wait a few minutes and try again.');
    case 'network':
    case 'world_unreachable':
    case 'world_timeout':
      return tr("The Habblaud World server didn't respond. Try again in a moment.");
    case 'world_bad_response':
      return tr('The Habblaud World server sent an unexpected response. Try again in a moment.');
    case 'account_deleted':
      return tr('The Habblaud World account was deleted. The building and the profile left the world right away; the rest is deleted from the database within 7 days and from backups within 30.');
    case 'storage_failed':
      return tr("Couldn't save the session on this computer: it only lasts until Habblaud restarts.");
    case 'too_many_streams':
      return tr('The city is already open in other Habblaud tabs. Close one of them to open it here.');
    case 'no_stream':
      return tr('The World scene lost its connection to Habblaud. Open the city again.');
    case 'not_connected':
      if (action === 'unblock') return tr('No connection to Habblaud World right now: unblocking needs your building lit or the city open.');
      return tr('No connection to Habblaud World right now; Habblaud tries again on its own.');
    case 'offline':
      return tr('No connection to Habblaud.');
    case 'forbidden':
    case 'local_only':
      return tr('The World account can only be managed from the computer itself, with Habblaud opened on localhost.');
    case 'terminal_off':
      return tr('The World account can only be managed when Habblaud is reachable only from this computer (local access, bind 127.0.0.1).');
    case 'invalid':
      switch (action) {
        case 'register':
        case 'reset':
          return tr("The server rejected the email or the password. The password needs 12 to 128 characters and can't be on a list of leaked passwords.");
        case 'character':
          return tr('The server rejected the character. Check the name, the traits (2 or 3) and the intro phrase.');
        case 'visibility':
        case 'inactivity':
          return tr('The server rejected the visibility options.');
        default:
          return tr('The server rejected the request. Check the details and try again.');
      }
    case 'internal':
      return tr('The world server had an error; try again.');
    case 'world_error':
    case 'unknown':
      return tr('Something went wrong. Try again in a moment.');
  }
}

// ------------------------------------------------------------------ building in the world (Phase 2)

/**
 * State of the "Your building" card (approved account). Without a character the building doesn't enter the world; out
 * of the world ("Leave the world") and paused count for more than the connection (in both no packet goes up); then, a
 * stop requested by the world server (`stopped`, with the reason); with no open connection, Habblaud is connecting or
 * trying again.
 */
export type BuildingState = 'connected' | 'reconnecting' | 'paused' | 'stopped' | 'left' | 'no_player';

export function buildingState(b: WorldBuildingStatus | undefined, hasPlayer: boolean): BuildingState {
  if (!hasPlayer) return 'no_player';
  if (b?.left) return 'left';
  if (b?.paused) return 'paused';
  if (b?.stopped) return 'stopped';
  return b?.connected ? 'connected' : 'reconnecting';
}

/** What the card says when the world server stopped the building (`goodbye`), by reason. */
export function buildingStopView(reason: WorldBuildingStop): { label: string; desc: string; toggle: BuildingView['toggle'] } {
  switch (reason) {
    case 'update':
      return { label: tr('Update Habblaud'), desc: tr('This version of Habblaud can no longer join the world. Update it to light the building up again.'), toggle: null };
    case 'other-device':
      return {
        label: tr('Connected on another computer'),
        desc: tr('Your account connected the building on another computer, and this one stopped sending.'),
        toggle: { action: 'resume', text: tr('Bring it to this computer'), hint: tr('The building goes back to uploading from here, and the other computer stops sending.') },
      };
    case 'banned':
      return { label: tr('Account banned'), desc: tr('Habblaud World banned this account: the building left the world and nothing else leaves this computer.'), toggle: null };
    case 'suspended':
      return {
        label: tr('Account suspended'),
        desc: tr('This account is suspended in Habblaud World: the building stays dark and nothing leaves this computer.'),
        toggle: { action: 'resume', text: tr('Try again'), hint: tr('If the suspension is over, the building lights up again.') },
      };
    case 'waiting':
      return { label: tr('On the waitlist'), desc: tr('The account went back to the waiting list: the building leaves the world until access is granted again.'), toggle: null };
    case 'no_player':
      return { label: tr('No character'), desc: tr("The world couldn't find your character: create it again to bring the building back."), toggle: null };
    case 'unauthorized':
      return { label: tr('Sign in again'), desc: tr("The world server didn't recognize this computer: sign in to the account again."), toggle: null };
    case 'deleted':
      return { label: tr('Account deleted'), desc: tr('The Habblaud World account was deleted: the building and the profile left the world, and nothing else leaves this computer.'), toggle: null };
  }
}

/**
 * Reasons the world server gives for refusing an upload (`uplink.ack {error}`, UPLINK_ACK_ERRORS of the protocol); a
 * code this version doesn't know arrives as `internal` (net/world.ts) and one outside the list becomes the generic one.
 */
export const UPLINK_REJECT_CODES = UPLINK_ACK_ERRORS;

/** Why the world refused the upload, in one sentence. */
export function uplinkRejectText(code: string | undefined): string {
  switch (code) {
    case 'schema':
      return tr("The packet didn't match the protocol format. Update Habblaud.");
    case 'limits':
      return tr("The office went over the world's limits (64 floors, 64 agents per floor, 256 agents or 64 KB).");
    case 'name_pool':
      return tr("A character name isn't on the world's list of names.");
    case 'parts':
      return tr("An appearance part is outside the editor's palettes.");
    case 'ids':
      return tr("A floor or agent code isn't in the right format.");
    case 'rate':
      return tr('Too many uploads in a short time (the limit is 12 per minute). The next one goes through normally.');
    case 'internal':
      return tr('An error on the world server. The next upload tries again.');
    case 'left':
      return tr('The account left the world (from this or another computer): nothing else is sent until you come back to the world.');
    case 'implausible':
      return tr("The packet contradicts the previous one in a way Habblaud doesn't produce: the world discarded it, and the building keeps the last accepted one. The next uploads go out normally.");
    default:
      return tr("A reason this version of Habblaud doesn't know.");
  }
}

export interface BuildingView {
  state: BuildingState;
  /** State badge ("Connected", "Paused"...). */
  label: string;
  /** What the state means, in one or two sentences. */
  desc: string;
  /** "2 floors", "3 agents", "Last upload: 12 s ago" (empty without a character). */
  stats: string[];
  /** Reason the last upload was refused (null: accepted or no answer yet). */
  rejected: string | null;
  /** Text of the pause button and its explanation (null: no button). */
  toggle: { action: 'pause' | 'resume' | 'join'; text: string; hint: string } | null;
  /** Shows "Leave the world" (there is a building in the world to remove). */
  leave: boolean;
  /** The building is marked as "unverified" (what that means, for the owner), or null. */
  unverified: string | null;
  /** "Appeal by email" (account suspended or banned) or "Dispute by email" (unverified), or null. */
  appeal: { text: string; hint: string } | null;
}

/** What the card knows besides the building: the world's maintenance (the last /v1/me answered 503 `maintenance`). */
export interface BuildingViewOptions {
  maintenance?: boolean;
}

/** "Appeal by email", with the explanation next to it. */
function appealFor(kind: 'appeal' | 'contest'): { text: string; hint: string } {
  return kind === 'appeal'
    ? { text: tr('Appeal by email'), hint: tr('Opens an email to {0}: tell us what happened, and a person reviews the case.', [APPEAL_EMAIL]) }
    : { text: tr('Dispute by email'), hint: tr("Opens an email to {0}: if it's a mistake, a person reviews the numbers and removes the badge.", [APPEAL_EMAIL]) };
}

/** "1 byte", "1,174 bytes". */
export function bytesText(n: number): string {
  return n === 1 ? tr('1 byte') : tr('{0} bytes', [formatInt(n)]);
}

/** "1 floor", "3 floors". */
export function floorsText(n: number): string {
  return n === 1 ? tr('1 floor') : tr('{0} floors', [formatInt(n)]);
}

/** "1 agent", "3 agents". */
export function agentsText(n: number): string {
  return n === 1 ? tr('1 agent') : tr('{0} agents', [formatInt(n)]);
}

/** "1 visitor now", "3 visitors now". */
export function visitorsText(n: number): string {
  return n === 1 ? tr('1 visitor now') : tr('{0} visitors now', [formatInt(n)]);
}

/**
 * The "Someone entered your building" notice: once per connection, when the visitor count (meta.world.building
 * .visitors) goes from none to some. With no count (the connection dropped, closed to visits), the notice re-arms. The
 * first count this page sees gives no notice (the visit was already there before the page was opened).
 */
export interface VisitorAlertState {
  /** Has already seen a count (or the lack of one) on this page. */
  started: boolean;
  /** The last count (undefined: no count). */
  last: number | undefined;
  /** Has already given the notice on this connection. */
  notified: boolean;
}

export const VISITOR_ALERT_START: VisitorAlertState = { started: false, last: undefined, notified: false };

export function nextVisitorAlert(s: VisitorAlertState, visitors: number | undefined, enabled: boolean): { state: VisitorAlertState; notify: boolean } {
  const n = typeof visitors === 'number' && visitors > 0 ? visitors : visitors === 0 ? 0 : undefined;
  if (!s.started) return { state: { started: true, last: n, notified: n !== undefined && n > 0 }, notify: false };
  if (n === undefined) return { state: { started: true, last: undefined, notified: false }, notify: false };
  const arrived = n > 0 && (s.last ?? 0) === 0;
  const notify = arrived && !s.notified && enabled;
  return { state: { started: true, last: n, notified: s.notified || arrived }, notify };
}

/** Everything the "Your building" card shows, without DOM. */
export function buildingView(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number, opts: BuildingViewOptions = {}): BuildingView {
  const v = buildingViewBase(b, hasPlayer, now, opts);
  // Suspended or banned: the email appeal. Unverified (and the building still in the world): the badge and the dispute.
  if (v.state === 'stopped' && (b?.stopped === 'banned' || b?.stopped === 'suspended')) return { ...v, appeal: appealFor('appeal') };
  if (b?.unverified && v.state !== 'stopped' && v.state !== 'left' && v.state !== 'no_player') {
    return {
      ...v,
      unverified: tr('The world marked your building as "unverified": its numbers looked unusual and are under review. It stays in the world, but out of leaderboards and highlights.'),
      appeal: appealFor('contest'),
    };
  }
  return v;
}

function buildingViewBase(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number, opts: BuildingViewOptions): BuildingView {
  const state = buildingState(b, hasPlayer);
  const extra = { unverified: null, appeal: null };
  const floors = b?.floors ?? 0;
  const agents = b?.agents ?? 0;
  const stats =
    state === 'no_player' || state === 'left'
      ? []
      : [
          floorsText(floors),
          agentsText(agents),
          b?.lastUplinkAt ? tr('Last upload: {0}', [relativeTime(b.lastUplinkAt, now)]) : tr('No uploads yet'),
          ...(b?.visitors ? [`👀 ${visitorsText(b.visitors)}`] : []),
        ];
  const live = state === 'connected' || state === 'reconnecting' || state === 'paused';
  const rejected = live && b?.lastAck?.ok === false ? uplinkRejectText(b.lastAck.error) : null;
  const later = tr('After 30 days paused, the building disappears from the map and is removed 30 days later; resuming before that brings it back, on the same lot.');
  switch (state) {
    case 'no_player':
      return { state, label: tr('No character'), desc: tr('Create your character: the building joins the world along with it.'), stats, rejected, toggle: null, leave: false, ...extra };
    case 'left':
      return {
        state,
        label: tr('Out of the world'),
        desc: tr('You left the world: the building was removed and the lot freed. You can still walk around the city; nothing from the office leaves this computer.'),
        stats,
        rejected: null,
        toggle: { action: 'join', text: tr('Back to the world'), hint: tr('Coming back creates a new building, on another lot; the account and the character are the same.') },
        leave: false,
        ...extra,
      };
    case 'stopped': {
      const reason = b!.stopped!;
      const v = buildingStopView(reason);
      return { state, ...v, stats, rejected, leave: reason === 'update' || reason === 'other-device' || reason === 'suspended', ...extra };
    }
    case 'paused':
      return {
        state,
        label: tr('Paused'),
        desc: tr('Paused: your building is dark, but you can walk around the city. Nothing from the office leaves this computer.'),
        stats,
        rejected,
        toggle: { action: 'resume', text: tr('Resume'), hint: `${tr('Resuming starts sending again and lights the building up.')} ${later}` },
        leave: true,
        ...extra,
      };
    case 'connected':
    case 'reconnecting': {
      const connected = state === 'connected';
      const first = !b?.lastUplinkAt;
      // No connection and the world in maintenance (503 `maintenance`): Habblaud tries again with a wait.
      const maintenance = !connected && !!opts.maintenance;
      return {
        state,
        label: connected ? tr('Connected') : maintenance ? tr('Under maintenance') : first ? tr('Connecting…') : tr('Reconnecting…'),
        desc: connected
          ? tr('Lit in the world: one floor per open room and each character in its current status. Tokens, if you allow it, show up only as ranges, on the facade meter.')
          : maintenance
            ? tr("The world is under maintenance; we'll try again in a moment.")
            : first
              ? tr('The building lights up with the first upload.')
              : tr('No connection to the world right now: Habblaud keeps retrying on its own. After 2 minutes without news, the building goes dark.'),
        stats,
        rejected,
        toggle: { action: 'pause', text: tr('Pause'), hint: `${tr('Pausing stops sending right away and turns the building off in the world.')} ${later}` },
        leave: true,
        ...extra,
      };
    }
  }
}

/** Difference between pausing and leaving the world (PLANO.md, section 2.6), next to the "Leave the world" button. */
export function leaveHint(): string {
  return tr(
    'Pausing turns the building off and keeps the lot: resuming brings it back, in the same place. Leaving the world removes the building right away and frees the lot; the account and the character stay, and coming back later creates a new building, on another lot.',
  );
}

export type AckKind = 'accepted' | 'rejected' | 'pending';

/**
 * The world's answer to an upload, for the "See what was sent" window. Accepted, with the bytes the world counted
 * (equal to the ones sent, `sentBytes`, when the packet arrived whole).
 */
export function ackView(ack: WorldLastUplink['ack'], sentBytes?: number): { kind: AckKind; label: string; reason: string | null } {
  if (!ack) return { kind: 'pending', label: tr('No reply from the world yet.'), reason: null };
  if (ack.ok) {
    const reason =
      ack.bytes === undefined ? null : ack.bytes === sentBytes ? tr('The world received the same {0}.', [bytesText(ack.bytes)]) : tr('The world counted {0}.', [bytesText(ack.bytes)]);
    return { kind: 'accepted', label: tr('Accepted by the world.'), reason };
  }
  return { kind: 'rejected', label: tr('Rejected by the world.'), reason: uplinkRejectText(ack.error) };
}

/** The packet as the window shows it: the same object that went on the wire, only with indentation (2 spaces). */
export function prettyUplink(uplink: WorldUplink): string {
  return JSON.stringify(uplink, null, 2);
}

/**
 * Does the choice in Appearance › Office theme also go to the building (PUT /api/world/theme)? Only with World on,
 * the account approved and the page where the account can be changed (the route is local only).
 */
export function themeGoesToWorld(meta: WorldMeta | undefined, gate: WorldGate): boolean {
  return worldSectionMode(meta, gate) === 'active' && meta?.state === 'approved';
}

export type WorldChipState = 'live' | 'paused' | 'reconnecting' | 'stopped';

/**
 * Top bar chip ("🏙️ in the world" / "⏸ paused" / "⚠️ stopped"): only with `meta.world.building` (approved account) and
 * never through the phone port. Out of the world, nothing. Stopped by the world server, "stopped" (the reason is on the
 * card). Without a connection, it only appears if the building has already sent an upload (before that it is not in
 * the world).
 */
export function worldChipState(meta: WorldMeta | undefined, gate: WorldGate): WorldChipState | null {
  const b = meta?.building;
  if (!b || b.left || meta.state !== 'approved' || worldSectionMode(meta, gate) === 'hidden') return null;
  if (b.paused) return 'paused';
  if (b.stopped) return 'stopped';
  if (b.connected) return 'live';
  return b.lastUplinkAt ? 'reconnecting' : null;
}
