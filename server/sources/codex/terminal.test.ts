// Codex terminal: synthetic rollout lines (paginated and legacy) become the terminal entries.
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { R, threadId } from '../../test/codex-fixtures';
import { createCodexTerminalParser } from './terminal';

const T = threadId(1);

function entries(lines: string[]): TerminalEntry[] {
  const p = createCodexTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

describe('Codex terminal', () => {
  it('paginated: prompt, summarized reasoning, command with the output, diff, MCP and end of the turn', () => {
    const out = entries([
      R.meta(T, { cwd: '/projects/store' }),
      R.message('developer', 'injected instructions that do not show up'),
      R.message('user', '<environment_context>nothing</environment_context>'),
      R.functionCall('c1', 'exec_command', { cmd: 'npm test' }),
      R.user(T, 't', 'u1', 'Run the tests with the token sk-ant-abcdefghijklmnop'),
      R.reasoning(T, 't', 'r1', ['**Reading** the project']),
      R.command(T, 't', 'c1', 'npm test', { exit: 1, output: 'FAIL src/a.test.ts\n' }),
      R.fileChange(T, 't', 'p1', { '/projects/store/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' } }),
      R.mcp(T, 't', 'm1', 'github', 'get_issue', { owner: 'o', repo: 'r', issue_number: 1 }, { result: 'Issue 1: bug' }),
      R.agent(T, 't', 'a1', 'I fixed the **test**.'),
      R.taskComplete('t', Date.now(), 65_000),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'tool', 'tool', 'result', 'assistant', 'system']);
    expect(out[0]).toMatchObject({ kind: 'user', id: 'u1:u', text: 'Run the tests with the token sk-***' });
    expect(out[1]).toMatchObject({ kind: 'thinking', text: '**Reading** the project' });
    expect(out[2]).toMatchObject({ kind: 'tool', id: 'c1', tool: 'Bash', title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    expect(out[3]).toMatchObject({ kind: 'result', toolUseId: 'c1', error: true, text: 'Exit code 1\nFAIL src/a.test.ts' });
    expect(out[4]).toMatchObject({ kind: 'tool', tool: 'Edit', title: 'Edit(src/a.ts)', inputKind: 'diff' });
    expect((out[4] as { input?: string }).input).toContain('+new');
    expect(out[5]).toMatchObject({ kind: 'tool', tool: 'mcp__github__get_issue', title: 'github - get_issue (MCP)' });
    expect(out[6]).toMatchObject({ kind: 'result', toolUseId: 'm1', text: 'Issue 1: bug' });
    expect(out[7]).toMatchObject({ kind: 'assistant', text: 'I fixed the **test**.' });
    expect(out[8]).toMatchObject({ kind: 'system', text: 'Turn completed in 1min 5s' });
  });

  it('long output: truncated and marked; interrupted turn', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const out = entries([R.meta(T), R.command(T, 't', 'c1', 'cat log.txt', { output: long }), R.turnAborted('t')]);
    expect(out[1]).toMatchObject({ kind: 'result', truncated: true });
    expect((out[1] as { text: string }).text.split('\n').length).toBeLessThanOrEqual(120);
    expect(out[2]).toMatchObject({ kind: 'system', text: 'Interrupted by user', level: 'warn' });
  });

  it('legacy: prompt, response, reasoning and the function_call / output pair', () => {
    const out = entries([
      R.meta(T, { history: null }),
      R.legacyUser('List the files'),
      R.legacyReasoning('I will list'),
      R.functionCall('c1', 'shell', { command: ['bash', '-lc', 'ls'] }),
      R.functionOutput('c1', JSON.stringify({ output: 'a.ts\nb.ts', metadata: { exit_code: 0 } })),
      R.legacyAgent('Two files.'),
    ]);
    expect(out.map((e) => [e.kind, 'text' in e ? e.text : 'title' in e ? e.title : ''])).toEqual([
      ['user', 'List the files'],
      ['thinking', 'I will list'],
      ['tool', 'Bash(ls)'],
      ['result', 'a.ts\nb.ts'],
      ['assistant', 'Two files.'],
    ]);
  });

  it('app code mode: the message sent to you becomes a response, only once', () => {
    const out = entries([
      R.meta(T),
      R.delivered('call_msg', 'Found the **bug**'),
      R.mcp(T, 't', 'call_msg', 'codex_apps', 'user_messaging_send_message', { text: 'Found the **bug**' }, { result: 'ok' }),
      R.message('assistant', 'context that does not show up'),
    ]);
    expect(out).toEqual([{ kind: 'assistant', id: 'call_msg', at: expect.any(Number), text: 'Found the **bug**' }]);
  });

  it('paginated ignores the legacy events and the response_item calls', () => {
    const out = entries([R.meta(T), R.legacyUser('dup'), R.functionCall('c1', 'exec_command', { cmd: 'ls' }), R.functionOutput('c1', 'x')]);
    expect(out).toEqual([]);
  });
});
