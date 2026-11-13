// Folders suggested in "New agent": the projects you worked on last, to pick with one tap instead of
// remembering the path. They come from the session history (the `cwd` of the transcripts, from all accounts and
// tools) and from the office rooms. Agent worktrees (<project>/.claude/worktrees/<name>) count as the project;
// temporary folders (and the Claude app's scratch-workspaces) stay out. Plain Node: it only merges and sorts (the
// one that reads the transcripts is sources/history.ts).

export interface SpawnFolder {
  /** Absolute path on the Claude app's computer. */
  path: string;
  /** Short name (last part of the path). */
  name: string;
  /** Most recent activity (epoch ms; 0 = only the room, no time). */
  lastAt: number;
  /** Recent sessions in this folder. */
  sessions: number;
}

export const FOLDERS_LIMIT = 15;

const TEMP = /^(\/private)?\/(tmp|var\/folders|var\/tmp)(\/|$)/;
/** Disposable folders that the Claude desktop app creates for sessions without a project. */
const SCRATCH = /\/Application Support\/Claude\/scratch-workspaces\//;
const WORKTREE = /^(.*?)\/\.(claude|codex)\/worktrees\/[^/]+(\/.*)?$/;

function absolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** The project folder for a session path (a worktree becomes the project; temporary or relative = undefined). */
export function projectFolder(raw: string | undefined): string | undefined {
  const p = raw?.trim().replace(/[\\/]+$/, '');
  if (!p || !absolute(p) || TEMP.test(p) || SCRATCH.test(p)) return undefined;
  const wt = WORKTREE.exec(p);
  return wt ? wt[1] || undefined : p;
}

/** Merges sessions and rooms into unique folders, from the most recent activity to the oldest. */
export function recentFolders(
  sessions: ReadonlyArray<{ project?: string; lastAt: number }>,
  rooms: ReadonlyArray<{ path?: string; lastAt?: number }>,
  limit = FOLDERS_LIMIT,
): SpawnFolder[] {
  const byPath = new Map<string, SpawnFolder>();
  const add = (raw: string | undefined, lastAt: number, session: boolean) => {
    const path = projectFolder(raw);
    if (!path) return;
    const cur = byPath.get(path);
    if (cur) {
      cur.lastAt = Math.max(cur.lastAt, lastAt);
      if (session) cur.sessions++;
    } else byPath.set(path, { path, name: path.split(/[\\/]/).pop() || path, lastAt, sessions: session ? 1 : 0 });
  };
  for (const s of sessions) add(s.project, s.lastAt, true);
  for (const r of rooms) add(r.path, r.lastAt ?? 0, false);
  return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt || a.path.localeCompare(b.path)).slice(0, limit);
}
