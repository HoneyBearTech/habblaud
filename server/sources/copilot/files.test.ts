import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotHome, sessionId } from '../../test/copilot-fixtures';
import { tempDir } from '../../test/fixtures';
import { isCopilotHome, listSessionIds, parseWorkspaceYaml, readOpenSessions, readWorkspace, sessionFile, workspaceInfo } from './files';

const S = sessionId(1);
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const h = copilotHome();
  cleanups.push(h.cleanup);
  return h;
}

describe('workspace.yaml reader', () => {
  it('reads only top-level key: value lines, removing matching quotes', () => {
    const text = [
      '# comment',
      `id: ${S}`,
      "cwd: '/home/user/my project'",
      'created_at: "2026-11-01T10:00:00.000Z"',
      'client_name: test-client # trailing comment',
      'pending_warning:',
      '  cwd: /somewhere/else',
      '  nested: yes',
      '- list item',
      'summary: "half quoted',
      'empty:',
    ].join('\n');
    expect(parseWorkspaceYaml(text)).toEqual({
      id: S,
      cwd: '/home/user/my project',
      created_at: '2026-11-01T10:00:00.000Z',
      client_name: 'test-client',
      summary: '"half quoted',
    });
    expect(workspaceInfo(text)).toEqual({ id: S, cwd: '/home/user/my project', createdAt: Date.parse('2026-11-01T10:00:00.000Z'), clientName: 'test-client' });
  });

  it('the first top-level value wins; Windows line ends and odd text do not break it', () => {
    expect(parseWorkspaceYaml('cwd: /a\r\ncwd: /b\r\n:::\n')).toEqual({ cwd: '/a' });
    expect(workspaceInfo('id: not-a-uuid\ncreated_at: soon\n')).toEqual({});
  });
});

describe('Copilot folder files', () => {
  it('isCopilotHome needs session-state/', () => {
    const h = home();
    expect(isCopilotHome(h.dir)).toBe(true);
    const other = tempDir();
    cleanups.push(other.cleanup);
    expect(isCopilotHome(other.dir)).toBe(false);
  });

  it('lists only UUID session folders and reads workspace.yaml', () => {
    const h = home();
    h.session(S, ['{}'], { cwd: '/home/user/project' });
    mkdirSync(join(h.dir, 'session-state', 'not-a-session'));
    expect(listSessionIds(h.dir)).toEqual([S]);
    expect(readWorkspace(h.dir, S).cwd).toBe('/home/user/project');
    expect(readWorkspace(h.dir, sessionId(9))).toEqual({});
  });

  it('sessionFile refuses bad ids and links that leave the Copilot folder', () => {
    const h = home();
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(join(outside.dir, 'events.jsonl'), '{}\n');
    const evil = sessionId(2);
    mkdirSync(join(h.dir, 'session-state', evil));
    symlinkSync(join(outside.dir, 'events.jsonl'), join(h.dir, 'session-state', evil, 'events.jsonl'));
    const good = h.session(S, ['{}']);
    expect(sessionFile(h.dir, S, 'events.jsonl')).toBe(realpathSync(good));
    expect(sessionFile(h.dir, evil, 'events.jsonl')).toBeUndefined();
    expect(sessionFile(h.dir, '../../etc', 'events.jsonl')).toBeUndefined();
  });

  it('readOpenSessions: the UUID keys; null when the file is missing; empty when it is broken', () => {
    const h = home();
    expect(readOpenSessions(h.dir)).toBeNull();
    h.open([S, 'junk']);
    expect([...readOpenSessions(h.dir)!]).toEqual([S]);
    writeFileSync(join(h.dir, 'open-sessions-state.json'), '{broken');
    expect(readOpenSessions(h.dir)!.size).toBe(0);
  });
});
