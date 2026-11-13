import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import { L, tempDir } from '../test/fixtures';
import { FileTail, MAX_LINE_BYTES } from './tail';
import {
  applyTaskOp,
  createTranscriptState,
  forkDirective,
  mergePrefix,
  parseLine,
  parseTaskNotification,
  scanPrefix,
  titleOf,
  type LineResult,
  type TranscriptState,
} from './transcript';

const T0 = Date.parse('2026-10-06T10:00:00Z');

function feed(state: TranscriptState, lines: string[]): LineResult[] {
  return lines.map((l) => parseLine(state, l, { idPrefix: 'acc:1', now: T0 }));
}

function acts(results: LineResult[]) {
  return results.flatMap((r) => r.activities);
}

describe('parseLine — activities', () => {
  it('prompt, thinking, tool, response and end of turn', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.prompt('Fix the cart bug', { at: T0 }),
      L.assistant([L.thinking()], { at: T0 + 1000, msgId: 'm1' }),
      L.assistant([L.tool('tu1', 'Read', { file_path: '/p/src/Cart.tsx' })], { at: T0 + 2000, msgId: 'm1' }),
      L.result('tu1', 'content', { at: T0 + 2500 }),
      L.assistant([L.text('Done, I fixed it.')], { at: T0 + 3000, msgId: 'm2', stop: 'end_turn' }),
      L.system('turn_duration', { durationMs: 65_000 }, { at: T0 + 3100 }),
    ]);
    const a = acts(r);
    expect(a.map((x) => x.activity.kind)).toEqual(['prompt', 'think', 'read', 'respond', 'done']);
    expect(a[2].activity).toMatchObject({ text: 'Reading Cart.tsx', tool: 'Read', at: T0 + 2000 });
    expect(a[4].activity).toMatchObject({ text: 'Done in 1min 5s', durationMs: 65_000 });
    expect(a.every((x) => x.activity.id.startsWith('acc:1#'))).toBe(true);
    expect(new Set(a.map((x) => x.activity.id)).size).toBe(a.length);
    expect(s.ended).toBe(true);
    expect(s.stats.toolCalls).toBe(1);
  });

  it('ignores meta, local commands, reminders and unknown types', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.meta('Caveat: local messages'),
      L.prompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
      L.prompt('<local-command-stdout>ok</local-command-stdout>'),
      L.prompt('<system-reminder>x</system-reminder>'),
      L.raw('file-history-snapshot', { snapshot: {} }),
      L.raw('type-from-the-future', { x: 1 }),
      'this is not json',
      '[]',
    ]);
    expect(acts(r)).toEqual([]);
  });

  it('work slash command becomes a prompt', () => {
    const s = createTranscriptState();
    const a = acts(feed(s, [L.prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>')]));
    expect(a).toHaveLength(1);
    expect(a[0].activity.kind).toBe('prompt');
    expect(a[0].activity.detail).toBe('/review 123');
  });

  it('a single "Thinking…" per message', () => {
    const s = createTranscriptState();
    const a = acts(
      feed(s, [
        L.assistant([L.thinking()], { at: T0, msgId: 'm1' }),
        L.assistant([L.thinking()], { at: T0 + 100, msgId: 'm1' }),
      ]),
    );
    expect(a).toHaveLength(1);
  });

  it('error from an old tool goes to the history without becoming the current activity', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('a', 'Bash', { command: 'npm test' }), L.tool('b', 'Read', { file_path: '/x/y.ts' })], { at: T0 }),
      L.result('a', 'Exit code 1\nfailed', { error: true, at: T0 + 10 }),
      L.result('b', 'File does not exist', { error: true, at: T0 + 20 }),
    ]);
    const a = acts(r);
    const errors = a.filter((x) => x.activity.kind === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ current: false, activity: { text: 'Error in Bash', detail: 'Exit code 1', error: true } });
    expect(errors[1].current).toBe(true);
  });

  it('interruption and denial', () => {
    const s = createTranscriptState();
    const a = acts(
      feed(s, [
        L.assistant([L.tool('a', 'Edit', { file_path: '/x/a.ts' })], { at: T0 }),
        L.result('a', "The user doesn't want to proceed with this tool use.", {
          error: true,
          extraText: '[Request interrupted by user for tool use]',
        }),
        L.assistant([L.tool('b', 'Write', { file_path: '/x/b.ts' })], { at: T0 + 10 }),
        L.result('b', "The user doesn't want to proceed with this tool use. The tool use was rejected", { error: true }),
      ]),
    );
    expect(a.map((x) => x.activity.text)).toEqual(['Editing a.ts', 'Interrupted by you', 'Writing b.ts', 'You denied: Write']);
    expect(s.ended).toBe(false);
  });

  it('compaction, API error and background result', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.system('compact_boundary', { compactMetadata: {} }),
      L.system('api_error', { retryAttempt: 1 }),
      L.system('api_error', { retryAttempt: 2 }),
      L.notification('toolu_bg', 'completed', 'All good'),
    ]);
    const a = acts(r);
    expect(a.map((x) => x.activity.kind)).toEqual(['compact', 'wait', 'other']);
    expect(a[2].activity.detail).toBe('All good');
    expect(r[3].signals).toEqual([{ type: 'notification', toolUseId: 'toolu_bg', taskId: 't1', status: 'completed', summary: 'All good' }]);
  });
});

describe('parseLine — titles, tasks and numbers', () => {
  it('title: custom-title > agent-name > ai-title > last prompt', () => {
    const s = createTranscriptState();
    feed(s, [L.prompt('Make the checkout page with a summary')]);
    expect(titleOf(s)).toBe('Make the checkout page with a summary');
    feed(s, [L.raw('ai-title', { aiTitle: 'Checkout' })]);
    expect(titleOf(s)).toBe('Checkout');
    feed(s, [L.raw('agent-name', { agentName: 'Agent X' })]);
    expect(titleOf(s)).toBe('Agent X');
    feed(s, [L.raw('custom-title', { customTitle: 'Store' })]);
    expect(titleOf(s)).toBe('Store');
  });

  it('TodoWrite replaces the list; TaskCreate/TaskUpdate edit it (id coming from the result)', () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([
        L.tool('t1', 'TodoWrite', {
          todos: [
            { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
            { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
          ],
        }),
      ]),
    ]);
    expect(s.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ['1', 'Read code', 'completed'],
      ['2', 'Fix', 'in_progress'],
    ]);
    const s2 = createTranscriptState();
    feed(s2, [
      L.assistant([L.tool('c1', 'TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' })]),
      L.result('c1', 'Task #7 created successfully', { toolUseResult: { task: { id: '7', subject: 'Write tests' } } }),
      L.assistant([L.tool('c2', 'TaskCreate', { subject: 'Review' })]),
      L.result('c2', 'Task #8 created successfully: Review'),
      L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' })]),
      L.assistant([L.tool('u2', 'TaskUpdate', { taskId: '8', status: 'deleted' })]),
    ]);
    expect(s2.tasks).toEqual([{ id: '7', title: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }]);
  });

  it('tokens: lines of the same message count once (with the final usage)', () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([L.thinking()], { msgId: 'm1', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }),
      L.assistant([L.tool('x', 'Bash', { command: 'ls' })], {
        msgId: 'm1',
        usage: { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
      }),
      L.assistant([L.text('ok')], { msgId: 'm2', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ]);
    expect(s.stats.tokensIn).toBe(1052 + 5);
    expect(s.stats.tokensOut).toBe(40 + 7);
    expect(s.stats.toolCalls).toBe(1);
  });

  it('most recent cost-state wins; model, branch and permission mode', () => {
    const s = createTranscriptState();
    feed(s, [
      L.raw('cost-state', { totalCostUSD: 0.5, totalLinesAdded: 10, totalLinesRemoved: 2 }),
      L.raw('cost-state', { totalCostUSD: 1.23456, totalLinesAdded: 30, totalLinesRemoved: 4 }),
      L.raw('permission-mode', { permissionMode: 'auto' }),
      L.assistant([L.text('hi')], { model: 'claude-opus-test', gitBranch: 'feat/x' }),
      L.assistant([L.text('hi')], { model: '<synthetic>', gitBranch: 'HEAD' }),
    ]);
    expect(s.stats).toMatchObject({ costUSD: 1.2346, linesAdded: 30, linesRemoved: 4 });
    expect(s.model).toBe('claude-opus-test');
    expect(s.gitBranch).toBe('feat/x');
    expect(s.permissionMode).toBe('auto');
  });
});

describe('parseLine — subagent signals', () => {
  it('Agent in the foreground: spawn and end', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_a', 'Agent', { description: 'Review code', subagent_type: 'Explore', prompt: '...' })]),
      L.result('toolu_a', 'summary', { toolUseResult: { status: 'completed', agentId: 'abc123', totalTokens: 10 } }),
    ]);
    expect(r[0].signals).toEqual([
      { type: 'spawn', spawn: expect.objectContaining({ toolUseId: 'toolu_a', tool: 'Agent', description: 'Review code', subagentType: 'Explore', background: false }) },
    ]);
    expect(r[1].signals).toEqual([{ type: 'finished', toolUseId: 'toolu_a', agentId: 'abc123', error: false }]);
    expect(s.stats.subagents).toBe(1);
  });

  it('in the background: launched (does not end) and then notification', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_b', 'Agent', { description: 'Research', subagent_type: 'fork', run_in_background: 'true' })]),
      L.result('toolu_b', 'launched', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bg1' } }),
      L.assistant([L.tool('toolu_w', 'Workflow', { scriptPath: '/x.js' })]),
      L.result('toolu_w', 'ok', { toolUseResult: { status: 'async_launched', taskId: 'w1', runId: 'wf_1' } }),
      L.assistant([L.tool('toolu_s', 'TaskStop', { task_id: 'w1' })]),
      L.result('toolu_s', 'stopped'),
    ]);
    expect(r[0].signals[0]).toMatchObject({ type: 'spawn', spawn: { background: true } });
    expect(r[1].signals).toEqual([{ type: 'launched', toolUseId: 'toolu_b', agentId: 'bg1' }]);
    expect(r[3].signals).toEqual([{ type: 'launched', toolUseId: 'toolu_w', runId: 'wf_1', taskId: 'w1' }]);
    expect(r[5].signals).toEqual([{ type: 'stopped', taskId: 'w1' }]);
  });

  it('fork: the inherited copy of the Agent call becomes neither spawn nor end; the instruction becomes the prompt', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      ...L.forkStart('fk1', 'toolu_fk', 'Draw the new poses', { agentId: 'fk1' }),
      L.assistant([L.tool('r1', 'Read', { file_path: '/projects/demo/a.ts' })], { agentId: 'fk1' }),
    ]);
    expect(r.flatMap((x) => x.signals)).toEqual([]);
    expect(acts(r).map((a) => [a.activity.kind, a.activity.text])).toEqual([
      ['prompt', expect.stringContaining('Draw the new poses')],
      ['read', 'Reading a.ts'],
    ]);
    expect(s.stats).toMatchObject({ subagents: 0, toolCalls: 1 });
    expect(s.lastPrompt).toBe('Draw the new poses');
    expect(s.pendingTools.has('toolu_fk')).toBe(false);
    expect(forkDirective('<fork-boilerplate>\nrules\n</fork-boilerplate>\n\nYour directive: Do X')).toBe('Do X');
  });

  it('queued notification (queue-operation) also signals, without activity', () => {
    const s = createTranscriptState();
    const r = parseLine(
      s,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_q</tool-use-id><status>completed</status></task-notification>' }),
      { idPrefix: 'p', now: T0 },
    );
    expect(r.activities).toEqual([]);
    expect(r.signals).toEqual([{ type: 'notification', toolUseId: 'toolu_q', status: 'completed' }]);
  });

  it('parseTaskNotification', () => {
    expect(parseTaskNotification('<task-notification><task-id>x</task-id><status>killed</status></task-notification>')).toEqual({
      taskId: 'x',
      toolUseId: undefined,
      status: 'killed',
      summary: undefined,
    });
  });
});

describe('parseLine — shell signals', () => {
  it('Bash in the background: start (label, masked command), launch with the task id, end through the queue and through the message', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant(
        [L.tool('toolu_bg', 'Bash', { command: 'API_TOKEN=abc123456 vendor/bin/phpunit', description: 'Run the complete suite in groups with phpunit', run_in_background: true, timeout: 600000 })],
        { at: T0 },
      ),
      L.bgLaunched('toolu_bg', 'bo0ov3q3l', { at: T0 + 500 }),
      L.shellNotification('queue', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "x" completed (exit code 0)' }, { at: T0 + 60_000 }),
      L.shellNotification('message', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed' }, { at: T0 + 60_100 }),
    ]);
    expect(r[0].signals).toEqual([
      {
        type: 'shellStart',
        shell: {
          toolUseId: 'toolu_bg',
          label: 'Run the complete suite in groups with phpunit',
          command: 'API_TOKEN=*** vendor/bin/phpunit',
          background: true,
          kind: 'shell',
          at: T0,
        },
      },
    ]);
    expect(r[1].signals).toEqual([{ type: 'shellResult', toolUseId: 'toolu_bg', taskId: 'bo0ov3q3l', error: false }]);
    expect(r[1].at).toBe(T0 + 500);
    expect(r[2]).toMatchObject({ activities: [], at: T0 + 60_000 });
    expect(r[2].signals).toEqual([
      { type: 'notification', taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "x" completed (exit code 0)' },
    ]);
    expect(r[3].signals[0]).toMatchObject({ type: 'notification', taskId: 'bo0ov3q3l' });
    expect(r[3].activities[0].activity.text).toBe('Got a background result');
  });

  it('Bash in the foreground: start without background and result without id; without description, the label summarizes the command', () => {
    const s = createTranscriptState();
    const r = feed(s, [L.assistant([L.tool('fg', 'Bash', { command: 'npm test' })]), L.result('fg', 'ok, 10 tests')]);
    expect(r[0].signals).toEqual([{ type: 'shellStart', shell: expect.objectContaining({ toolUseId: 'fg', label: 'Running tests', background: false }) }]);
    expect(r[1].signals).toEqual([{ type: 'shellResult', toolUseId: 'fg', error: false }]);
  });

  it('the output of a foreground command is not mistaken for a background id', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('fg', 'Bash', { command: 'cat log' })]),
      L.result('fg', 'line 1\nCommand running in background with ID: bzzzz'),
      L.assistant([L.tool('fg2', 'Bash', { command: 'jq . t.jsonl' })]),
      // Caso real: um comando que imprime o JSON de um tool_result com essa frase na primeira linha.
      L.result('fg2', '[{"tool_use_id":"toolu_x","type":"tool_result","content":"Command running in background with ID: bo0ov3q3l. Output"}]'),
      L.assistant([L.tool('bg', 'Bash', { command: 'sleep 99', run_in_background: true })]),
      // Versões sem toolUseResult.backgroundTaskId: o id vem do texto do próprio Claude Code.
      L.result('bg', 'Command running in background with ID: b7x2k9. Output is being written to: /tmp/x'),
    ]);
    expect(r[1].signals).toEqual([{ type: 'shellResult', toolUseId: 'fg', error: false }]);
    expect(r[3].signals).toEqual([{ type: 'shellResult', toolUseId: 'fg2', error: false }]);
    expect(r[5].signals).toEqual([{ type: 'shellResult', toolUseId: 'bg', taskId: 'b7x2k9', error: false }]);
  });

  it('Monitor is a background job of type monitor; KillShell/TaskStop stop the id; end of turn and interruption', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('mon', 'Monitor', { description: 'errors in deploy.log', command: 'tail -f deploy.log | grep --line-buffered ERROR', timeout_ms: 600000 })]),
      L.result('mon', 'Monitor started with ID: m4k2z9', { toolUseResult: { taskId: 'm4k2z9' } }),
      L.assistant([L.tool('k1', 'KillShell', { shell_id: 'bo0ov3q3l' })]),
      L.result('k1', 'killed'),
      L.system('turn_duration', { durationMs: 1_000 }),
      L.prompt('[Request interrupted by user]'),
    ]);
    expect(r[0].signals).toEqual([{ type: 'shellStart', shell: expect.objectContaining({ kind: 'monitor', background: true, label: 'errors in deploy.log', timeoutMs: 600000 }) }]);
    expect(r[1].signals).toEqual([{ type: 'shellResult', toolUseId: 'mon', taskId: 'm4k2z9', error: false }]);
    expect(r[3].signals).toEqual([{ type: 'stopped', taskId: 'bo0ov3q3l' }]);
    expect(r[4].signals).toEqual([{ type: 'turnEnd' }]);
    expect(r[5].signals).toEqual([{ type: 'turnEnd' }]);
  });

  it('launch whose tool_use was before the window read still signals (through backgroundTaskId)', () => {
    const s = createTranscriptState();
    const r = feed(s, [L.bgLaunched('toolu_before', 'bbefore1')]);
    expect(r[0].signals).toEqual([{ type: 'shellResult', toolUseId: 'toolu_before', taskId: 'bbefore1', error: false }]);
  });

  it('scanPrefix returns the shell signals from the beginning of the file, with the time of each line', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 's.jsonl');
      const lines = [
        L.assistant([L.tool('b1', 'Bash', { command: 'npm run build', run_in_background: true })], { at: T0 }),
        L.bgLaunched('b1', 'bbuild', { at: T0 + 1_000 }),
        L.shellNotification('queue', { taskId: 'bbuild', toolUseId: 'b1', status: 'completed' }, { at: T0 + 9_000 }),
      ];
      writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
      const prefix = await scanPrefix(file, Buffer.byteLength(lines.map((l) => `${l}\n`).join('')), new Set());
      expect(prefix.shellEvents.map((e) => [e.signal.type, e.at])).toEqual([
        ['shellStart', T0],
        ['shellResult', T0 + 1_000],
        ['notification', T0 + 9_000],
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it('scanPrefix ignores a line above the cap and reads the neighbors', async () => {
    const tmp = tempDir();
    const warn = vi.spyOn(log, 'warnOnce').mockImplementation(() => {});
    try {
      const file = join(tmp.dir, 's.jsonl');
      const before = `${L.raw('custom-title', { customTitle: 'Before' })}\n`;
      const after = `${L.raw('ai-title', { aiTitle: 'Later' })}\n`;
      const body = Buffer.concat([
        Buffer.from(before),
        Buffer.from('{"type":"agent-name","sessionId":"sess-test","agentName":"'),
        Buffer.alloc(MAX_LINE_BYTES, 0x6e),
        Buffer.from('"}\n'),
        Buffer.from(after),
      ]);
      writeFileSync(file, body);
      const prefix = await scanPrefix(file, body.length, new Set());
      expect(prefix.state.customTitle).toBe('Before');
      expect(prefix.state.aiTitle).toBe('Later');
      // Booleano de propósito: o valor antigo é a linha gigante, e o diff não pode imprimi-la.
      expect(prefix.state.agentName === undefined).toBe(true);
      expect(warn).toHaveBeenCalledWith(`oversize-line:${file}`, expect.stringContaining('8 MiB'));
    } finally {
      warn.mockRestore();
      tmp.cleanup();
    }
  });
});

describe('final window + prefix in the background', () => {
  it('merges titles, tasks and numbers without counting twice', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 's.jsonl');
      const prefixLines = [
        L.raw('custom-title', { customTitle: 'Old project' }),
        L.assistant([L.tool('c1', 'TaskCreate', { subject: 'First' })], { msgId: 'p1' }),
        L.result('c1', 'Task #1 created successfully'),
        L.raw('cost-state', { totalCostUSD: 2, totalLinesAdded: 5, totalLinesRemoved: 1 }),
        // Mensagem que atravessa a fronteira: primeira linha no prefixo...
        L.assistant([L.thinking()], { msgId: 'mx', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      ];
      const tailLines = [
        // ...e a segunda (uso final) na janela.
        L.assistant([L.tool('t9', 'Bash', { command: 'ls' })], { msgId: 'mx', usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })], { msgId: 't2' }),
      ];
      const prefixText = prefixLines.map((l) => `${l}\n`).join('');
      writeFileSync(file, prefixText + tailLines.map((l) => `${l}\n`).join(''));
      const end = Buffer.byteLength(prefixText);

      const tail = new FileTail(file);
      tail.offset = end;
      const state = createTranscriptState({ trackPrefix: true });
      for (const line of tail.read().lines) parseLine(state, line, { idPrefix: 'a', now: T0 });
      expect(state.tasks).toEqual([]);
      const tailTokensOut = state.stats.tokensOut;

      const prefix = await scanPrefix(file, end, new Set(state.firstMsgIds));
      mergePrefix(state, prefix.state);
      expect(titleOf(state)).toBe('Old project');
      expect(state.tasks).toEqual([{ id: '1', title: 'First', status: 'completed' }]);
      expect(state.stats.costUSD).toBe(2);
      expect(state.stats.toolCalls).toBe(3);
      // 'mx' foi contada só pela janela (uso final); 'p1' veio do prefixo.
      expect(state.stats.tokensOut).toBe(tailTokensOut + 5);
    } finally {
      tmp.cleanup();
    }
  });

  it.each(['before', 'after'])('TaskCreate keeps the completed task from the prefix when the result arrives %s the merge', (quando) => {
    const prefix = createTranscriptState();
    feed(prefix, [
      L.assistant([L.tool('c1', 'TaskCreate', { subject: 'Old' })]),
      L.result('c1', 'Task #1 created successfully'),
      L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
    ]);
    const state = createTranscriptState({ trackPrefix: true });
    feed(state, [L.assistant([L.tool('c2', 'TaskCreate', { subject: 'New' })])]);
    const result = L.result('c2', 'Task #29 created successfully');
    if (quando === 'before') feed(state, [result]);

    mergePrefix(state, prefix);
    if (quando === 'after') {
      expect(state.tasks).toHaveLength(2);
      expect(state.tasks[0]).toEqual({ id: '1', title: 'Old', status: 'completed' });
      feed(state, [result]);
    }
    expect(state.tasks).toEqual([
      { id: '1', title: 'Old', status: 'completed' },
      { id: '29', title: 'New', status: 'pending' },
    ]);
  });

  it('applyTaskOp ignores an update to an unknown task', () => {
    expect(applyTaskOp([], { op: 'update', id: '9', status: 'completed' })).toEqual([]);
  });
});
