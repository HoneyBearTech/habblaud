import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot, UpdateStatus } from '../../../shared/types';
import { safeGithubUrl, updateStatusLine, versionChipTitle, versionInfo } from './version';

const NOW = Date.parse('2026-10-08T15:00:00Z');
const HOUR = 3_600_000;

function snap(version: string, updates?: UpdateStatus): OfficeSnapshot {
  return { rev: 1, serverTime: NOW, rooms: [], agents: [], accounts: [], meta: { demo: false, sources: [], startedAt: 0, version, updates } };
}

const ok = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ state: 'ok', repo: 'marmottajr/habblaud', checkedAt: NOW - 2 * HOUR, available: false, ...patch });

describe('versionInfo', () => {
  it('só versões de verdade (o ?mock=1 manda "demo" e o timelapse "timelapse")', () => {
    expect(versionInfo(snap('0.2.0'))).toEqual({ version: '0.2.0', updates: undefined });
    expect(versionInfo(snap('demo'))).toBeNull();
    expect(versionInfo(snap('timelapse'))).toBeNull();
    expect(versionInfo(null)).toBeNull();
  });
});

describe('safeGithubUrl', () => {
  it('aceita só páginas do GitHub', () => {
    expect(safeGithubUrl('https://github.com/marmottajr/habblaud/releases/tag/v0.3.0')).toBe('https://github.com/marmottajr/habblaud/releases/tag/v0.3.0');
    expect(safeGithubUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeGithubUrl('https://github.com.evil.io/x')).toBeUndefined();
    expect(safeGithubUrl('http://github.com/x')).toBeUndefined();
    expect(safeGithubUrl(undefined)).toBeUndefined();
  });
});

describe('updateStatusLine', () => {
  it('na mais recente, com a hora da verificação', () => {
    expect(updateStatusLine('0.2.0', ok({ latest: '0.2.0' }), NOW)).toEqual({ tone: 'ok', text: "You're on the latest version · checked 2 h ago." });
  });

  it('versão nova, com a data de publicação', () => {
    const line = updateStatusLine('0.2.0', ok({ latest: '0.3.0', available: true, publishedAt: NOW - HOUR }), NOW);
    expect(line.tone).toBe('new');
    expect(line.text).toMatch(/^New version available: v0\.3\.0, released /);
  });

  it('nenhuma release, à frente da última, verificando, desligado e falha', () => {
    expect(updateStatusLine('0.2.0', ok(), NOW).text).toBe('No version published on GitHub yet · checked 2 h ago.');
    expect(updateStatusLine('0.3.0-dev', ok({ latest: '0.2.0' }), NOW).text).toMatch(/ahead of the latest published version \(v0\.2\.0\)/);
    expect(updateStatusLine('0.2.0', { state: 'pending', available: false }, NOW)).toEqual({ tone: 'pending', text: 'Checking for a new version…' });
    expect(updateStatusLine('0.2.0', { state: 'off', repo: 'a/b', available: false }, NOW).text).toMatch(/HABBLAUD_UPDATE_CHECK=0/);
    expect(updateStatusLine('0.2.0', { state: 'off', available: false }, NOW).text).toMatch(/package\.json/);
    expect(updateStatusLine('0.2.0', ok({ state: 'error', error: 'no connection to GitHub' }), NOW)).toEqual({
      tone: 'warn',
      text: "Couldn't check right now: no connection to GitHub · last checked 2 h ago.",
    });
    expect(updateStatusLine('0.2.0', undefined, NOW).tone).toBe('off');
  });

  it('a falha não esconde uma versão nova já conhecida', () => {
    const line = updateStatusLine('0.2.0', ok({ state: 'error', error: 'GitHub responded 502', latest: '0.3.0', available: true }), NOW);
    expect(line).toEqual({ tone: 'new', text: 'New version available: v0.3.0. The last check failed (GitHub responded 502).' });
  });
});

describe('versionChipTitle', () => {
  it('diz as duas versões quando há novidade', () => {
    expect(versionChipTitle('0.2.0', ok({ latest: '0.3.0', available: true }), NOW)).toBe(
      "New Habblaud version: v0.3.0 (you're on v0.2.0). Click to see what's new and how to update.",
    );
    expect(versionChipTitle('0.2.0', ok({ latest: '0.2.0' }), NOW)).toBe("Habblaud v0.2.0. You're on the latest version · checked 2 h ago. Click for details.");
  });
});
