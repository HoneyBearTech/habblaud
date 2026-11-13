import { describe, expect, it } from 'vitest';
import { projectFolder, recentFolders } from './folders';

describe('suggested folders in New agent', () => {
  it('agent worktree becomes the project; temporary and relative ones are left out', () => {
    expect(projectFolder('/Users/a/Coding/morgana/.claude/worktrees/read-outcome-4c9d08')).toBe('/Users/a/Coding/morgana');
    expect(projectFolder('/Users/a/proj/.codex/worktrees/x/sub')).toBe('/Users/a/proj');
    expect(projectFolder('/Users/a/proj/')).toBe('/Users/a/proj');
    expect(projectFolder('/private/tmp/claude-501/scratch')).toBeUndefined();
    expect(projectFolder('/var/folders/xy/T/abc')).toBeUndefined();
    expect(projectFolder('/Users/a/Library/Application Support/Claude/scratch-workspaces/e8/60/scratch-2026-10-12-315a47')).toBeUndefined();
    expect(projectFolder('relative')).toBeUndefined();
    expect(projectFolder('C:\\code\\win')).toBe('C:\\code\\win');
    expect(projectFolder(undefined)).toBeUndefined();
  });

  it('joins sessions and rooms by folder, most recent first, with a limit', () => {
    const sessions = [
      { project: '/Users/a/store', lastAt: 100 },
      { project: '/Users/a/store/.claude/worktrees/w1', lastAt: 300 },
      { project: '/Users/a/habblaud', lastAt: 200 },
      { project: '/tmp/x', lastAt: 999 },
      { lastAt: 500 },
    ];
    const rooms = [{ path: '/Users/a/new-room', lastAt: 250 }, { path: '/Users/a/habblaud', lastAt: 50 }];
    expect(recentFolders(sessions, rooms)).toEqual([
      { path: '/Users/a/store', name: 'store', lastAt: 300, sessions: 2 },
      { path: '/Users/a/new-room', name: 'new-room', lastAt: 250, sessions: 0 },
      { path: '/Users/a/habblaud', name: 'habblaud', lastAt: 200, sessions: 1 },
    ]);
    expect(recentFolders(sessions, rooms, 1).map((f) => f.path)).toEqual(['/Users/a/store']);
  });
});
