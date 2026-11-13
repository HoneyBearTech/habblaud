import { describe, expect, it } from 'vitest';
import { notificationOutcome, SHELL_MAX_AGE_MS, ShellTracker, toShellJob, type ShellStart } from './shells';

const T0 = Date.parse('2026-10-07T08:50:00Z');

const bash = (toolUseId: string, at: number, extra: Partial<ShellStart> = {}): ShellStart => ({
  toolUseId,
  label: 'Run the complete suite',
  command: 'vendor/bin/phpunit',
  background: true,
  kind: 'shell',
  at,
  ...extra,
});

describe('notificationOutcome', () => {
  it('the Claude Code status and, without it, the summary', () => {
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 0)')).toBe('ok');
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 2)')).toBe('failed');
    expect(notificationOutcome('shell', 'failed', undefined)).toBe('failed');
    expect(notificationOutcome('shell', 'killed', undefined)).toBe('killed');
    expect(notificationOutcome('shell', undefined, 'Background command "x" failed with exit code 1')).toBe('failed');
    expect(notificationOutcome('shell', undefined, undefined)).toBe('ok');
    // Monitor: each event is a notification; only a terminal status ends it.
    expect(notificationOutcome('monitor', undefined, 'log line')).toBeUndefined();
    expect(notificationOutcome('monitor', 'running', undefined)).toBeUndefined();
    expect(notificationOutcome('monitor', 'completed', undefined)).toBe('ok');
  });
});

describe('ShellTracker', () => {
  it('background: the launch swaps the id for the task id; the notification ends it only once', () => {
    const s = new ShellTracker();
    s.start('main', bash('toolu_1', T0));
    expect(s.list().map(toShellJob)).toEqual([
      { id: 'toolu_1', label: 'Run the complete suite', command: 'vendor/bin/phpunit', startedAt: T0, background: true, kind: 'shell' },
    ]);
    // The command actually starts at launch (after a possible approval).
    s.result('toolu_1', { taskId: 'bo0ov3q3l', error: false, at: T0 + 4_000 });
    expect(s.list().map(toShellJob)[0]).toMatchObject({ id: 'bo0ov3q3l', startedAt: T0 + 4_000 });
    expect(s.hasBackgroundShell(T0 + 60_000)).toBe(true);
    const fin = s.notify({ taskId: 'bo0ov3q3l', status: 'completed', summary: 'ok (exit code 0)', at: T0 + 480_000 });
    expect(fin).toMatchObject({ outcome: 'ok', at: T0 + 480_000, job: { owner: 'main', label: 'Run the complete suite' } });
    expect(s.list()).toEqual([]);
    // The same notification delivered again (queue -> message) does not end it again.
    expect(s.notify({ taskId: 'bo0ov3q3l', toolUseId: 'toolu_1', status: 'completed', at: T0 + 481_000 })).toBeUndefined();
    expect(s.reportedRecently({ toolUseId: 'toolu_1' }, T0 + 481_000)).toBe(true);
    // Rereading the transcript does not resurrect the job.
    s.start('main', bash('toolu_1', T0));
    expect(s.size).toBe(0);
  });

  it('foreground: leaves on the result; sent to the background, it becomes background without losing the start', () => {
    const s = new ShellTracker();
    s.start('main', bash('fg1', T0, { background: false }));
    s.start('main', bash('fg2', T0 + 1_000, { background: false }));
    expect(s.list().map((j) => [j.toolUseId, j.background])).toEqual([
      ['fg1', false],
      ['fg2', false],
    ]);
    expect(s.hasBackgroundShell(T0 + 2_000)).toBe(false);
    s.result('fg1', { error: false, at: T0 + 30_000 });
    s.result('fg2', { taskId: 'bmanual1', error: false, at: T0 + 40_000 });
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'bmanual1', background: true, startedAt: T0 + 1_000 })]);
  });

  it('error in the tool_result, end of turn and interruption end it without a notification', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bx', error: true, at: T0 + 1 });
    s.start('main', bash('f1', T0, { background: false }));
    s.start('sub', bash('f2', T0, { background: false }));
    s.endForeground('main', T0 + 2);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['f2']);
  });

  it('TaskStop/KillShell kills by the task id', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bkill', error: false, at: T0 });
    expect(s.stop('bkill', T0 + 9_000)).toMatchObject({ outcome: 'killed', job: { toolUseId: 'b1' } });
    expect(s.size).toBe(0);
    // The "killed" notification that comes afterward is ignored.
    expect(s.notify({ taskId: 'bkill', status: 'killed', at: T0 + 9_500 })).toBeUndefined();
  });

  it('discards what cannot be running: older than the process, more than 24 h, expired monitor', () => {
    const s = new ShellTracker();
    s.start('main', bash('old', T0 - 60_000));
    s.start('main', bash('new', T0 + 1_000));
    s.start('main', bash('mon', T0 + 1_000, { kind: 'monitor', timeoutMs: 60_000 }));
    expect(s.prune(T0 + 2_000, T0)).toBe(true);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['mon', 'new']);
    s.prune(T0 + 1_000 + 60_000 + 61_000);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['new']);
    s.prune(T0 + 1_000 + SHELL_MAX_AGE_MS + 1);
    expect(s.size).toBe(0);
  });

  it('pending approval hides the foreground command and resets its clock', () => {
    const s = new ShellTracker();
    s.start('main', bash('f1', T0, { background: false }));
    s.holdForeground(true, T0 + 60_000);
    expect(s.list()).toEqual([]);
    s.holdForeground(false, T0 + 61_000);
    expect(s.list()[0]).toMatchObject({ toolUseId: 'f1', startedAt: T0 + 60_000 });
  });

  it('merges the beginning of the file without reviving what the window already saw finish', () => {
    const s = new ShellTracker();
    // End window: completion of a shell whose start stayed in the start of the file, and the launch of another.
    s.notify({ toolUseId: 'old', taskId: 'bold', status: 'completed', at: T0 + 10 });
    s.result('running', { taskId: 'brun', error: false, at: T0 + 5 });
    const older = new ShellTracker();
    older.start('main', bash('old', T0));
    older.start('main', bash('running', T0));
    older.start('main', bash('fg', T0, { background: false }));
    expect(s.merge(older.openBackground())).toBe(true);
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'brun', startedAt: T0 + 5 })]);
    expect(s.notify({ taskId: 'brun', status: 'failed', at: T0 + 20 })).toMatchObject({ outcome: 'failed' });
  });
});
