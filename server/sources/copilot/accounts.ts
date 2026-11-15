// Copilot CLI accounts: one Copilot folder per account (COPILOT_HOME or ~/.copilot). Pure Node and with no server
// dependencies: it is also imported by scripts/docker-up.ts (via tsx) on the host.
//
// Discovery: HABBLAUD_COPILOT_DIRS (comma-separated list) replaces everything; otherwise COPILOT_HOME (or
// $HOME/.copilot), kept only if it has `session-state/` (isCopilotHome). Account id: the folder name. Letter: the
// shell alias `alias x='COPILOT_HOME=... copilot'` (no COPILOT_HOME = the default folder); with no alias, a derived
// letter that doesn't collide with the other accounts. Color: from the account palette, without repeating the other
// accounts' ones. Name: "Copilot" (or "Copilot X" with more than one account). No plan and no email (Copilot writes
// neither to the session files).
//
// Privacy: only `session-state/` is checked here (by existence); from the shell files, only the
// `alias X='... copilot ...'` lines. In Docker the host sends everything ready in HABBLAUD_ACCOUNTS
// (`provider: 'copilot'`, with the host's `configDir`).
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';
import { isCopilotHome } from './files';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Default Copilot folder: COPILOT_HOME or $HOME/.copilot. */
export function defaultCopilotHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.COPILOT_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.copilot');
}

/**
 * Copilot folders being watched. HABBLAUD_COPILOT_DIRS (comma-separated list) replaces the detection and is used as
 * given (it only needs to exist). Otherwise: COPILOT_HOME or $HOME/.copilot, if it has `session-state/`.
 */
export function discoverCopilotDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_COPILOT_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const main = defaultCopilotHome(env, home);
  return isCopilotHome(main) ? [main] : [];
}

/** Overrides of the Copilot accounts in HABBLAUD_ACCOUNTS (coming from the host, in Docker). */
export function copilotOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'copilot');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Candidate letters of an account with no alias: the suffix's initial (".copilot-work" → W), P, G, O... and the alphabet. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?copilot[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('P', 'G', 'O', 'Q', 'K', 'J');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface CopilotDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letters and colors already used by the other accounts (they are not repeated). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * One account per Copilot folder, IN THE SAME ORDER as `dirs`. `configDir` is the path for display (in Docker, the
 * host's, coming from HABBLAUD_ACCOUNTS).
 */
export function detectCopilotAccounts(dirs: string[], opts: CopilotDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = copilotOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'copilot'), home, defaultCopilotHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    return {
      id: p.id,
      provider: 'copilot',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Copilot ${short}` : 'Copilot'),
      color,
    };
  });
}
