// Which tool each thing belongs to (Claude Code or Codex) and the texts that change with it. Pure (no DOM): tested
// in ui/provider.test.ts. In the protocol, a missing `provider` means Claude Code (shared/types.ts); here everything
// falls back to that.
//
// Codex's visual identity (no one's logo): the account chip is "hollow" (dark background, border and letter in the
// account's color, stepped corners) and, where there is room, a "Codex" text badge next to the name.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Name of each tool as it appears in the texts. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' };

/** Tool of an agent, account, session or request (missing = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isCopilot(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'copilot';
}

/** The tool of a thing without `provider` (the protocol default). */
export const DEFAULT_PROVIDER: Provider = providerOf(undefined);

/** Of the default tool (the one with plugins, shortcuts, messages and approvals); Codex and Copilot are not. */
export function isDefaultProvider(x: { provider?: Provider } | null | undefined): boolean {
  return providerOf(x) === DEFAULT_PROVIDER;
}

/** Copilot CLI folder id (".copilot", ".copilot-work", ".copilot~2", "demo:.copilot"), like looksLikeCodexId. */
export function looksLikeCopilotId(id: string): boolean {
  return /(?:^|[:/\\])\.?copilot(?:[-_.~]|$)/i.test(id);
}

/**
 * Does the account id look like a Codex folder (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Only for
 * when the account is no longer in the snapshot (e.g. history, "My day"): with the account at hand, its `provider`
 * wins.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** The account's tool: the one in the snapshot; without it, the caller's hint or the shape of the id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : looksLikeCopilotId(fallbackId) ? 'copilot' : 'claude');
}

/**
 * Letter of the chip of an account that is not in the snapshot: the first letter after the folder prefix
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). The default Codex folder (".codex") becomes "X"; the
 * Claude Code one, "?" (as before). Never returns "." or empty.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|copilot)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : provider === 'copilot' ? 'P' : '?';
}

/** The "Codex" / "Copilot" badge next to the account name (not repeated when the name already says it). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  if (provider !== 'codex' && provider !== 'copilot') return false;
  return !accountName.toLowerCase().includes(PROVIDER_NAME[provider].toLowerCase());
}

/** Label of the account chip (tooltip and screen readers): "Account C (dev@x.com)", "Codex · Team plan". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${isDefaultProvider({ provider }) ? '' : ` · ${PROVIDER_NAME[provider]}`}` : tr('Unknown account');
  if (isDefaultProvider({ provider })) return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · {0} plan', [account.plan]) : ''}`;
}

/**
 * Text of the empty office. The shortcuts ("shortcuts c or d") are only for the Claude Code accounts, which come
 * from shell aliases (the letter of a Codex account is not a shortcut); Codex only comes in when there is an
 * account of its own, and Copilot when it has the only accounts.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter(isDefaultProvider));
  if (accounts.length && accounts.every(isCopilot)) return tr('Open {0} or Copilot in any project and watch your agent arrive.', [PROVIDER_NAME[DEFAULT_PROVIDER]]);
  if (!accounts.some(isCodex)) return tr('Open Claude Code in any project{0} and watch your agent arrive.', [keys ? ` (${keys})` : '']);
  return tr('Open Claude Code{0} or Codex in any project and watch your agent arrive.', [keys ? ` (${keys})` : '']);
}

/** Some Codex permission request waiting: the deadline is short and the card counts the seconds (1 s clock). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** How to see Codex live and approve from the office (drawer of a Codex agent and help). */
export const CODEX_LIVE_HINT = tr('To see Codex live and approve from the office: `npm run codex:install`, then approve the hooks in `/hooks` in Codex.');

/** Codex approval policies (`approval_policy`), when the server sends them in place of the permission mode. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Asks before almost everything'),
  'on-request': tr('Asks when needed'),
  'on-failure': tr('Asks when a command fails'),
  never: tr('Never asks'),
};

/** Approval of a Codex agent in words (an unknown value passes through as it came). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
