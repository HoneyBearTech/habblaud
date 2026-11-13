// Message box (ui/composer.ts), pure part, tested in ui/composer-model.test.ts: when the box shows (and
// why not), what the Enter key does, the status line of each send and the pace of the delivery check.
// In Codex the message goes into the session's queue (`codex queue`) and becomes a prompt when the session goes
// idle: "Delivered" says that; with no one to deliver (in Docker, the host helper), the hint is the
// `npm run codex:bridge` one.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxStatus, Provider } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Hint for those who have the feature on, but the agent's session doesn't have the plugin connected. */
export const PLUGIN_HINT = tr('To send messages from here: npm run mod:install (plugin habblaud-mensagens)');
/** The same hint for a Codex agent with no deliverer (in Node mode the server itself delivers). */
export const CODEX_BRIDGE_HINT = tr('To send messages to Codex: with Habblaud in Docker, keep npm run codex:bridge running; in Node mode it works on its own');

/**
 * - ready: can send (main agent with the plugin connected, feature on, local page);
 * - hint: feature on and main agent present, but the session doesn't have the plugin (`text` says how to install);
 * - off: can't (`text` says why). The drawer hides the box; the terminal shows the reason in its place.
 */
export type ComposerMode = { kind: 'ready' } | { kind: 'hint'; text: string } | { kind: 'off'; text: string };

export interface ComposerEnv {
  /** Feature on in the server (OfficeSnapshot.meta.messages; in ?mock=1, always). */
  enabled: boolean;
  /** Page opened from the computer itself (the server only accepts messages this way). */
  local: boolean;
  /** Timelapse: the office shown is the one from the moment being replayed. */
  replaying: boolean;
}

export function composerMode(agent: AgentInfo | undefined, env: ComposerEnv): ComposerMode {
  if (env.replaying) return { kind: 'off', text: tr('No messages in timelapse: the office shown is from another moment') };
  if (agent?.kind === 'sub') return { kind: 'off', text: tr("Subagents don't receive messages: write to the main agent") };
  if (!agent || agent.status === 'offline' || agent.status === 'done') return { kind: 'off', text: tr('Session ended') };
  const codex = agent.provider === 'codex';
  if (!env.enabled) return { kind: 'off', text: codex ? tr('To reply, use Codex') : tr('To reply, use the Claude Code terminal') };
  if (!env.local) return { kind: 'off', text: tr('To send messages from here, open Habblaud at http://localhost (or 127.0.0.1)') };
  if (!agent.canMessage) return { kind: 'hint', text: codex ? CODEX_BRIDGE_HINT : PLUGIN_HINT };
  return { kind: 'ready' };
}

/** Hint below the box (drawer): how the message enters the session. */
export function composerTip(provider: Provider = 'claude'): string {
  return provider === 'codex'
    ? tr("Joins the session queue and becomes the next prompt when Codex finishes what it's doing. Enter sends; Shift+Enter adds a new line.")
    : tr('Goes into the session as if you had typed it. Enter sends; Shift+Enter adds a new line.');
}

/** What leaves the box: the text as it was typed, without the trailing spaces and blank lines. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, '');
}

export function canSend(raw: string): boolean {
  const text = messageText(raw);
  return text.trim().length > 0 && text.length <= MESSAGE_MAX;
}

/** Enter sends; Shift+Enter (and Alt+Enter) break the line; Enter while composing an accent (IME) doesn't count. */
export function enterSends(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

/**
 * Status of an agent's last send: `sending` (the POST hasn't returned yet), `rejected` (the server refused: the
 * text stays in the box) or the status of the message on the server (OutboxStatus).
 */
export type SendPhase = 'sending' | 'rejected' | OutboxStatus;

export interface SendState {
  phase: SendPhase;
  /** Id of the message on the server (after the 201). */
  id?: string;
  error?: string;
  /** Last change (epoch ms, page clock). */
  at: number;
}

export function isSettled(phase: SendPhase): boolean {
  return phase === 'delivered' || phase === 'failed' || phase === 'rejected';
}

/** "Delivered" goes away by itself after this time; errors stay until the next send. */
export const DELIVERED_SHOW_MS = 12_000;

/** Text of the status line ('' = nothing to show). */
export function sendStatusText(s: SendState | undefined, now: number, provider: Provider = 'claude'): string {
  if (!s) return '';
  const codex = provider === 'codex';
  switch (s.phase) {
    case 'sending':
      return tr('Sending…');
    case 'queued':
      return codex ? tr('Queued: delivering to Codex…') : tr('Queued: waiting for the session to pick up the message…');
    case 'sent':
      return tr('Delivering to the session…');
    case 'delivered':
      // Delivered = entered the session or its queue (with the agent busy, it only enters when it finishes the turn). In
      // Codex it is always the queue: the session's owner checks it every ~10 s and only uses it with the session idle.
      if (now - s.at >= DELIVERED_SHOW_MS) return '';
      return codex
        ? tr("Delivered ✓ to the session queue: goes in when Codex finishes what it's doing (up to ~10 s)")
        : tr('Delivered ✓ (if the agent is busy, it goes in when it finishes)');
    case 'rejected':
      return tr("Couldn't send: {0}", [s.error ?? tr('unknown error')]);
    case 'failed':
      return tr('Not delivered: {0}', [s.error ?? tr('unknown error')]);
  }
}

/** Delivery check: the server takes up to ~90 s to give up (60 s in the queue + 30 s without confirmation). */
export const POLL_LIMIT_MS = 120_000;

/** Wait until the next check: fast at first (the session fetches every 2 s), more spaced out later. */
export function pollDelay(elapsed: number): number {
  if (elapsed < 10_000) return 700;
  if (elapsed < 40_000) return 1_500;
  return 3_000;
}

export const LOST_ERROR = tr('Habblaud no longer knows this message (did it restart?)');
export const TIMEOUT_ERROR = tr('no word on delivery: check the Claude Code terminal');
export const CODEX_TIMEOUT_ERROR = tr('no word on delivery: check Codex');
export const OFFLINE_ERROR = tr("couldn't reach Habblaud");

/** The check's deadline ran out with no news: where to look. */
export function timeoutError(provider: Provider = 'claude'): string {
  return provider === 'codex' ? CODEX_TIMEOUT_ERROR : TIMEOUT_ERROR;
}
