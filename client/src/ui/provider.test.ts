import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import {
  accountChipLabel,
  accountProvider,
  codexApprovalLabel,
  DEFAULT_PROVIDER,
  emptyOfficeHint,
  fallbackShort,
  hasCodexPermission,
  isCodex,
  isCopilot,
  isDefaultProvider,
  looksLikeCodexId,
  looksLikeCopilotId,
  PROVIDER_NAME,
  providerOf,
  showsProviderTag,
} from './provider';

describe('tool (Claude Code or Codex)', () => {
  it('missing provider = Claude Code', () => {
    expect(providerOf(undefined)).toBe('claude');
    expect(providerOf({})).toBe('claude');
    expect(providerOf({ provider: 'codex' })).toBe('codex');
    expect(isCodex({ provider: 'codex' })).toBe(true);
    expect(isCodex({ provider: 'claude' })).toBe(false);
    expect(isCodex(null)).toBe(false);
  });

  it('id that looks like a Codex folder (only when the account is no longer in the snapshot)', () => {
    for (const id of ['.codex', 'demo:.codex', '.codex-work', '.codex~2', '/Users/ana/.codex', 'codex']) expect(looksLikeCodexId(id), id).toBe(true);
    for (const id of ['.claude', '.claude-conta2', 'demo:.claude', 'mycodex', '.codexy', '']) expect(looksLikeCodexId(id), id).toBe(false);
    // With the account at hand, its provider wins; without it, the caller's hint and, last, the id.
    expect(accountProvider({ provider: 'codex' }, '.claude')).toBe('codex');
    expect(accountProvider({}, '.codex')).toBe('claude');
    expect(accountProvider(undefined, '.claude', 'codex')).toBe('codex');
    expect(accountProvider(undefined, '.codex')).toBe('codex');
    expect(accountProvider(undefined, 'x')).toBe('claude');
  });

  it('chip letter without the account in the snapshot: never "." or empty', () => {
    expect(fallbackShort('.claude-conta2')).toBe('C');
    expect(fallbackShort('.claude')).toBe('?');
    expect(fallbackShort('.codex')).toBe('X');
    expect(fallbackShort('.codex-work')).toBe('W');
    expect(fallbackShort('.codex~2')).toBe('X');
    expect(fallbackShort('demo:.codex')).toBe('X');
    expect(fallbackShort('my-account')).toBe('M');
    expect(fallbackShort('')).toBe('?');
    expect(fallbackShort('...', 'codex')).toBe('X');
  });

  it('"Codex" badge: only on Codex, and without repeating the account name', () => {
    expect(showsProviderTag('codex', 'Account X')).toBe(true);
    expect(showsProviderTag('codex', 'Codex')).toBe(false);
    expect(showsProviderTag('codex', 'Demo Codex')).toBe(false);
    expect(showsProviderTag('claude', 'Account C')).toBe(false);
  });

  it('chip label: email on Claude Code; tool and plan on Codex', () => {
    expect(accountChipLabel({ name: 'Account C', email: 'a@b.c' }, '.claude', 'claude')).toBe('Account C (a@b.c)');
    expect(accountChipLabel({ name: 'Account X', plan: 'Team', provider: 'codex' }, '.codex', 'codex')).toBe('Account X · Codex · Team plan');
    expect(accountChipLabel({ name: 'Codex', plan: 'Team', provider: 'codex' }, '.codex', 'codex')).toBe('Codex · Team plan');
    expect(accountChipLabel(undefined, '.codex', 'codex')).toBe('.codex · Codex');
    expect(accountChipLabel(undefined, '', 'claude')).toBe('Unknown account');
  });

  it('empty office: shortcuts only for the Claude Code accounts; Codex comes in when it has an account', () => {
    const c = { short: 'C' };
    const d = { short: 'D' };
    const x = { short: 'X', provider: 'codex' as const };
    expect(emptyOfficeHint([c, d])).toBe('Open Claude Code in any project (shortcuts c or d) and watch your agent arrive.');
    expect(emptyOfficeHint([c, d, x])).toBe('Open Claude Code (shortcuts c or d) or Codex in any project and watch your agent arrive.');
    expect(emptyOfficeHint([x])).toBe('Open Claude Code or Codex in any project and watch your agent arrive.');
    expect(emptyOfficeHint([])).toBe('Open Claude Code in any project and watch your agent arrive.');
  });

  it('1 s clock while there is a Codex request waiting', () => {
    const agent = (permission?: AgentInfo['permission'], status: AgentInfo['status'] = 'waiting') => ({ status, permission }) as AgentInfo;
    const p = { id: 'p', tool: 'Bash', title: 'Bash(ls)', text: 'Listing', icon: '💻', createdAt: 0, expiresAt: 25_000 };
    const snap = (agents: AgentInfo[]) => ({ agents }) as Pick<OfficeSnapshot, 'agents'>;
    expect(hasCodexPermission(snap([agent({ ...p, provider: 'codex' })]))).toBe(true);
    expect(hasCodexPermission(snap([agent(p)]))).toBe(false);
    expect(hasCodexPermission(snap([agent({ ...p, provider: 'codex' }, 'offline')]))).toBe(false);
    expect(hasCodexPermission(null)).toBe(false);
  });

  it('Codex approvals in words (unknown value passes as it came)', () => {
    expect(codexApprovalLabel('on-request')).toBe('Asks when needed');
    expect(codexApprovalLabel('never')).toBe('Never asks');
    expect(codexApprovalLabel('other')).toBe('other');
    expect(codexApprovalLabel(undefined)).toBe('—');
  });
});

describe('Copilot accounts and agents', () => {
  it('is its own tool: not the default one, with its own name, badge and fallback letter', () => {
    expect(isCopilot({ provider: 'copilot' })).toBe(true);
    expect(isCopilot({ provider: 'codex' })).toBe(false);
    expect(isDefaultProvider({ provider: 'copilot' })).toBe(false);
    expect(isDefaultProvider({ provider: 'codex' })).toBe(false);
    expect(isDefaultProvider({})).toBe(true);
    expect(isDefaultProvider({ provider: DEFAULT_PROVIDER })).toBe(true);
    expect(PROVIDER_NAME.copilot).toBe('Copilot');
    for (const id of ['.copilot', 'demo:.copilot', '.copilot-work', '.copilot~2', '/home/user/.copilot']) expect(looksLikeCopilotId(id), id).toBe(true);
    for (const id of ['.codex', 'mycopilot', '.copiloted', '']) expect(looksLikeCopilotId(id), id).toBe(false);
    expect(accountProvider(undefined, '.copilot')).toBe('copilot');
    expect(fallbackShort('.copilot-work')).toBe('W');
    expect(fallbackShort('.copilot')).toBe('P');
    expect(showsProviderTag('copilot', 'Work')).toBe(true);
    expect(showsProviderTag('copilot', 'Copilot W')).toBe(false);
  });

  it('chip label and the empty-office shortcuts', () => {
    expect(accountChipLabel({ name: 'Copilot', provider: 'copilot' }, '.copilot', 'copilot')).toBe('Copilot');
    expect(accountChipLabel({ name: 'Work', provider: 'copilot' }, '.copilot', 'copilot')).toBe('Work · Copilot');
    expect(accountChipLabel(undefined, '.copilot', 'copilot')).toBe('.copilot · Copilot');
    // The letter of a Copilot account is not a shell shortcut.
    expect(emptyOfficeHint([{ short: 'P', provider: 'copilot' }])).not.toContain('P');
    // Only Copilot accounts: Copilot is named, after the default tool (as Codex is).
    expect(emptyOfficeHint([{ short: 'P', provider: 'copilot' }])).toMatch(/^Open \S.* or Copilot in any project and watch your agent arrive\.$/);
    expect(emptyOfficeHint([{ short: 'P', provider: 'copilot' }, { short: 'Q', provider: 'copilot' }])).toContain(' or Copilot ');
    expect(emptyOfficeHint([{ short: 'C' }, { short: 'P', provider: 'copilot' }])).not.toContain('Copilot');
  });
});
