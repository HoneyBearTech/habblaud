// Caixa de mensagem (ui/composer.ts), parte pura e testada em ui/composer-model.test.ts: quando a caixa aparece (e
// por que não), o que a tecla Enter faz, a linha de situação de cada envio e o ritmo da consulta da entrega.
// No Codex a mensagem entra na fila da sessão (`codex queue`) e vira prompt quando ela fica ociosa: "Entregue" diz
// isso; sem quem entregue (no Docker, o auxiliar do host), a dica é a do `npm run codex:bridge`.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxStatus, Provider } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Dica para quem tem o recurso ligado, mas a sessão do agente não está com o plugin conectado. */
export const PLUGIN_HINT = tr('To send messages from here: npm run mod:install (plugin habblaud-mensagens)');
/** A mesma dica para um agente do Codex sem entregador (no modo Node o próprio servidor entrega). */
export const CODEX_BRIDGE_HINT = tr('To send messages to Codex: with Habblaud in Docker, keep npm run codex:bridge running; in Node mode it works on its own');

/**
 * - ready: dá para mandar (principal com o plugin conectado, recurso ligado, página local);
 * - hint: recurso ligado e principal presente, mas a sessão não está com o plugin (`text` diz como instalar);
 * - off: não dá (`text` diz por quê). A gaveta esconde a caixa; o terminal mostra o motivo no lugar dela.
 */
export type ComposerMode = { kind: 'ready' } | { kind: 'hint'; text: string } | { kind: 'off'; text: string };

export interface ComposerEnv {
  /** Recurso ligado no servidor (OfficeSnapshot.meta.messages; no ?mock=1, sempre). */
  enabled: boolean;
  /** Página aberta pelo próprio computador (o servidor só aceita mensagens assim). */
  local: boolean;
  /** Timelapse: o escritório mostrado é o do momento reproduzido. */
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

/** Dica embaixo da caixa (gaveta): como a mensagem entra na sessão. */
export function composerTip(provider: Provider = 'claude'): string {
  return provider === 'codex'
    ? tr("Joins the session queue and becomes the next prompt when Codex finishes what it's doing. Enter sends; Shift+Enter adds a new line.")
    : tr('Goes into the session as if you had typed it. Enter sends; Shift+Enter adds a new line.');
}

/** O que sai da caixa: o texto como foi digitado, sem os espaços e linhas em branco do fim. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, '');
}

export function canSend(raw: string): boolean {
  const text = messageText(raw);
  return text.trim().length > 0 && text.length <= MESSAGE_MAX;
}

/** Enter manda; Shift+Enter (e Alt+Enter) quebram a linha; Enter compondo um acento (IME) não conta. */
export function enterSends(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

/**
 * Situação do último envio de um agente: `sending` (o POST ainda não voltou), `rejected` (o servidor recusou: o texto
 * fica na caixa) ou a situação da mensagem no servidor (OutboxStatus).
 */
export type SendPhase = 'sending' | 'rejected' | OutboxStatus;

export interface SendState {
  phase: SendPhase;
  /** Id da mensagem no servidor (depois do 201). */
  id?: string;
  error?: string;
  /** Última mudança (epoch ms, relógio da página). */
  at: number;
}

export function isSettled(phase: SendPhase): boolean {
  return phase === 'delivered' || phase === 'failed' || phase === 'rejected';
}

/** "Entregue" some sozinho depois deste tempo; erros ficam até o próximo envio. */
export const DELIVERED_SHOW_MS = 12_000;

/** Texto da linha de situação ('' = nada a mostrar). */
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
      // Entregue = entrou na sessão ou na fila dela (com o agente ocupado, só entra quando ele terminar o turno). No
      // Codex é sempre a fila: o dono da sessão a consulta a cada ~10 s e só a usa com a sessão ociosa.
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

/** Consulta da entrega: o servidor leva até ~90 s para desistir (60 s na fila + 30 s sem confirmação). */
export const POLL_LIMIT_MS = 120_000;

/** Espera até a próxima consulta: rápida no começo (a sessão busca a cada 2 s), mais espaçada depois. */
export function pollDelay(elapsed: number): number {
  if (elapsed < 10_000) return 700;
  if (elapsed < 40_000) return 1_500;
  return 3_000;
}

export const LOST_ERROR = tr('Habblaud no longer knows this message (did it restart?)');
export const TIMEOUT_ERROR = tr('no word on delivery: check the Claude Code terminal');
export const CODEX_TIMEOUT_ERROR = tr('no word on delivery: check Codex');
export const OFFLINE_ERROR = tr("couldn't reach Habblaud");

/** Prazo da consulta acabou sem notícia: onde conferir. */
export function timeoutError(provider: Provider = 'claude'): string {
  return provider === 'codex' ? CODEX_TIMEOUT_ERROR : TIMEOUT_ERROR;
}
