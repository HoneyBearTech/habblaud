import { describe, expect, it } from 'vitest';
import { looksLikeClaude, parsePs, parseWindows, sameProcess } from './procinfo';

const STARTED = 1_791_557_339_236;

describe('procinfo', () => {
  it('reads the FILETIME and the name from PowerShell', () => {
    const info = parseWindows('134360309381229341\r\nclaude\r\n');
    expect(info).toEqual({ startMs: 1_791_557_338_122, name: 'claude', fileTime: '134360309381229341' });
    expect(parseWindows('error')).toBeUndefined();
  });

  it('reads the lstart and the command from ps', () => {
    const info = parsePs('Mon Oct 12 22:46:14 2026     /usr/local/bin/node\n');
    expect(info?.name).toBe('node');
    expect(info?.startMs).toBe(new Date(2026, 9, 12, 22, 46, 14).getTime());
    expect(parsePs('')).toBeUndefined();
  });

  it('recognizes the Claude Code executable', () => {
    for (const n of ['claude', 'claude.exe', 'node', 'node.exe', 'bun', '2.1.295', '/home/u/.local/share/claude/versions/2.1.295']) expect(looksLikeClaude(n)).toBe(true);
    for (const n of ['chrome', 'bash', 'claude-helper', 'python3']) expect(looksLikeClaude(n)).toBe(false);
  });

  it('same process: start close to the record and the right executable', () => {
    expect(sameProcess({ startedAt: STARTED }, { startMs: STARTED - 1_200, name: 'claude' })).toBe(true);
    expect(sameProcess({ startedAt: STARTED }, { startMs: STARTED - 10 * 60_000, name: 'claude' })).toBe(false);
    expect(sameProcess({ startedAt: STARTED }, { startMs: STARTED + 60_000, name: 'claude' })).toBe(false);
    expect(sameProcess({ startedAt: STARTED }, { startMs: STARTED, name: 'explorer' })).toBe(false);
    expect(sameProcess({}, { startMs: STARTED, name: 'claude' })).toBe(false);
  });

  it('with FILETIME on both sides, only the exact one counts', () => {
    const reg = { startedAt: STARTED, procStart: '134360309381229341' };
    expect(sameProcess(reg, { startMs: STARTED - 1_114, name: 'claude', fileTime: '134360309381229341' })).toBe(true);
    expect(sameProcess(reg, { startMs: STARTED - 1_114, name: 'claude', fileTime: '134360309381229999' })).toBe(false);
  });
});
