// Habblaud World na interface, parte pura (sem DOM): quando a janela do World e os popups de lançamento
// aparecem, a máquina de estados da seção, as regras de senha, nome de jogador e traços e o texto de cada erro. São
// conferências de antemão, para responder na hora: quem decide é o servidor (o nome, por exemplo, ainda passa pela
// lista de palavras bloqueadas, que só ele tem). Também o cartão "Seu prédio" (Fase 2): estado, contagens, motivo de
// uma remessa recusada, o chip da barra do topo e quando o tema vai para o mundo. Fase 6: a tela "Conta e dados" (aviso
// de inatividade, baixar os dados, excluir a conta), o recurso por e-mail (conta suspensa ou banida, prédio "não
// verificado") e a manutenção do mundo. A interface fica em settings-world.ts, building.ts, world-chip.ts e
// world-popups.ts.
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

// ------------------------------------------------------------------ quando aparece

/**
 * - hidden: nada do World (sem `meta.world`, `enabled: false`, sem servidor do World configurado, que é o padrão:
 *   o recurso fica desligado e nada aparece; ou a página do celular pela porta remota);
 * - local_only: aberto por outro endereço ou sem a trava do terminal: as rotas da conta respondem 403;
 * - active: dá para criar conta, entrar, editar o personagem...
 */
export type WorldSectionMode = 'hidden' | 'local_only' | 'active';

export interface WorldGate {
  /** Página do celular (porta remota com login). */
  remote: boolean;
  /** Página aberta pelo próprio computador (Host local). */
  local: boolean;
  /** meta.terminal: o Habblaud só é acessível pelo próprio computador (a trava das ações da conta). */
  terminal: boolean;
  /** Modo demonstração com o FakeWorldApi: sem servidor, nenhuma trava vale. */
  fake: boolean;
}

export function worldSectionMode(meta: WorldMeta | undefined, gate: WorldGate): WorldSectionMode {
  if (!meta?.enabled || !meta.configured || meta.state === 'off' || gate.remote) return 'hidden';
  if (!gate.fake && (!gate.local || !gate.terminal)) return 'local_only';
  return 'active';
}

// ------------------------------------------------------------------ os popups de lançamento (world-popups.ts)

/**
 * O personagem já foi criado? O servidor local só põe `scene` (e `building`) no meta.world com a conta liberada e o
 * personagem criado (server/world/service.ts: `hasBuilding`); o modo demonstração faz o mesmo. Antes disso o meta não
 * diz nada do personagem (o snapshot vai ao celular e à linha do tempo), e é isso que basta aqui.
 */
export function hasCharacter(meta: WorldMeta | undefined): boolean {
  return !!meta && (meta.scene !== undefined || meta.building !== undefined);
}

/** Chave do cartão de convite antigo (até a 0.11): só o valor `never` ("Não mostrar de novo") continua valendo. */
export const INVITE_SEEN_KEY = 'habblaud:world-invite-seen';
/** Popup de lançamento: JSON `{shown, last}` (quantas vezes apareceu e quando foi a última, em ms) ou `never`. */
export const LAUNCH_KEY = 'habblaud:world-launch';
/** Popup "Você está na lista de espera": `1` depois de aparecer. */
export const WAITLIST_SEEN_KEY = 'habblaud:world-waitlist-seen';
/** Popup "Acesso liberado!": `1` depois de aparecer. */
export const APPROVED_SEEN_KEY = 'habblaud:world-approved-seen';

/** "Agora não": o popup de lançamento volta depois de 3 dias... */
export const LAUNCH_RETURN_MS = 3 * 24 * 60 * 60 * 1000;
/** ...e aparece no máximo 3 vezes no total (a primeira e dois lembretes). */
export const LAUNCH_MAX_SHOWS = 3;

export type WorldPopupKind = 'launch' | 'waitlist' | 'approved';

/** O que este navegador já viu dos popups (localStorage; sem ele, vale só para a página). */
export interface WorldPopupMemory {
  /** Lançamento: quantas vezes apareceu e quando foi a última; `never` = "Não mostrar de novo" ou conta criada. */
  launch: { shown: number; last: number } | 'never' | null;
  waitlistSeen: boolean;
  approvedSeen: boolean;
}

export interface WorldPopupDecision {
  show: WorldPopupKind | null;
  /** A memória depois desta leitura (com o popup contado), ou null se nada muda. */
  memory: WorldPopupMemory | null;
}

export const EMPTY_POPUP_MEMORY: WorldPopupMemory = { launch: null, waitlistSeen: false, approvedSeen: false };

/** Lê a memória dos popups das chaves cruas (a antiga `never` vale como "nunca"; `shown` não bloqueia o lançamento novo). */
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
      // valor torto: como se nunca tivesse aparecido
    }
  }
  return { launch, waitlistSeen: raw.waitlist !== null, approvedSeen: raw.approved !== null };
}

/** O que gravar em cada chave (null = apagar). */
export function serializePopupMemory(m: WorldPopupMemory): { launch: string | null; waitlist: string | null; approved: string | null } {
  return {
    launch: m.launch === 'never' ? 'never' : m.launch ? JSON.stringify(m.launch) : null,
    waitlist: m.waitlistSeen ? '1' : null,
    approved: m.approvedSeen ? '1' : null,
  };
}

/**
 * Qual popup do Habblaud World mostrar agora (um só por vez, pelo estado da conta), e o que gravar na memória:
 * - launch: sem conta ("Novidade: Habblaud World"); volta a cada 3 dias até 3 vezes, ou nunca mais depois de
 *   "Não mostrar de novo" ou de uma conta criada (qualquer estado diferente de `logged_out` grava `never`);
 * - waitlist: na lista de espera, uma vez por navegador (logo depois do cadastro ou ao abrir a página já na espera);
 * - approved: acesso liberado e personagem ainda não criado, uma vez por navegador.
 * Só pelo próprio computador com o servidor do World configurado; nunca no timelapse, no modo demonstração ou pela
 * porta do celular. A memória é gravada quando o popup aparece (fechar a página com ele aberto conta).
 */
export function nextWorldPopup(meta: WorldMeta | undefined, gate: WorldGate & { replaying: boolean }, memory: WorldPopupMemory, now: number): WorldPopupDecision {
  if (gate.fake || gate.replaying || worldSectionMode(meta, gate) !== 'active' || !meta) return { show: null, memory: null };
  if (meta.state === 'logged_out') {
    const l = memory.launch;
    if (l === 'never') return { show: null, memory: null };
    if (l && (l.shown >= LAUNCH_MAX_SHOWS || now - l.last < LAUNCH_RETURN_MS)) return { show: null, memory: null };
    return { show: 'launch', memory: { ...memory, launch: { shown: (l?.shown ?? 0) + 1, last: now } } };
  }
  // Com conta (na espera ou liberada), o lançamento nunca mais aparece.
  const base: WorldPopupMemory = memory.launch === 'never' ? memory : { ...memory, launch: 'never' };
  const changed = base !== memory;
  if (meta.state === 'waiting' && !memory.waitlistSeen) return { show: 'waitlist', memory: { ...base, waitlistSeen: true } };
  if (meta.state === 'approved' && !memory.approvedSeen && !hasCharacter(meta)) return { show: 'approved', memory: { ...base, approvedSeen: true } };
  return { show: null, memory: changed ? base : null };
}

// ------------------------------------------------------------------ máquina de estados da seção

export type WorldScreen =
  // sem conta (state 'logged_out')
  | 'welcome'
  | 'register'
  | 'login'
  | 'verify'
  | 'forgot'
  | 'reset'
  // com conta ('waiting' ou 'approved')
  | 'home'
  | 'character'
  | 'visibility'
  | 'devices'
  // "Conta e dados" (Fase 6): aviso de inatividade, baixar os dados e excluir a conta
  | 'account'
  // Bloqueados (Fase 5): quem você bloqueou, para desbloquear
  | 'blocked';

/** Aviso curto no topo da seção depois de uma ação (some na próxima navegação). */
export type WorldFlash = 'code_sent' | 'code_resent' | 'password_changed' | 'signed_out' | 'character_saved' | 'device_revoked';

export interface WorldUi {
  /** Estado da conta segundo o último GET /api/world/status (antes dele, o do snapshot). */
  server: WorldServerState | null;
  screen: WorldScreen;
  /** E-mail digitado: passa do cadastro para o código, do "esqueci a senha" para a senha nova e para o login. */
  email: string;
  /** Nome de jogador digitado no cadastro: volta preenchido se a pessoa voltar da tela do código. */
  name: string;
  flash: WorldFlash | null;
}

export type WorldUiEvent =
  | { type: 'server'; state: WorldServerState }
  | { type: 'go'; screen: WorldScreen }
  /** Cadastro aceito (com o nome de jogador reservado) ou login de e-mail ainda não confirmado: o código foi para o e-mail. */
  | { type: 'code_sent'; email: string; name?: string }
  /** "Esqueci a senha": o código da senha nova foi para o e-mail. */
  | { type: 'reset_code_sent'; email: string }
  | { type: 'password_changed' }
  /** Entrou (código confirmado ou login): o aviso da tela de entrada não vale mais. */
  | { type: 'signed_in' }
  | { type: 'flash'; flash: WorldFlash };

const SIGNED_OUT: readonly WorldScreen[] = ['welcome', 'register', 'login', 'verify', 'forgot', 'reset'];
const SIGNED_IN: readonly WorldScreen[] = ['home', 'character', 'visibility', 'devices', 'account', 'blocked'];

/** Telas possíveis em cada estado da conta (a primeira é a de entrada). */
export function screensFor(state: WorldServerState): readonly WorldScreen[] {
  if (state === 'waiting' || state === 'approved') return SIGNED_IN;
  if (state === 'logged_out') return SIGNED_OUT;
  return [];
}

export function initialWorldUi(): WorldUi {
  return { server: null, screen: 'welcome', email: '', name: '', flash: null };
}

/** A tela continua valendo para o estado da conta? Senão, volta para a de entrada (ex.: saiu da conta → boas-vindas). */
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

// ------------------------------------------------------------------ e-mail, código e senha

export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim();
}

export function emailLooksValid(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Código do e-mail: só os dígitos do que foi digitado ou colado ("123 456" vale). */
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
 * Regras da senha que dá para conferir sem o servidor: de 12 a 128 caracteres (em NFC), diferente do e-mail e que não
 * seja só repetição ("aaaaaaaaaaaa", "abcabcabcabc"). A lista de senhas vazadas quem confere é o servidor.
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

// ------------------------------------------------------------------ nome de jogador

// Regras e chave de unicidade: shared/world/names-rules.ts (as mesmas do servidor do mundo, menos a lista de palavras
// bloqueadas, que só ele tem). Aqui fica só o texto de cada motivo.

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

// ------------------------------------------------------------------ traços

// Ids, rótulos, pares que não combinam e a validação da escolha: shared/world/traits.ts (os mesmos do servidor).

/**
 * Dá para marcar o traço `t` com os já escolhidos? Os escolhidos sempre dá (para desmarcar); os outros não quando já
 * há 3 ou quando não combinam com um deles (`with` diz qual).
 */
export function traitBlock(selected: readonly TraitId[], t: TraitId): { reason: 'full' } | { reason: 'clash'; with: TraitId } | null {
  if (selected.includes(t)) return null;
  const clash = selected.find((s) => traitsClash(s, t));
  if (clash) return { reason: 'clash', with: clash };
  if (selected.length >= PLAYER_TRAITS.max) return { reason: 'full' };
  return null;
}

/** Marca ou desmarca (sem efeito se o traço estiver bloqueado). */
export function toggleTrait(selected: readonly TraitId[], t: TraitId): TraitId[] {
  if (selected.includes(t)) return selected.filter((s) => s !== t);
  return traitBlock(selected, t) ? [...selected] : [...selected, t];
}

/** 2 ou 3 traços conhecidos, sem repetição e sem pares que não combinam (parsePlayerTraits, a regra do servidor). */
export function traitsValid(traits: readonly unknown[]): traits is TraitId[] {
  return parsePlayerTraits(traits) !== null;
}

// ------------------------------------------------------------------ personagem

/** Semente fixa do rascunho: o jogador não tem semente (vale o `parts` completo), então ela só dá o ponto de partida. */
export const PLAYER_DRAFT_SEED = 0x5eed;

/**
 * Todas as peças da aparência (as 13 de PART_KEYS). O personagem do mundo vai sem semente: um `parts` parcial seria
 * completado de outro jeito em cada lugar que o desenha.
 */
export function fullParts(a: Appearance): AppearanceParts {
  const full: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = k === 'facialHair' ? (a.facialHair ?? 'none') : k === 'bottomStyle' ? (a.bottomStyle ?? 'pants') : a[k];
    full[k] = v;
  }
  return full as AppearanceParts;
}

/** Aparência de partida do editor: a do personagem salvo (peças por cima da semente fixa) ou um sorteio. */
export function draftAppearance(look: 'f' | 'm', parts?: AppearanceParts, seed = PLAYER_DRAFT_SEED): Appearance {
  return appearanceFromSeed(seed, { look, parts });
}

export type CharacterProblem = { field: 'name'; problem: PlayerNameProblem } | { field: 'traits' } | { field: 'intro' };

/** O que falta para salvar o personagem (o primeiro problema), ou null. */
export function characterProblem(d: { name: string; traits: readonly TraitId[]; intro: string | null }): CharacterProblem | null {
  const name = parsePlayerName(d.name);
  if (!name.ok) return { field: 'name', problem: name.problem };
  if (!traitsValid(d.traits)) return { field: 'traits' };
  if (!d.intro || !isIntroId(d.intro)) return { field: 'intro' };
  return null;
}

// ------------------------------------------------------------------ visibilidade

export const DEFAULT_VISIBILITY: Readonly<WorldVisibility> = {
  mode: 'live',
  closed: false,
  hideCountry: false,
  tokensVisible: true,
  leaderboard: false,
  compactions: false,
  knocks: false,
};

/** Os interruptores da tela de visibilidade (o aviso de inatividade fica em "Conta e dados"). */
export type VisibilitySwitch = Exclude<keyof WorldVisibility, 'mode' | 'notifyInactivity'>;

/** Ordem dos interruptores na tela. */
export const VISIBILITY_SWITCHES: readonly VisibilitySwitch[] = ['closed', 'hideCountry', 'tokensVisible', 'leaderboard', 'compactions', 'knocks'];

// ------------------------------------------------------------------ conta e dados (Fase 6)

/** O aviso por e-mail antes de retirar o prédio por inatividade está ligado? Sem a informação, o padrão da conta: sim. */
export function notifyInactivityOn(v: Pick<WorldVisibility, 'notifyInactivity'> | undefined): boolean {
  return v?.notifyInactivity !== false;
}

/** Nome do arquivo de "Baixar meus dados" (o mesmo do anexo de GET /api/world/export). */
export const EXPORT_FILENAME = 'habblaud-world-dados.json';

/** Para onde vão os recursos (conta suspensa ou banida, prédio "não verificado") e os pedidos sobre os dados. */
export const APPEAL_EMAIL = 'privacidade@habblaud.com';

/** Assunto fixo do recurso (em português: é o filtro da caixa de quem atende), com o id da conta quando se sabe. */
export const APPEAL_SUBJECT = 'Recurso Habblaud World';

/** O link "Recorrer por e-mail": mailto para APPEAL_EMAIL com o assunto e, se houver, o id da conta. */
export function appealMailto(accountId?: string): string {
  const id = accountId && /^[A-Za-z0-9_-]{1,64}$/.test(accountId) ? accountId : '';
  return `mailto:${APPEAL_EMAIL}?subject=${encodeURIComponent(id ? `${APPEAL_SUBJECT} ${id}` : APPEAL_SUBJECT)}`;
}

/** O selo de um prédio marcado como "não verificado" (WorldBuildingPublic.unverified), para o cartão da cidade. */
export function unverifiedLabel(): string {
  return tr('Unverified');
}

/** O que o selo quer dizer, para quem vê o prédio na cidade (dica do selo no cartão). */
export function unverifiedHint(): string {
  return tr("This building's numbers looked unusual and are under review; meanwhile, it stays out of leaderboards and highlights.");
}

// ------------------------------------------------------------------ erros

/** O que a interface estava fazendo: o mesmo código ("invalid") quer dizer coisas diferentes em cada ação. */
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
  /** Um comando da cena Mundo (POST /api/world/cmd) recusado pelo servidor local. */
  | 'scene'
  /** "Baixar meus dados" (GET /api/world/export). */
  | 'export'
  /** "Excluir conta" (pedir o código ou confirmar). */
  | 'delete'
  /** O aviso de inatividade (PUT /api/world/visibility). */
  | 'inactivity'
  /** Fase 5: "Enquanto você estava fora" visto e Desbloquear. */
  | 'summary'
  | 'unblock';

/**
 * Texto de um erro (o `message` do servidor, em inglês, nunca aparece). O switch cobre todo WorldErrorCode (o
 * compilador cobra um texto para cada código novo); um código que esta versão não conhece leva o texto genérico.
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

// ------------------------------------------------------------------ prédio no mundo (Fase 2)

/**
 * Estado do cartão "Seu prédio" (conta aprovada). Sem personagem o prédio não entra no mundo; fora do mundo ("Sair do
 * mundo") e pausado valem mais do que a conexão (nos dois nenhum pacote sobe); depois, uma parada pedida pelo servidor do
 * mundo (`stopped`, com o motivo); sem conexão aberta, o Habblaud está conectando ou tentando de novo.
 */
export type BuildingState = 'connected' | 'reconnecting' | 'paused' | 'stopped' | 'left' | 'no_player';

export function buildingState(b: WorldBuildingStatus | undefined, hasPlayer: boolean): BuildingState {
  if (!hasPlayer) return 'no_player';
  if (b?.left) return 'left';
  if (b?.paused) return 'paused';
  if (b?.stopped) return 'stopped';
  return b?.connected ? 'connected' : 'reconnecting';
}

/** O que o cartão diz quando o servidor do mundo parou o prédio (`goodbye`), por motivo. */
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
 * Motivos com que o servidor do mundo recusa uma remessa (`uplink.ack {error}`, UPLINK_ACK_ERRORS do protocolo); um
 * código que esta versão não conhece chega como `internal` (net/world.ts) e um fora da lista vira o genérico.
 */
export const UPLINK_REJECT_CODES = UPLINK_ACK_ERRORS;

/** Por que o mundo recusou a remessa, em uma frase. */
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
  /** Selo do estado ("Conectado", "Pausado"...). */
  label: string;
  /** O que o estado quer dizer, em uma ou duas frases. */
  desc: string;
  /** "2 andares", "3 agentes", "Última remessa: há 12 s" (vazio sem personagem). */
  stats: string[];
  /** Motivo da recusa da última remessa (null: aceita ou sem resposta ainda). */
  rejected: string | null;
  /** Texto do botão de pausa e a explicação dele (null: sem botão). */
  toggle: { action: 'pause' | 'resume' | 'join'; text: string; hint: string } | null;
  /** Mostra "Sair do mundo" (há um prédio no mundo para retirar). */
  leave: boolean;
  /** O prédio está marcado como "não verificado" (o que isso quer dizer, para o dono), ou null. */
  unverified: string | null;
  /** "Recorrer por e-mail" (conta suspensa ou banida) ou "Contestar por e-mail" (não verificado), ou null. */
  appeal: { text: string; hint: string } | null;
}

/** O que o cartão sabe além do prédio: a manutenção do mundo (o último /v1/me respondeu 503 `maintenance`). */
export interface BuildingViewOptions {
  maintenance?: boolean;
}

/** "Recorrer por e-mail", com a explicação ao lado. */
function appealFor(kind: 'appeal' | 'contest'): { text: string; hint: string } {
  return kind === 'appeal'
    ? { text: tr('Appeal by e-mail'), hint: tr('Opens an e-mail to {0}: tell us what happened, and a person reviews the case.', [APPEAL_EMAIL]) }
    : { text: tr('Dispute by e-mail'), hint: tr("Opens an e-mail to {0}: if it's a mistake, a person reviews the numbers and removes the badge.", [APPEAL_EMAIL]) };
}

/** "1 byte", "1.174 bytes". */
export function bytesText(n: number): string {
  return n === 1 ? tr('1 byte') : tr('{0} bytes', [formatInt(n)]);
}

/** "1 andar", "3 andares". */
export function floorsText(n: number): string {
  return n === 1 ? tr('1 floor') : tr('{0} floors', [formatInt(n)]);
}

/** "1 agente", "3 agentes". */
export function agentsText(n: number): string {
  return n === 1 ? tr('1 agent') : tr('{0} agents', [formatInt(n)]);
}

/** "1 visitante agora", "3 visitantes agora". */
export function visitorsText(n: number): string {
  return n === 1 ? tr('1 visitor now') : tr('{0} visitors now', [formatInt(n)]);
}

/**
 * O aviso "Alguém entrou no seu prédio": uma vez por conexão, quando a contagem de visitantes (meta.world.building
 * .visitors) passa de nenhum a algum. Sem contagem (a conexão caiu, fechado a visitas), o aviso se rearma. A primeira
 * contagem que esta página vê não avisa (a visita já estava lá antes de abrir a página).
 */
export interface VisitorAlertState {
  /** Já viu uma contagem (ou a falta dela) nesta página. */
  started: boolean;
  /** A última contagem (undefined: sem contagem). */
  last: number | undefined;
  /** Já avisou nesta conexão. */
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

/** Tudo o que o cartão "Seu prédio" mostra, sem DOM. */
export function buildingView(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number, opts: BuildingViewOptions = {}): BuildingView {
  const v = buildingViewBase(b, hasPlayer, now, opts);
  // Suspensa ou banida: o recurso por e-mail. Não verificado (e o prédio ainda no mundo): o selo e a contestação.
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
      // Sem conexão e o mundo em manutenção (503 `maintenance`): o Habblaud tenta de novo com espera.
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

/** A diferença entre pausar e sair do mundo (PLANO.md, seção 2.6), ao lado do botão "Sair do mundo". */
export function leaveHint(): string {
  return tr(
    'Pausing turns the building off and keeps the lot: resuming brings it back, in the same place. Leaving the world removes the building right away and frees the lot; the account and the character stay, and coming back later creates a new building, on another lot.',
  );
}

export type AckKind = 'accepted' | 'rejected' | 'pending';

/**
 * A resposta do mundo a uma remessa, para a janela "Ver o que foi enviado". Aceita, com os bytes que o mundo contou
 * (iguais aos enviados, `sentBytes`, quando o pacote chegou inteiro).
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

/** O pacote como a janela mostra: o mesmo objeto que foi para o fio, só com recuo (2 espaços). */
export function prettyUplink(uplink: WorldUplink): string {
  return JSON.stringify(uplink, null, 2);
}

/**
 * A escolha de Aparência › Tema do escritório também vai para o prédio (PUT /api/world/theme)? Só com o World ligado,
 * a conta aprovada e a página onde dá para mexer na conta (a rota é só local).
 */
export function themeGoesToWorld(meta: WorldMeta | undefined, gate: WorldGate): boolean {
  return worldSectionMode(meta, gate) === 'active' && meta?.state === 'approved';
}

export type WorldChipState = 'live' | 'paused' | 'reconnecting' | 'stopped';

/**
 * Chip da barra do topo ("🏙️ no mundo" / "⏸ pausado" / "⚠️ parado"): só com `meta.world.building` (conta aprovada) e
 * nunca pela porta do celular. Fora do mundo, nada. Parado pelo servidor do mundo, "parado" (o motivo fica no cartão).
 * Sem conexão, só aparece se o prédio já mandou alguma remessa (antes disso não está no mundo).
 */
export function worldChipState(meta: WorldMeta | undefined, gate: WorldGate): WorldChipState | null {
  const b = meta?.building;
  if (!b || b.left || meta.state !== 'approved' || worldSectionMode(meta, gate) === 'hidden') return null;
  if (b.paused) return 'paused';
  if (b.stopped) return 'stopped';
  if (b.connected) return 'live';
  return b.lastUplinkAt ? 'reconnecting' : null;
}
