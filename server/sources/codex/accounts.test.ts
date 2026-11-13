// Codex accounts: folder discovery, letter (shell alias or derived), color, name and the metadata coming from the host.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, discoverClaudeDirs, detectAccounts, parseToolAliases } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { codexPlanLabel, detectCodexAccounts, discoverCodexDirs } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const codex = (name: string, marker: 'locks' | 'year' | 'none' = 'locks') => {
    const dir = join(tmp.dir, name);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    if (marker === 'locks') mkdirSync(join(dir, 'thread-writer-locks'));
    if (marker === 'year') mkdirSync(join(dir, 'sessions', '2026'));
    return dir;
  };
  return { dir: tmp.dir, codex };
}

describe('Codex accounts', () => {
  it('discovery: ~/.codex* that looks like Codex (the default one first), CODEX_HOME and HABBLAUD_CODEX_DIRS', () => {
    const h = home();
    const main = h.codex('.codex');
    const work = h.codex('.codex-work', 'year');
    h.codex('.codex-empty', 'none');
    mkdirSync(join(h.dir, '.claude', 'projects'), { recursive: true });
    expect(discoverCodexDirs({}, h.dir)).toEqual([main, work]);
    const other = h.codex('other-folder');
    expect(discoverCodexDirs({ CODEX_HOME: other }, h.dir)).toEqual([other, main, work]);
    // The explicit list is used as given (it only needs to exist).
    expect(discoverCodexDirs({ HABBLAUD_CODEX_DIRS: `~/.codex-empty, ${other}, /does/not/exist` }, h.dir)).toEqual([join(h.dir, '.codex-empty'), other]);
  });

  it('letter from the shell alias (CODEX_HOME), derived without colliding with Claude Code; color without repeating', () => {
    const h = home();
    const main = h.codex('.codex');
    const work = h.codex('.codex-work');
    const third = h.codex('.codex-x');
    writeFileSync(
      join(h.dir, '.zshrc'),
      // Path with `/`, as in Git Bash's .bashrc (inside double quotes, the Windows `\` would be an escape).
      ["alias cx='codex'", `alias cw="CODEX_HOME=${work.replaceAll('\\', '/')} codex --search"`, "alias c='claude'", 'export CODEX_HOME=/x # not an alias'].join('\n'),
    );
    expect(parseToolAliases("alias cx='codex'\nalias c='claude'", h.dir, 'codex')).toEqual([{ name: 'cx' }]);
    const accs = detectCodexAccounts([main, work, third], { home: h.dir, env: {}, taken: { shorts: ['C', 'X'], colors: [ACCOUNT_COLORS[0]] } });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['.codex', 'codex', 'CX', 'Codex CX', main],
      ['.codex-work', 'codex', 'CW', 'Codex CW', work],
      // No alias: the suffix's initial (X) already belongs to Claude Code: the next free one.
      ['.codex-x', 'codex', 'Y', 'Codex Y', third],
    ]);
    expect(accs.map((a) => a.color)).toEqual([ACCOUNT_COLORS[1], ACCOUNT_COLORS[2], ACCOUNT_COLORS[3]]);
    // Only one account: "Codex".
    expect(detectCodexAccounts([main], { home: h.dir, env: {} })[0]).toMatchObject({ short: 'CX', name: 'Codex' });
    expect(detectCodexAccounts([third], { home: h.dir, env: {} })[0]).toMatchObject({ short: 'X', name: 'Codex' });
  });

  it('Docker: metadata coming from the host (host configDir, letter, color, name) matched by the mounted folder', () => {
    const h = home();
    const mounted = h.codex('.codex');
    const env = {
      HABBLAUD_ACCOUNTS: JSON.stringify([
        { id: '.claude', configDir: '/Users/fulano/.claude', mountDir: '/claude/.claude', short: 'C', name: 'Account C', color: '#111111' },
        { id: '.codex', provider: 'codex', configDir: '/Users/fulano/.codex', mountDir: mounted, short: 'CX', name: 'Codex', color: '#222222', plan: 'Plus' },
      ]),
    };
    expect(detectCodexAccounts([mounted], { home: '/does/not/exist', env })).toEqual([
      { id: '.codex', provider: 'codex', configDir: '/Users/fulano/.codex', short: 'CX', name: 'Codex', color: '#222222', plan: 'Plus' },
    ]);
    // Claude Code accounts don't get the Codex override (not even through the mounted folder).
    expect(discoverClaudeDirs(env, h.dir)).not.toContain(mounted);
    expect(detectAccounts([join(h.dir, '.codex-claude')], { home: h.dir, env: { HABBLAUD_ACCOUNTS: JSON.stringify([{ id: '.codex-claude', provider: 'codex', name: 'Codex' }]) } })[0].name).toBe('Account A');
  });

  it('plan from rate_limits for display', () => {
    expect(codexPlanLabel('plus')).toBe('Plus');
    expect(codexPlanLabel('prolite')).toBe('Pro Lite');
    expect(codexPlanLabel('self_serve_business_usage_based')).toBe('Self Serve Business Usage Based');
    expect(codexPlanLabel('unknown')).toBeUndefined();
    expect(codexPlanLabel(null)).toBeUndefined();
  });
});
