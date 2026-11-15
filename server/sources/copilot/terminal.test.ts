import { describe, expect, it } from 'vitest';
import { E, ev, sessionId } from '../../test/copilot-fixtures';
import { createCopilotTerminalParser } from './terminal';

const S = sessionId(1);
const T0 = Date.parse('2026-11-01T10:00:00.000Z');

function entries(lines: string[]) {
  const p = createCopilotTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

describe('Copilot terminal', () => {
  it('prompts, replies, tools with their output, permission prompts and the end of the session', () => {
    const out = entries([
      E.start(S, { at: T0, cwd: '/home/user/project' }),
      E.user('note', T0 + 1, { source: 'memory' }),
      E.user('Run the tests', T0 + 2),
      ev('assistant.message', { content: '', reasoningText: 'Let me check.', toolRequests: [{ toolCallId: 'c1' }] }, T0 + 3),
      E.toolStart('c1', 'bash', { command: 'npm test' }, T0 + 4),
      E.permission('r1', { kind: 'shell', fullCommandText: 'npm test' }, T0 + 5),
      E.toolEnd('c1', T0 + 6, { content: '3 passed' }),
      E.toolStart('c2', 'view', { path: '/home/user/project/src/a.ts' }, T0 + 7),
      E.toolEnd('c2', T0 + 8, { success: false, content: 'not found' }),
      E.message('All good.', T0 + 9),
      E.abort(T0 + 10),
      E.shutdown(T0 + 11),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'system', 'result', 'tool', 'result', 'assistant', 'system', 'system']);
    expect(out[0]).toMatchObject({ text: 'Run the tests', at: T0 + 2 });
    expect(out[2]).toMatchObject({ kind: 'tool', id: 'c1', tool: 'Bash', title: 'Bash(npm test)' });
    expect(out[3]).toMatchObject({ kind: 'system', level: 'warn', text: 'Needs you: approve a command' });
    expect(out[4]).toMatchObject({ kind: 'result', toolUseId: 'c1', text: '3 passed' });
    expect(out[5]).toMatchObject({ tool: 'Read', title: 'Read(src/a.ts)' });
    expect(out[6]).toMatchObject({ error: true });
    expect(out[7]).toMatchObject({ kind: 'assistant', text: 'All good.' });
  });

  it('masks secrets and survives broken lines', () => {
    const out = entries(['{oops', '', JSON.stringify({ type: 'user.message', data: null }), E.user('key ghp_abcdefghijklmnopqrstuvwxyz0123456789', T0)]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('the same line twice does not repeat entries', () => {
    const line = E.user('once', T0);
    const p = createCopilotTerminalParser();
    expect(p.push(line)).toHaveLength(1);
    expect(p.push(line)).toHaveLength(0);
  });
});
