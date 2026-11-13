import { describe, expect, it } from 'vitest';
import { PART_KEYS } from '../../../../shared/appearance';
import { TRAIT_IDS } from '../../../../shared/world/traits';
import { FAKE_UPLINK, WORLD_UI_ERROR_CODES, type WorldBuildingStatus, type WorldBuildingStop, type WorldMeta } from '../../net/world';
import {
  APPEAL_EMAIL,
  appealMailto,
  EXPORT_FILENAME,
  notifyInactivityOn,
  unverifiedHint,
  unverifiedLabel,
  worldErrorText,
  ackView,
  agentsText,
  buildingState,
  buildingStopView,
  buildingView,
  bytesText,
  floorsText,
  leaveHint,
  nextVisitorAlert,
  VISITOR_ALERT_START,
  prettyUplink,
  themeGoesToWorld,
  UPLINK_REJECT_CODES,
  uplinkRejectText,
  worldChipState,
  characterProblem,
  codeLooksValid,
  draftAppearance,
  emailLooksValid,
  fullParts,
  initialWorldUi,
  nameProblemText,
  normalizeCode,
  passwordProblem,
  screensFor,
  hasCharacter,
  nextWorldPopup,
  parsePopupMemory,
  serializePopupMemory,
  EMPTY_POPUP_MEMORY,
  LAUNCH_MAX_SHOWS,
  LAUNCH_RETURN_MS,
  type WorldPopupMemory,
  toggleTrait,
  traitBlock,
  traitsValid,
  worldReduce,
  worldSectionMode,
  type WorldGate,
  type WorldUi,
} from './world-model';

const LOCAL: WorldGate = { remote: false, local: true, terminal: true, fake: false };
const meta = (state: WorldMeta['state'], extra: Partial<WorldMeta> = {}): WorldMeta => ({ enabled: true, configured: true, state, ...extra });

describe('when the section shows up', () => {
  it('without meta.world or with enabled:false, nothing from World', () => {
    expect(worldSectionMode(undefined, LOCAL)).toBe('hidden');
    expect(worldSectionMode(meta('logged_out', { enabled: false }), LOCAL)).toBe('hidden');
  });

  it('with no server configured (the default): nothing from World, not even the notice that it is off', () => {
    expect(worldSectionMode(meta('off', { enabled: false, configured: false }), LOCAL)).toBe('hidden');
    expect(worldSectionMode(meta('off', { configured: false }), LOCAL)).toBe('hidden');
    expect(worldSectionMode(meta('off'), LOCAL)).toBe('hidden');
    expect(worldSectionMode(meta('off', { configured: false }), { ...LOCAL, fake: true })).toBe('hidden');
  });

  it('through the remote port (phone), it disappears; without the terminal lock or outside localhost, only the notice', () => {
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, remote: true })).toBe('hidden');
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, terminal: false })).toBe('local_only');
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, local: false })).toBe('local_only');
    expect(worldSectionMode(meta('waiting'), LOCAL)).toBe('active');
  });

  it('in demo mode (fake) the locks do not apply, but the remote port still hides it', () => {
    expect(worldSectionMode(meta('logged_out'), { remote: false, local: false, terminal: false, fake: true })).toBe('active');
    expect(worldSectionMode(meta('logged_out'), { remote: true, local: false, terminal: false, fake: true })).toBe('hidden');
  });
});

describe('launch popups', () => {
  const gate = { ...LOCAL, replaying: false };
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_760_600_000_000;
  const none = EMPTY_POPUP_MEMORY;
  const mem = (extra: Partial<WorldPopupMemory>): WorldPopupMemory => ({ ...none, ...extra });

  it('no account: "New" the first time, counted in the memory', () => {
    expect(nextWorldPopup(meta('logged_out'), gate, none, NOW)).toEqual({ show: 'launch', memory: mem({ launch: { shown: 1, last: NOW } }) });
  });

  it('"Not now": comes back only after 3 days, and at most 3 times in total', () => {
    const once = mem({ launch: { shown: 1, last: NOW } });
    expect(nextWorldPopup(meta('logged_out'), gate, once, NOW + DAY).show).toBeNull();
    expect(nextWorldPopup(meta('logged_out'), gate, once, NOW + LAUNCH_RETURN_MS - 1).show).toBeNull();
    const again = nextWorldPopup(meta('logged_out'), gate, once, NOW + LAUNCH_RETURN_MS);
    expect(again).toEqual({ show: 'launch', memory: mem({ launch: { shown: 2, last: NOW + LAUNCH_RETURN_MS } }) });
    const third = nextWorldPopup(meta('logged_out'), gate, again.memory!, NOW + 2 * LAUNCH_RETURN_MS);
    expect(third.show).toBe('launch');
    expect((third.memory!.launch as { shown: number }).shown).toBe(LAUNCH_MAX_SHOWS);
    expect(nextWorldPopup(meta('logged_out'), gate, third.memory!, NOW + 30 * DAY)).toEqual({ show: null, memory: null });
  });

  it('"Don\'t show again" (and the old key at `never`) end it; the old key at `shown` does not block', () => {
    expect(nextWorldPopup(meta('logged_out'), gate, mem({ launch: 'never' }), NOW)).toEqual({ show: null, memory: null });
    const legacyNever = parsePopupMemory({ launch: null, legacy: 'never', waitlist: null, approved: null });
    expect(legacyNever.launch).toBe('never');
    expect(nextWorldPopup(meta('logged_out'), gate, legacyNever, NOW).show).toBeNull();
    const legacyShown = parsePopupMemory({ launch: null, legacy: 'shown', waitlist: null, approved: null });
    expect(legacyShown).toEqual(none);
    expect(nextWorldPopup(meta('logged_out'), gate, legacyShown, NOW).show).toBe('launch');
  });

  it('with an account (on the waitlist or approved) the launch never shows again, even after signing out later', () => {
    const d = nextWorldPopup(meta('waiting'), gate, mem({ waitlistSeen: true }), NOW);
    expect(d).toEqual({ show: null, memory: mem({ launch: 'never', waitlistSeen: true }) });
    expect(nextWorldPopup(meta('logged_out'), gate, d.memory!, NOW + 10 * DAY).show).toBeNull();
    const a = nextWorldPopup(meta('approved', { scene: { available: true } }), gate, mem({ launch: { shown: 1, last: 0 } }), NOW);
    expect(a).toEqual({ show: null, memory: mem({ launch: 'never' }) });
    // already saved: nothing changes
    expect(nextWorldPopup(meta('approved', { scene: { available: true } }), gate, mem({ launch: 'never' }), NOW)).toEqual({ show: null, memory: null });
  });

  it('"You\'re on the waitlist": on joining the waitlist (or opening already on it), once per browser', () => {
    expect(nextWorldPopup(meta('waiting'), gate, none, NOW)).toEqual({ show: 'waitlist', memory: mem({ launch: 'never', waitlistSeen: true }) });
    expect(nextWorldPopup(meta('waiting'), gate, mem({ launch: 'never', waitlistSeen: true }), NOW)).toEqual({ show: null, memory: null });
  });

  it('"Access granted!": approved and without a character, once per browser; with a character, never', () => {
    expect(nextWorldPopup(meta('approved'), gate, none, NOW)).toEqual({ show: 'approved', memory: mem({ launch: 'never', approvedSeen: true }) });
    expect(nextWorldPopup(meta('approved'), gate, mem({ launch: 'never', approvedSeen: true }), NOW)).toEqual({ show: null, memory: null });
    expect(nextWorldPopup(meta('approved', { scene: { available: false } }), gate, none, NOW).show).toBeNull();
    // left the waitlist with the page open: the same rule (the memory of the wait doesn't get in the way)
    expect(nextWorldPopup(meta('approved'), gate, mem({ launch: 'never', waitlistSeen: true }), NOW).show).toBe('approved');
  });

  it('the character exists when the meta brings the scene or the building', () => {
    expect(hasCharacter(undefined)).toBe(false);
    expect(hasCharacter(meta('approved'))).toBe(false);
    expect(hasCharacter(meta('approved', { scene: { available: false } }))).toBe(true);
    expect(hasCharacter(meta('approved', { building: { state: 'live', floors: 1, agents: 0, idle: 0, working: 0 } as unknown as WorldMeta['building'] }))).toBe(true);
  });

  it('never in the timelapse, in demo mode, through the remote port, outside the computer or without a server', () => {
    for (const state of ['logged_out', 'waiting', 'approved'] as const) {
      expect(nextWorldPopup(meta(state), { ...gate, replaying: true }, none, NOW).show, `${state} replay`).toBeNull();
      expect(nextWorldPopup(meta(state), { ...gate, fake: true }, none, NOW).show, `${state} fake`).toBeNull();
      expect(nextWorldPopup(meta(state), { ...gate, remote: true }, none, NOW).show, `${state} remote`).toBeNull();
      expect(nextWorldPopup(meta(state), { ...gate, local: false }, none, NOW).show, `${state} local`).toBeNull();
      expect(nextWorldPopup(meta(state), { ...gate, terminal: false }, none, NOW).show, `${state} terminal`).toBeNull();
      expect(nextWorldPopup(meta(state, { configured: false }), gate, none, NOW).show, `${state} configured`).toBeNull();
      expect(nextWorldPopup(meta(state, { enabled: false }), gate, none, NOW).show, `${state} enabled`).toBeNull();
    }
    expect(nextWorldPopup(meta('off'), gate, none, NOW)).toEqual({ show: null, memory: null });
    expect(nextWorldPopup(undefined, gate, none, NOW)).toEqual({ show: null, memory: null });
  });

  it('the memory goes to and comes back from the localStorage keys; a malformed value counts as never', () => {
    const m = mem({ launch: { shown: 2, last: NOW }, waitlistSeen: true });
    const raw = serializePopupMemory(m);
    expect(raw).toEqual({ launch: JSON.stringify({ shown: 2, last: NOW }), waitlist: '1', approved: null });
    expect(parsePopupMemory({ ...raw, legacy: null })).toEqual(m);
    expect(serializePopupMemory(mem({ launch: 'never', approvedSeen: true }))).toEqual({ launch: 'never', waitlist: null, approved: '1' });
    expect(parsePopupMemory({ launch: 'never', legacy: null, waitlist: null, approved: '1' })).toEqual(mem({ launch: 'never', approvedSeen: true }));
    expect(parsePopupMemory({ launch: '{bad', legacy: null, waitlist: null, approved: null })).toEqual(none);
    expect(parsePopupMemory({ launch: '{"shown":"x"}', legacy: null, waitlist: null, approved: null })).toEqual(none);
    expect(parsePopupMemory({ launch: null, legacy: null, waitlist: null, approved: null })).toEqual(none);
  });
});

describe('state machine of the section', () => {
  const at = (server: WorldUi['server'], screen: WorldUi['screen'] = 'welcome'): WorldUi => ({ ...initialWorldUi(), server, screen });

  it('without an account it starts at the welcome; with an account (on the waitlist or approved), at the account home', () => {
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'logged_out' }).screen).toBe('welcome');
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'waiting' }).screen).toBe('home');
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'approved' }).screen).toBe('home');
  });

  it('sign-up keeps the email and the player name for the code screen (and for going back)', () => {
    const sent = worldReduce(at('logged_out', 'register'), { type: 'code_sent', email: 'ana@example.com', name: 'Ana Pixel' });
    expect(sent).toMatchObject({ screen: 'verify', email: 'ana@example.com', name: 'Ana Pixel', flash: 'code_sent' });
    expect(worldReduce(sent, { type: 'go', screen: 'register' })).toMatchObject({ screen: 'register', email: 'ana@example.com', name: 'Ana Pixel' });
    // The login with an unconfirmed email sends the code without a name: the name typed before stays.
    expect(worldReduce(sent, { type: 'code_sent', email: 'other@example.com' })).toMatchObject({ email: 'other@example.com', name: 'Ana Pixel' });
    expect(screensFor('off')).toEqual([]);
  });

  it('accepted sign-up goes to the code, keeping the email', () => {
    const s = worldReduce(at('logged_out', 'register'), { type: 'code_sent', email: 'a@b.co' });
    expect(s).toMatchObject({ screen: 'verify', email: 'a@b.co', flash: 'code_sent' });
  });

  it('code confirmed: the new status (on the waitlist) leads to the account home', () => {
    const s = worldReduce(at('logged_out', 'verify'), { type: 'server', state: 'waiting' });
    expect(s.screen).toBe('home');
  });

  it('forgot password → code and new password → login with the notice', () => {
    let s = worldReduce(at('logged_out', 'login'), { type: 'go', screen: 'forgot' });
    s = worldReduce(s, { type: 'reset_code_sent', email: 'a@b.co' });
    expect(s).toMatchObject({ screen: 'reset', email: 'a@b.co' });
    s = worldReduce(s, { type: 'password_changed' });
    expect(s).toMatchObject({ screen: 'login', flash: 'password_changed', email: 'a@b.co' });
  });

  it('account screens do not open without an account, and the sign-in ones do not open with an account', () => {
    expect(worldReduce(at('logged_out'), { type: 'go', screen: 'character' }).screen).toBe('welcome');
    expect(worldReduce(at('waiting', 'home'), { type: 'go', screen: 'register' }).screen).toBe('home');
    expect(worldReduce(at('waiting', 'home'), { type: 'go', screen: 'character' }).screen).toBe('character');
  });

  it('signed out (or the device was revoked somewhere else): back to the welcome', () => {
    const s = worldReduce(at('approved', 'devices'), { type: 'server', state: 'logged_out' });
    expect(s.screen).toBe('welcome');
  });

  it('signing in clears the notice on the sign-in screen ("Password changed")', () => {
    const s = worldReduce(at('logged_out', 'login'), { type: 'password_changed' });
    expect(worldReduce(s, { type: 'signed_in' }).flash).toBeNull();
  });

  it('navigating clears the notice; a new notice does not change the screen', () => {
    let s = worldReduce(at('logged_out', 'verify'), { type: 'flash', flash: 'code_resent' });
    expect(s).toMatchObject({ screen: 'verify', flash: 'code_resent' });
    s = worldReduce(s, { type: 'go', screen: 'welcome' });
    expect(s.flash).toBeNull();
  });
});

describe('email, code and password', () => {
  it('email that looks like an email', () => {
    expect(emailLooksValid(' you@example.com ')).toBe(true);
    for (const bad of ['', 'you', 'you@', '@example.com', 'you@example', 'yo u@example.com']) expect(emailLooksValid(bad), bad).toBe(false);
  });

  it('code: only the 6 digits (pasting "123 456" works)', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('12-34-56-78')).toBe('123456');
    expect(codeLooksValid('123 456')).toBe(true);
    expect(codeLooksValid('12345')).toBe(false);
  });

  it('password: 12 to 128 characters counted in code points (not in UTF-16)', () => {
    expect(passwordProblem('short')).toBe('short');
    expect(passwordProblem('a'.repeat(11) + 'b')).toBeNull();
    expect(passwordProblem('🙂'.repeat(11))).toBe('short');
    expect(passwordProblem('🙂'.repeat(11) + 'x')).toBeNull();
    expect(passwordProblem('x'.repeat(129) + 'y')).toBe('long');
  });

  it('password: neither the email nor just repetition', () => {
    expect(passwordProblem('you.da.silva@example.com', 'You.da.Silva@example.com')).toBe('email');
    expect(passwordProblem('you.da.silva', 'you.da.silva@example.com')).toBe('email');
    expect(passwordProblem('aaaaaaaaaaaa')).toBe('repeated');
    expect(passwordProblem('abcabcabcabc')).toBe('repeated');
    expect(passwordProblem('correct horse battery staple')).toBeNull();
  });
});

describe('player name', () => {
  // The rules are in shared/world/names-rules.ts (and in the test there); here, only the text of each reason.
  it('each refusal reason has a text', () => {
    const problems = ['type', 'length', 'invisible', 'chars', 'scripts', 'no_letter', 'reserved'] as const;
    for (const p of problems) expect(nameProblemText(p), p).toBeTruthy();
    expect(new Set(problems.map(nameProblemText)).size).toBe(problems.length - 1); // type and length say the same
  });
});

describe('traits', () => {
  it('2 or 3, with no repeats and without the pairs that do not go together', () => {
    expect(traitsValid(['cafeina'])).toBe(false);
    expect(traitsValid(['cafeina', 'games'])).toBe(true);
    expect(traitsValid(['cafeina', 'games', 'leitura'])).toBe(true);
    expect(traitsValid(['cafeina', 'games', 'leitura', 'calma'])).toBe(false);
    expect(traitsValid(['cafeina', 'cafeina'])).toBe(false);
    expect(traitsValid(['timidez', 'piadas'])).toBe(false);
    expect(traitsValid(['invented', 'games'])).toBe(false);
  });

  it('the five pairs of the contract are blocked in both directions', () => {
    const pairs = [['timidez', 'piadas'], ['timidez', 'fofoca'], ['apostas', 'economia'], ['esporte', 'sonecas'], ['calma', 'competicao']] as const;
    for (const [a, b] of pairs) {
      expect(traitBlock([a], b), `${a}×${b}`).toEqual({ reason: 'clash', with: a });
      expect(traitBlock([b], a), `${b}×${a}`).toEqual({ reason: 'clash', with: b });
    }
  });

  it('with 3 chosen, the others are disabled; the chosen ones can always be deselected', () => {
    const three = ['cafeina', 'games', 'leitura'] as const;
    expect(traitBlock(three, 'series')).toEqual({ reason: 'full' });
    expect(traitBlock(three, 'games')).toBeNull();
    expect(toggleTrait(three, 'series')).toEqual([...three]);
    expect(toggleTrait(three, 'games')).toEqual(['cafeina', 'leitura']);
    expect(toggleTrait(['timidez'], 'piadas')).toEqual(['timidez']);
  });

  it('the 14 traits of the office', () => {
    expect(TRAIT_IDS).toHaveLength(14);
  });
});

describe('character', () => {
  it('sends the 13 pieces (the player has no seed)', () => {
    for (const look of ['f', 'm'] as const) {
      const parts = fullParts(draftAppearance(look));
      expect(Object.keys(parts)).toEqual([...PART_KEYS]);
      expect(Object.values(parts).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    }
  });

  it('the saved pieces come back to the editor the same', () => {
    const parts = fullParts(draftAppearance('m', undefined, 77));
    expect(fullParts(draftAppearance('m', parts))).toEqual(parts);
  });

  it('the first problem: name, then traits, then the phrase', () => {
    expect(characterProblem({ name: 'x', traits: [], intro: null })).toEqual({ field: 'name', problem: 'length' });
    expect(characterProblem({ name: 'Pixel', traits: ['games'], intro: null })).toEqual({ field: 'traits' });
    expect(characterProblem({ name: 'Pixel', traits: ['games', 'cafeina'], intro: null })).toEqual({ field: 'intro' });
    expect(characterProblem({ name: 'Pixel', traits: ['games', 'cafeina'], intro: 'coffee' })).toBeNull();
  });
});

describe('errors', () => {
  it('every code has its own text (none falls to the generic one, except those that say nothing)', () => {
    const generic = worldErrorText('anything', 'status');
    const vague = ['unknown', 'world_error'];
    for (const code of WORLD_UI_ERROR_CODES) {
      const text = worldErrorText(code, 'register');
      expect(text, code).toBeTruthy();
      if (!vague.includes(code)) expect(text, code).not.toBe(generic);
    }
  });

  it('the extra codes of the world server have text', () => {
    expect(worldErrorText('device_limit', 'login')).toBe('This account already has 3 computers; revoke one in Devices.');
    expect(worldErrorText('name_cooldown', 'character')).toMatch(/30 days/);
    expect(worldErrorText('no_player', 'visibility')).toMatch(/character/);
    expect(worldErrorText('unavailable', 'status')).toMatch(/maintenance/);
    expect(worldErrorText('internal', 'character')).toBe('The world server had an error; try again.');
    for (const c of ['invalid_json', 'too_large', 'unsupported_media_type', 'method_not_allowed']) expect(worldErrorText(c, 'login')).toMatch(/format/);
  });

  it('"invalid" says what was refused, according to the action', () => {
    const texts = new Set((['register', 'character', 'visibility', 'revoke'] as const).map((a) => worldErrorText('invalid', a)));
    expect(texts.size).toBe(4);
  });
});

// ------------------------------------------------------------------ Phase 2: building in the world

describe('"Your building" card', () => {
  const NOW = 1_760_000_000_000;
  const live: WorldBuildingStatus = { connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: NOW - 12_000, lastAck: { ok: true } };

  it('state: no character, paused (beats the connection), connected or reconnecting', () => {
    expect(buildingState(live, false)).toBe('no_player');
    expect(buildingState({ ...live, paused: true }, true)).toBe('paused');
    expect(buildingState({ ...live, paused: true, connected: true }, true)).toBe('paused');
    expect(buildingState(live, true)).toBe('connected');
    expect(buildingState({ ...live, connected: false }, true)).toBe('reconnecting');
    expect(buildingState(undefined, true)).toBe('reconnecting');
  });

  it('connected: counts, last upload and the Pause button with the explanation', () => {
    const v = buildingView(live, true, NOW);
    expect(v.label).toBe('Connected');
    expect(v.stats).toEqual(['2 floors', '3 agents', 'Last upload: 12 s ago']);
    expect(v.rejected).toBeNull();
    expect(v.toggle?.action).toBe('pause');
    expect(v.toggle?.text).toBe('Pause');
    expect(v.toggle?.hint).toMatch(/^Pausing stops sending right away and turns the building off in the world\. After 30 days paused/);
  });

  it('no connection: "Connecting…" before the first upload, "Reconnecting…" after', () => {
    expect(buildingView({ ...live, connected: false, lastUplinkAt: undefined }, true, NOW)).toMatchObject({ label: 'Connecting…', stats: ['2 floors', '3 agents', 'No uploads yet'] });
    expect(buildingView({ ...live, connected: false }, true, NOW).label).toBe('Reconnecting…');
  });

  it('paused: Resume button; no character: neither counts nor buttons', () => {
    expect(buildingView({ ...live, paused: true, connected: false }, true, NOW).toggle).toMatchObject({ action: 'resume', text: 'Resume' });
    expect(buildingView(live, false, NOW)).toMatchObject({ state: 'no_player', label: 'No character', stats: [], toggle: null, rejected: null });
  });

  it('singular and plural of the counts', () => {
    expect([floorsText(1), floorsText(0), agentsText(1), agentsText(1200)]).toEqual(['1 floor', '0 floors', '1 agent', '1,200 agents']);
  });

  it('upload refused: the translated reason shows on the card', () => {
    expect(buildingView({ ...live, lastAck: { ok: false, error: 'rate' } }, true, NOW).rejected).toBe(uplinkRejectText('rate'));
  });

  it('out of the world beats everything; paused beats the stop; the stop beats the connection', () => {
    expect(buildingState({ ...live, left: true, paused: true }, true)).toBe('left');
    expect(buildingState({ ...live, paused: true, stopped: 'update' }, true)).toBe('paused');
    expect(buildingState({ ...live, connected: false, stopped: 'update' }, true)).toBe('stopped');
    expect(buildingState({ ...live, left: true }, false)).toBe('no_player');
  });

  it('stopped by the world server: each reason with its own text; "Update Habblaud" and "Connected on another computer"', () => {
    const stopped = (reason: WorldBuildingStop) => buildingView({ ...live, connected: false, stopped: reason }, true, NOW);
    expect(stopped('update')).toMatchObject({ state: 'stopped', label: 'Update Habblaud', toggle: null, leave: true, rejected: null });
    expect(stopped('other-device')).toMatchObject({ label: 'Connected on another computer', toggle: { action: 'resume', text: 'Bring it to this computer' }, leave: true });
    expect(stopped('suspended').toggle).toMatchObject({ action: 'resume', text: 'Try again' });
    expect(stopped('banned')).toMatchObject({ label: 'Account banned', toggle: null, leave: false });
    for (const r of ['waiting', 'no_player', 'unauthorized'] as const) expect(stopped(r)).toMatchObject({ toggle: null, leave: false });
    const reasons: WorldBuildingStop[] = ['banned', 'suspended', 'update', 'other-device', 'waiting', 'no_player', 'unauthorized', 'deleted'];
    const descs = reasons.map((r) => buildingStopView(r).desc);
    expect(new Set(descs).size).toBe(reasons.length);
    // The counts of the last upload remain.
    expect(stopped('update').stats).toEqual(['2 floors', '3 agents', 'Last upload: 12 s ago']);
  });

  it('out of the world: no counts, "Back to the world" and no "Leave the world"; the other states with a building show "Leave the world"', () => {
    expect(buildingView({ ...live, connected: false, paused: true, left: true }, true, NOW)).toMatchObject({
      state: 'left',
      label: 'Out of the world',
      stats: [],
      toggle: { action: 'join', text: 'Back to the world' },
      leave: false,
    });
    expect(buildingView(live, true, NOW).leave).toBe(true);
    expect(buildingView({ ...live, connected: false }, true, NOW).leave).toBe(true);
    expect(buildingView({ ...live, paused: true }, true, NOW).leave).toBe(true);
    expect(buildingView(live, false, NOW).leave).toBe(false);
    // The explanation tells the difference between pausing and leaving (PLANO.md, 2.6).
    expect(leaveHint()).toMatch(/^Pausing turns the building off and keeps the lot.*Leaving the world removes the building right away and frees the lot/);
  });
});

describe('refusal reasons for an upload', () => {
  it('each reason has its own text; an unknown code gets the generic one', () => {
    const generic = uplinkRejectText('does_not_exist');
    expect(uplinkRejectText(undefined)).toBe(generic);
    expect(uplinkRejectText('unknown')).toBe(generic);
    const texts = UPLINK_REJECT_CODES.map((c) => uplinkRejectText(c));
    expect(new Set([...texts, generic]).size).toBe(UPLINK_REJECT_CODES.length + 1);
    expect(UPLINK_REJECT_CODES).toEqual(['schema', 'limits', 'name_pool', 'parts', 'ids', 'rate', 'internal', 'left', 'implausible']);
  });

  it('"See what was sent" window: accepted, refused with a reason or no response', () => {
    expect(ackView({ ok: true, at: 1 })).toEqual({ kind: 'accepted', label: 'Accepted by the world.', reason: null });
    // With the bytes the world counted: equal to the ones sent, or its number.
    expect(ackView({ ok: true, at: 1, bytes: 1174 }, 1174).reason).toBe('The world received the same 1,174 bytes.');
    expect(ackView({ ok: true, at: 1, bytes: 1 }, 2).reason).toBe('The world counted 1 byte.');
    expect(bytesText(0)).toBe('0 bytes');
    expect(ackView({ ok: false, error: 'name_pool', at: 1 })).toEqual({ kind: 'rejected', label: 'Rejected by the world.', reason: uplinkRejectText('name_pool') });
    expect(ackView(undefined).kind).toBe('pending');
  });

  it('the JSON in the window is the same object, with a 2-space indent', () => {
    const text = prettyUplink(FAKE_UPLINK);
    expect(JSON.parse(text)).toEqual(FAKE_UPLINK);
    expect(text.split('\n')[1]).toBe('  "v": 1,');
  });
});

describe('theme and top chip', () => {
  const building = { connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: 1 };

  it('the theme goes to the building only with the approved account and the page that changes the account', () => {
    expect(themeGoesToWorld(meta('approved'), LOCAL)).toBe(true);
    expect(themeGoesToWorld(meta('waiting'), LOCAL)).toBe(false);
    expect(themeGoesToWorld(meta('approved', { enabled: false }), LOCAL)).toBe(false);
    expect(themeGoesToWorld(meta('approved'), { ...LOCAL, terminal: false })).toBe(false);
    expect(themeGoesToWorld(meta('approved'), { ...LOCAL, remote: true })).toBe(false);
    expect(themeGoesToWorld(meta('approved'), { remote: false, local: false, terminal: false, fake: true })).toBe(true);
    expect(themeGoesToWorld(undefined, LOCAL)).toBe(false);
  });

  it('chip: only with the building; paused, in the world or reconnecting; never through the phone port', () => {
    expect(worldChipState(meta('approved'), LOCAL)).toBeNull();
    expect(worldChipState(meta('approved', { building }), LOCAL)).toBe('live');
    expect(worldChipState(meta('approved', { building: { ...building, paused: true, connected: false } }), LOCAL)).toBe('paused');
    expect(worldChipState(meta('approved', { building: { ...building, connected: false } }), LOCAL)).toBe('reconnecting');
    // Stopped by the world server: "stopped" (the reason is on the card); out of the world: nothing.
    expect(worldChipState(meta('approved', { building: { ...building, connected: false, stopped: true } }), LOCAL)).toBe('stopped');
    expect(worldChipState(meta('approved', { building: { ...building, connected: false, paused: true, left: true } }), LOCAL)).toBeNull();
    // With no connection and no upload at all, the building is not in the world yet.
    expect(worldChipState(meta('approved', { building: { ...building, connected: false, lastUplinkAt: undefined } }), LOCAL)).toBeNull();
    expect(worldChipState(meta('approved', { building }), { ...LOCAL, remote: true })).toBeNull();
    expect(worldChipState(meta('waiting', { building }), LOCAL)).toBeNull();
    // Opened from another address (without the lock), the chip informs; the section explains that the account is only
    // handled from the computer.
    expect(worldChipState(meta('approved', { building }), { ...LOCAL, local: false })).toBe('live');
  });
});

describe('visitors in your building (Phase 4)', () => {
  it('the "Your building" card shows "N visitors now" only with someone inside', () => {
    const b: WorldBuildingStatus = { connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: 1 };
    expect(buildingView({ ...b, visitors: 3 }, true, 2).stats).toContain('👀 3 visitors now');
    expect(buildingView({ ...b, visitors: 1 }, true, 2).stats).toContain('👀 1 visitor now');
    expect(buildingView({ ...b, visitors: 0 }, true, 2).stats.some((t) => t.includes('visitor'))).toBe(false);
    expect(buildingView(b, true, 2).stats.some((t) => t.includes('visitor'))).toBe(false);
  });

  it('the notice: once per connection, when it goes from none to some; the first count of the page does not notify; off, never', () => {
    let s = VISITOR_ALERT_START;
    const step = (v: number | undefined, enabled = true) => {
      const r = nextVisitorAlert(s, v, enabled);
      s = r.state;
      return r.notify;
    };
    // the page opened with people inside: no notice
    expect(step(2)).toBe(false);
    expect(step(0)).toBe(false);
    // the first of this connection already went by (was there on opening): the next one doesn't notify
    expect(step(1)).toBe(false);
    // the connection dropped and came back: rearms
    expect(step(undefined)).toBe(false);
    expect(step(0)).toBe(false);
    expect(step(1)).toBe(true);
    expect(step(2)).toBe(false);
    expect(step(0)).toBe(false);
    expect(step(1)).toBe(false);
    // turned off in Settings
    s = VISITOR_ALERT_START;
    expect(step(0, false)).toBe(false);
    expect(step(1, false)).toBe(false);
    // page opened with nobody, then someone enters
    s = VISITOR_ALERT_START;
    expect(step(undefined)).toBe(false);
    expect(step(0)).toBe(false);
    expect(step(3)).toBe(true);
  });
});

describe('account and data (Phase 6)', () => {
  const NOW = 1_760_000_000_000;
  const live: WorldBuildingStatus = { connected: true, paused: false, floors: 2, agents: 3, lastUplinkAt: NOW - 12_000, lastAck: { ok: true } };

  it('"Account and data" is a screen for those who have an account', () => {
    expect(screensFor('approved')).toContain('account');
    expect(screensFor('waiting')).toContain('account');
    expect(screensFor('logged_out')).not.toContain('account');
  });

  it('appeal by email: mailto with the fixed subject and the account id when it is known (only a clean id)', () => {
    expect(APPEAL_EMAIL).toBe('privacidade@habblaud.com');
    expect(appealMailto()).toBe('mailto:privacidade@habblaud.com?subject=Recurso%20Habblaud%20World');
    expect(appealMailto('acc_1')).toBe('mailto:privacidade@habblaud.com?subject=Recurso%20Habblaud%20World%20acc_1');
    expect(appealMailto('x&cc=a@b.co')).toBe(appealMailto());
  });

  it('account suspended or banned: "Appeal by e-mail"; the other stops, no', () => {
    const stopped = (reason: WorldBuildingStop) => buildingView({ ...live, connected: false, stopped: reason }, true, NOW);
    for (const r of ['banned', 'suspended'] as const) expect(stopped(r).appeal).toMatchObject({ text: 'Appeal by e-mail', hint: expect.stringContaining(APPEAL_EMAIL) });
    for (const r of ['update', 'other-device', 'waiting', 'no_player', 'unauthorized', 'deleted'] as const) expect(stopped(r).appeal, r).toBeNull();
    expect(stopped('deleted')).toMatchObject({ label: 'Account deleted', toggle: null, leave: false });
    expect(buildingView(live, true, NOW)).toMatchObject({ appeal: null, unverified: null });
  });

  it('unverified: the badge with "Dispute by e-mail" while the building is in the world; the city label', () => {
    const v = buildingView({ ...live, unverified: true }, true, NOW);
    expect(v.unverified).toMatch(/unverified/);
    expect(v.appeal).toMatchObject({ text: 'Dispute by e-mail' });
    expect(buildingView({ ...live, unverified: true, paused: true }, true, NOW).appeal?.text).toBe('Dispute by e-mail');
    expect(buildingView({ ...live, unverified: true, left: true }, true, NOW)).toMatchObject({ unverified: null, appeal: null });
    // Suspended outweighs the badge: the appeal is for the suspension.
    expect(buildingView({ ...live, connected: false, unverified: true, stopped: 'suspended' }, true, NOW)).toMatchObject({ unverified: null, appeal: { text: 'Appeal by e-mail' } });
    expect(unverifiedLabel()).toBe('Unverified');
    expect(unverifiedHint()).toMatch(/review/);
  });

  it('maintenance: with no connection, the card says the world is under maintenance; connected, it does not', () => {
    const down = { ...live, connected: false };
    expect(buildingView(down, true, NOW, { maintenance: true })).toMatchObject({ state: 'reconnecting', label: 'Under maintenance', desc: "The world is under maintenance; we'll try again in a moment." });
    expect(buildingView(down, true, NOW).label).toBe('Reconnecting…');
    expect(buildingView(live, true, NOW, { maintenance: true }).label).toBe('Connected');
    expect(worldErrorText('maintenance', 'status')).toBe("The world is under maintenance; we'll try again in a moment.");
  });

  it('texts: export once a day, account deleted, inactivity warning on by default', () => {
    expect(worldErrorText('rate_limited', 'export')).toMatch(/once a day/);
    expect(worldErrorText('rate_limited', 'login')).toMatch(/a few minutes/);
    expect(worldErrorText('account_deleted', 'status')).toMatch(/7 days.*30/);
    expect(worldErrorText('invalid', 'inactivity')).toBe(worldErrorText('invalid', 'visibility'));
    expect(notifyInactivityOn(undefined)).toBe(true);
    expect(notifyInactivityOn({})).toBe(true);
    expect(notifyInactivityOn({ notifyInactivity: false })).toBe(false);
    expect(EXPORT_FILENAME).toBe('habblaud-world-dados.json');
  });
});
