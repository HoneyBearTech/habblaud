import { describe, expect, it } from 'vitest';
import { ago, formatBytes, shortPath, spawnFolders } from './spawn';
import { insertDictation, pickMimeType } from './dictation';

describe('spawnFolders', () => {
  it('room folders, the most recent first, without the demo ones or relative paths', () => {
    const rooms = [
      { id: 'r1', path: '/Users/a/old' },
      { id: 'r2', path: '/Users/a/new' },
      { id: 'demo:x', path: '/demo/x' },
      { id: 'r3', path: 'relative' },
      { id: 'r4', path: 'C:\\code\\win' },
    ];
    const agents = [
      { roomId: 'r1', lastEventAt: 10 },
      { roomId: 'r2', lastEventAt: 50 },
      { roomId: 'r4', lastEventAt: 20 },
    ];
    expect(spawnFolders({ rooms, agents } as never)).toEqual(['/Users/a/new', 'C:\\code\\win', '/Users/a/old']);
    expect(spawnFolders(null)).toEqual([]);
  });
});

describe('New agent: project list and attachments', () => {
  it('short path with ~ and relative time', () => {
    expect(shortPath('/Users/ana/Coding/proj')).toBe('~/Coding/proj');
    expect(shortPath('/home/ana/proj')).toBe('~/proj');
    expect(shortPath('/opt/x')).toBe('/opt/x');
    expect(shortPath('C:\\Users\\ana\\proj')).toBe('~\\proj');
    const now = 10_000_000;
    expect([ago(0, now), ago(now - 10_000, now), ago(now - 5 * 60_000, now), ago(now - 3 * 3_600_000, now), ago(now - 72 * 3_600_000, now)]).toEqual(['', 'now', '5 min', '3 h', '3 d']);
    expect([formatBytes(900), formatBytes(2_048), formatBytes(3_500_000)]).toEqual(['900 B', '2 KB', '3,3 MB']);
  });
});

describe('dictation in the field', () => {
  it('inserts at the cursor with the right space on both sides', () => {
    expect(insertDictation('', 0, 0, ' Build an agent ')).toEqual({ value: 'Build an agent', caret: 14 });
    expect(insertDictation('Review', 6, 6, 'this report')).toEqual({ value: 'Review this report', caret: 18 });
    expect(insertDictation('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 3 });
    expect(insertDictation('change THIS here', 7, 11, 'that')).toEqual({ value: 'change that here', caret: 11 });
    expect(insertDictation('equal', 5, 5, '   ')).toEqual({ value: 'equal', caret: 5 });
  });
  it('chooses the format the browser records (mp4 on the iPhone, webm on Chrome)', () => {
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickMimeType(() => false)).toBeUndefined();
    expect(pickMimeType(() => { throw new Error('x'); })).toBeUndefined();
  });
});
