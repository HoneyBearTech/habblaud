import { describe, expect, it } from 'vitest';
import type { RecentSession } from '../../../shared/types';
import { dayLabel, filterSessions, formatSize, groupSessionsByDay, parseRecentSessions } from './history';

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();
const at = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min).getTime();

function session(p: Partial<RecentSession> & Pick<RecentSession, 'sessionId' | 'lastAt'>): RecentSession {
  return { account: '.claude', projectDir: '-p', size: 1_000, open: false, ...p };
}

describe('Codex sessions in the history', () => {
  it('parseRecentSessions keeps the provider only when it is Codex; the search finds "codex"', () => {
    const list = parseRecentSessions({
      sessions: [
        { account: '.codex', provider: 'codex', sessionId: 'x', projectDir: '/p', lastAt: 2, size: 1, open: false },
        { account: '.claude', provider: 'claude', sessionId: 'c', projectDir: '-p', lastAt: 1, size: 1, open: false },
        { account: '.claude', provider: 'other', sessionId: 'd', projectDir: '-p', lastAt: 0, size: 1, open: false },
      ],
    });
    expect(list.map((s) => [s.sessionId, s.provider])).toEqual([
      ['x', 'codex'],
      ['c', undefined],
      ['d', undefined],
    ]);
    expect(filterSessions(list, 'codex').map((s) => s.sessionId)).toEqual(['x']);
  });
});

describe('groupSessionsByDay', () => {
  it('Today, Yesterday and dates, from the most recent day to the oldest (and from the most recent to the oldest within the day)', () => {
    const list = [
      session({ sessionId: 'a', lastAt: at(8, 9) }),
      session({ sessionId: 'b', lastAt: at(6, 23, 59) }),
      session({ sessionId: 'c', lastAt: at(8, 14) }),
      session({ sessionId: 'd', lastAt: at(7, 0, 5) }),
      session({ sessionId: 'e', lastAt: at(2, 10) }),
    ];
    const days = groupSessionsByDay(list, NOW);
    expect(days.map((d) => [d.label, d.sessions.map((s) => s.sessionId)])).toEqual([
      ['Today', ['c', 'a']],
      ['Yesterday', ['d']],
      [dayLabel(at(6, 12), NOW), ['b']],
      [dayLabel(at(2, 12), NOW), ['e']],
    ]);
    expect(days[2].label).toMatch(/^Tue.*Oct.*06/i);
    expect(days[3].label).toMatch(/^Fri.*Oct.*02/i);
    expect(groupSessionsByDay([], NOW)).toEqual([]);
  });
});

describe('filterSessions', () => {
  const list = [
    session({ sessionId: 'a', lastAt: 3, title: 'Configuração do carrinho', project: '/Users/ana/projects/store' }),
    session({ sessionId: 'b', lastAt: 2, title: 'Login route', project: '/Users/ana/projects/api', account: '.claude-conta2' }),
    session({ sessionId: 'c', lastAt: 1, projectDir: '-Users-ana-projects-site' }),
  ];
  const label = (id: string) => (id === '.claude-conta2' ? 'Work W' : 'Personal P');

  it('by title or project, ignoring case and accents; all the terms must match', () => {
    expect(filterSessions(list, 'configuracao').map((s) => s.sessionId)).toEqual(['a']);
    expect(filterSessions(list, 'STORE').map((s) => s.sessionId)).toEqual(['a']);
    expect(filterSessions(list, 'site').map((s) => s.sessionId)).toEqual(['c']);
    expect(filterSessions(list, 'route api').map((s) => s.sessionId)).toEqual(['b']);
    expect(filterSessions(list, 'route store')).toEqual([]);
  });

  it('by the account (name or letter); with no term, everything', () => {
    expect(filterSessions(list, 'work', label).map((s) => s.sessionId)).toEqual(['b']);
    expect(filterSessions(list, 'personal', label).map((s) => s.sessionId)).toEqual(['a', 'c']);
    expect(filterSessions(list, '  ', label)).toHaveLength(3);
  });
});

describe('parseRecentSessions', () => {
  it('accepts the valid ones, ignores the rest and sorts from the most recent to the oldest', () => {
    const raw = {
      sessions: [
        { account: '.claude', sessionId: 's1', projectDir: '-p', project: '/p', title: 'One', firstAt: 1, lastAt: 10, size: 99, open: false, agentId: 'x' },
        { account: '.claude', sessionId: 's2', lastAt: 20, open: true, agentId: '.claude:7' },
        { account: '.claude', lastAt: 30 },
        { sessionId: 's4', lastAt: 30 },
        { account: '.claude', sessionId: 's5', lastAt: 'yesterday' },
        null,
        'x',
      ],
    };
    const out = parseRecentSessions(raw);
    expect(out.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(out[0]).toEqual({ account: '.claude', sessionId: 's2', projectDir: '', lastAt: 20, size: 0, open: true, agentId: '.claude:7' });
    // agentId só vale para sessão aberta.
    expect(out[1]).toEqual({ account: '.claude', sessionId: 's1', projectDir: '-p', project: '/p', title: 'One', firstAt: 1, lastAt: 10, size: 99, open: false });
    expect(parseRecentSessions(null)).toEqual([]);
    expect(parseRecentSessions({ sessions: 'x' })).toEqual([]);
  });
});

describe('utilities', () => {
  it('formatSize', () => {
    expect(formatSize(10)).toBe('1 KB');
    expect(formatSize(820 * 1024)).toBe('820 KB');
    expect(formatSize(3.4 * 1024 * 1024)).toBe('3,4 MB');
  });
});
