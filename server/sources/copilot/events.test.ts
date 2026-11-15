import { describe, expect, it } from 'vitest';
import { E, ev, sessionId } from '../../test/copilot-fixtures';
import { copilotStatus, createCopilotState, describeCopilotTool, isSessionId, parseEventLine, type CopilotState } from './events';

const S = sessionId(1);
const T0 = Date.parse('2026-11-01T10:00:00.000Z');

function feed(lines: string[], state: CopilotState = createCopilotState()) {
  const results = lines.map((l) => parseEventLine(state, l, { idPrefix: 'acc:s', now: T0 }));
  return { state, results, activities: results.flatMap((r) => r.activities.map((a) => a.activity)) };
}

describe('Copilot events: session and prompts', () => {
  it('session.start gives the id, the folder, the model and the start; the first real prompt is the title', () => {
    const { state, activities } = feed([E.start(S, { at: T0, cwd: '/home/user/project', model: 'model-a' }), E.user('Fix the login form', T0 + 1_000)]);
    expect(state).toMatchObject({ sessionId: S, cwd: '/home/user/project', model: 'model-a', startedAt: T0, title: 'Fix the login form', busy: true });
    expect(activities.map((a) => a.kind)).toEqual(['prompt']);
    expect(activities[0].text).toContain('Fix the login form');
  });

  it('prompts Copilot adds itself (with a source) and empty ones are skipped', () => {
    const { state, activities } = feed([E.user('remembered note', T0, { source: 'memory' }), E.user('   ', T0 + 1)]);
    expect(state.title).toBeUndefined();
    expect(state.busy).toBe(false);
    expect(activities).toEqual([]);
  });

  it('masks secrets in the title and the activity', () => {
    const { state, activities } = feed([E.user('use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 please', T0)]);
    expect(state.title).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(JSON.stringify(activities)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('session.model_change and the usage record change the model', () => {
    const { state } = feed([E.start(S, { at: T0 }), E.modelChange('model-b', T0 + 1)]);
    expect(state.model).toBe('model-b');
    feed([E.usage({ input: 1, output: 1, model: 'model-c', at: T0 + 2 })], state);
    expect(state.model).toBe('model-c');
  });
});

describe('Copilot events: turns and status', () => {
  it('a message with tool requests keeps it working; a final message then turn_end makes it idle', () => {
    const s = createCopilotState();
    feed([E.user('Run the tests', T0), E.turnStart(T0 + 1), E.message('Checking', T0 + 2, [{ toolCallId: 'c1', name: 'bash' }]), E.turnEnd(T0 + 3)], s);
    expect(copilotStatus(s).status).toBe('working');
    feed([E.turnStart(T0 + 4), E.message('All tests pass.', T0 + 5), E.turnEnd(T0 + 6)], s);
    expect(copilotStatus(s).status).toBe('idle');
    expect(s.statusAt).toBe(T0 + 6);
  });

  it('the agentStop hook and abort end the turn', () => {
    const s = createCopilotState();
    feed([E.turnStart(T0), E.agentStop(T0 + 1)], s);
    expect(s.busy).toBe(false);
    const r = feed([E.turnStart(T0 + 2), E.abort(T0 + 3)], s);
    expect(s.busy).toBe(false);
    expect(r.activities.at(-1)?.kind).toBe('wait');
  });

  it('an open tool call (a subagent running) keeps it working through an inner final reply and turn_end', () => {
    const s = createCopilotState();
    feed([E.user('Review the code', T0), E.turnStart(T0 + 1), E.message('', T0 + 2, [{ toolCallId: 'c1', name: 'task' }]), E.toolStart('c1', 'task', { description: 'Review' }, T0 + 3)], s);
    // The subagent's own model call, in the same file: a reply without tool requests, then its turn_end.
    feed([E.turnStart(T0 + 4), E.message('Inner review done.', T0 + 5), E.turnEnd(T0 + 6)], s);
    expect(copilotStatus(s).status).toBe('working');
    expect(s.tools.size).toBe(1);
    // The outer call completes and the outer reply finishes with no tool open: idle.
    feed([E.toolEnd('c1', T0 + 7), E.turnStart(T0 + 8), E.message('All reviewed.', T0 + 9), E.turnEnd(T0 + 10)], s);
    expect(copilotStatus(s).status).toBe('idle');
    expect(s.tools.size).toBe(0);
  });

  it('a tool call that never completes is dropped on abort, on agentStop and on shutdown', () => {
    for (const end of [E.abort(T0 + 3), E.agentStop(T0 + 3), E.shutdown(T0 + 3)]) {
      const s = createCopilotState();
      feed([E.turnStart(T0), E.toolStart('c1', 'bash', { command: 'sleep 999' }, T0 + 1)], s);
      expect(copilotStatus(s).status).toBe('working');
      feed([end], s);
      expect(s.tools.size).toBe(0);
      expect(copilotStatus(s).status).toBe('idle');
    }
  });

  it('an open tool call alone (its turn_start before the read) is working', () => {
    const s = createCopilotState();
    feed([E.toolStart('c1', 'bash', { command: 'npm test' }, T0)], s);
    expect(s.busy).toBe(false);
    expect(copilotStatus(s).status).toBe('working');
  });

  it('permission prompt = waiting with a short reason and the masked command as detail, until completed', () => {
    const s = createCopilotState();
    const r = feed([E.turnStart(T0), E.permission('r1', { kind: 'shell', fullCommandText: 'deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', intention: 'Deploy' }, T0 + 1)], s);
    expect(copilotStatus(s)).toEqual({ status: 'waiting', waitingFor: 'approve a command' });
    expect(r.activities.at(-1)?.text).toContain('approve a command');
    expect(r.activities.at(-1)?.detail).toContain('deploy');
    expect(r.activities.at(-1)?.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    feed([E.permissionDone('other', T0 + 2)], s);
    expect(copilotStatus(s).status).toBe('waiting');
    feed([E.permissionDone('r1', T0 + 3)], s);
    expect(copilotStatus(s).status).toBe('working');
  });

  it('a denied permission shows as denied', () => {
    const s = createCopilotState();
    const r = feed([E.permission('r1', { kind: 'write', path: '/home/user/project/a.ts' }, T0), E.permissionDone('r1', T0 + 1, 'denied-interactively-by-user')], s);
    expect(r.activities.at(-1)?.kind).toBe('wait');
    expect(copilotStatus(s).status).toBe('idle');
  });

  it('session.shutdown ends it; something new after it reopens it', () => {
    const s = createCopilotState();
    feed([E.turnStart(T0), E.permission('r1', { kind: 'read' }, T0 + 1), E.shutdown(T0 + 2)], s);
    expect(s.shutdown).toBe(true);
    expect(copilotStatus(s).status).toBe('idle');
    feed([E.user('again', T0 + 3)], s);
    expect(s.shutdown).toBe(false);
  });
});

describe('Copilot events: tools and tokens', () => {
  it('tool start = activity (by toolCallId) and a counted call; a failure adds an error to the history', () => {
    const s = createCopilotState();
    const r = feed(
      [
        E.toolStart('c1', 'bash', { command: 'npm test', description: 'Run tests' }, T0),
        E.toolEnd('c1', T0 + 1),
        E.toolStart('c2', 'view', { path: '/home/user/project/src/app.ts' }, T0 + 2),
        E.toolEnd('c2', T0 + 3, { success: false, content: 'no such file\nmore' }),
      ],
      s,
    );
    expect(s.stats.toolCalls).toBe(2);
    expect(r.activities.map((a) => [a.id, a.tool, a.kind])).toEqual([
      ['acc:s#c1', 'Bash', 'test'],
      ['acc:s#c2', 'Read', 'read'],
      ['acc:s#c2:e', 'Read', 'error'],
    ]);
    expect(r.activities[0].text).toBe('Running tests');
    expect(r.activities[1].text).toBe('Reading app.ts');
    expect(r.results.at(-1)?.activities[0].current).toBe(false);
  });

  it('tokens: the usage records are summed (input already has the cache)', () => {
    const { state } = feed([E.usage({ input: 1_000, cacheRead: 800, output: 50, at: T0 }), E.usage({ input: 2_000, cacheRead: 1_900, output: 70, at: T0 + 1 })]);
    expect(state.stats).toMatchObject({ tokensIn: 3_000, tokensOut: 120 });
  });

  it('tool names map to the usual activities', () => {
    expect(describeCopilotTool('edit', { path: '/x/a.ts' }).tool).toBe('Edit');
    expect(describeCopilotTool('create', { path: '/x/b.ts' }).tool).toBe('Write');
    expect(describeCopilotTool('glob', { pattern: '**/*.ts' }).tool).toBe('Glob');
    expect(describeCopilotTool('grep', { pattern: 'TODO' }).desc.text).toContain('TODO');
    expect(describeCopilotTool('web_fetch', { url: 'https://example.com/x' }).tool).toBe('WebFetch');
    expect(describeCopilotTool('something_new', {}).tool).toBe('something_new');
  });
});

describe('Copilot events: robustness', () => {
  it('unknown types, broken JSON, missing fields and odd shapes generate nothing and do not throw', () => {
    const s = createCopilotState();
    const lines = [
      '{not json',
      '[]',
      '"text"',
      JSON.stringify({ data: {} }),
      ev('future.event', { anything: 1 }, T0),
      JSON.stringify({ type: 'tool.execution_start', data: null, timestamp: 'bad' }),
      JSON.stringify({ type: 'permission.requested', data: { permissionRequest: { kind: 'shell' } } }),
      JSON.stringify({ type: 'session.usage_record', data: { usage: 'x' } }),
      JSON.stringify({ type: 'assistant.message', data: { toolRequests: 'x', content: 5 } }),
    ];
    expect(() => feed(lines, s)).not.toThrow();
    expect(s.permissions.size).toBe(0);
    expect(s.stats.tokensIn).toBe(0);
  });

  it('isSessionId only accepts UUIDs', () => {
    expect(isSessionId(S)).toBe(true);
    expect(isSessionId('../etc')).toBe(false);
    expect(isSessionId(`${S}/x`)).toBe(false);
  });
});
