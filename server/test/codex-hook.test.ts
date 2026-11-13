// Codex hook (mod/habblaud-codex/hook.mjs) run as a real process against the test server (real routes
// and a fake Codex source): observation events (no output), the account by CODEX_HOME, by
// transcript_path or ~/.codex, the configuration in ~/.habblaud/codex-hook.json, and the PermissionRequest (approve,
// deny, terminal, timed out, Habblaud down). HOME and CODEX_HOME always in temporary folders; synthetic stdin.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { CODEX_MAIN, CODEX_THREAD, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-codex/hook.mjs');

/** Functions exported by the hook (plain JavaScript, no types). */
interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; waitMs: number };
  codexHomeOf(env: NodeJS.ProcessEnv, input: unknown): string;
  accountOf(codexHome: string): string;
  eventBody(input: Record<string, unknown>, account: string, codexHome: string): Record<string, unknown>;
  permissionBody(input: Record<string, unknown>, account: string, codexHome: string, timeoutMs: number): Record<string, unknown>;
  decisionOutput(result: unknown): unknown;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

/** Fake Codex source: keeps the events received. */
class FakeLive {
  calls: Array<{ account: string | undefined; input: Record<string, unknown> }> = [];
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    this.calls.push({ account, input });
    return true;
  }
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let codexHome: string;
let srv: PermissionServer | undefined;
let live: FakeLive;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  codexHome = join(home, '.codex-work');
  mkdirSync(codexHome, { recursive: true });
  live = new FakeLive();
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  tmp.cleanup();
});

/** ~/.habblaud/codex-hook.json in the fake HOME. */
function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'codex-hook.json'), JSON.stringify(cfg));
}

function runHook(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** JSON (synthetic) of a Codex hook event. */
function codexEvent(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: CODEX_THREAD,
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: '/p/store',
    hook_event_name: event,
    model: 'gpt-test',
    permission_mode: 'default',
    ...over,
  };
}

const permission = (over: Record<string, unknown> = {}) => codexEvent('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, ...over });

async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(CODEX_MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('the hook did not register the request');
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe('Codex hook.mjs (process)', () => {
  it('observation event: goes to /api/codex/events with the account and the CODEX_HOME; nothing on stdout', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const input = codexEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'ls' } });
    const r = await runHook(JSON.stringify(input), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(live.calls).toEqual([{ account: '.codex-work', input }]);
    expect(srv.registry!.size).toBe(0);
  });

  it('the account comes from transcript_path when CODEX_HOME does not arrive (the environment of the hook is that of the daemon); otherwise ~/.codex', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const transcript = join(codexHome, 'sessions', '2026', '10', '09', `rollout-2026-10-09T09-00-00-${CODEX_THREAD}.jsonl`);
    await runHook(JSON.stringify(codexEvent('Stop', { transcript_path: transcript, last_assistant_message: 'done' })));
    await runHook(JSON.stringify(codexEvent('SessionEnd', { reason: 'other' })));
    expect(live.calls.map((c) => c.account)).toEqual(['.codex-work', '.codex']);
  });

  it('huge texts (command output in PostToolUse) go truncated, fitting in the server limit', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const big = codexEvent('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'cat x' }, tool_response: { output: 'x'.repeat(600_000) } });
    const r = await runHook(JSON.stringify(big), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(live.calls).toHaveLength(1);
    expect((live.calls[0].input.tool_response as { output: string }).output.length).toBe(8_000);
  });

  it('PermissionRequest approved in Habblaud: sends the event, logs and prints allow (only that)', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port, permissionTimeoutS: 30 });
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    const id = await pendingId(srv);
    expect(live.calls.map((c) => c.input.hook_event_name)).toEqual(['PermissionRequest']);
    const info = srv.registry!.detail(id)!;
    expect(info).toMatchObject({ provider: 'codex', tool: 'Bash', title: 'Bash(npm test)' });
    // The wait from the file (30 s) becomes the deadline of the request in the office.
    expect(info.expiresAt - info.createdAt).toBeGreaterThan(25_000);
    expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30_000);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n');
  });

  it('denied with a reason: deny with the message (no interrupt); "answer in the terminal": nothing on stdout', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    let run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    let r = await run;
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the user in Habblaud: use pnpm' } } });
    run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('HABBLAUD_PORT counts as a fallback when the file does not have the port', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome, HABBLAUD_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow' });
    expect(JSON.parse((await run).stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('Habblaud down, no page open or unknown session: exits fast, without a decision', async () => {
    writeConfig({ port: await deadPort() });
    let r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    srv = await servePermissions({ codex: true, codexLive: live, viewers: 0 });
    writeConfig({ port: srv.port });
    r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    r = await runHook(JSON.stringify(permission({ session_id: '0199ffff-0000-7000-8000-000000000000' })), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('wait timed out (permissionTimeoutS: 5): gives up and exits without a decision (Codex follows the normal approval)', async () => {
    srv = await servePermissions({ codex: true, codexLive: live, registry: { orphanMs: 300 } });
    writeConfig({ port: srv.port, permissionTimeoutS: 5 });
    const r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(10_000);
  }, 20_000);

  it('invalid stdin or an event that Habblaud does not use: nothing is sent', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    for (const stdin of ['', 'not json', '[]', JSON.stringify({ hook_event_name: 'Stop' }), JSON.stringify(codexEvent('PreCompact', { trigger: 'auto' }))]) {
      const r = await runHook(stdin, { CODEX_HOME: codexHome });
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(live.calls).toHaveLength(0);
  });
});

describe('Codex hook.mjs (functions)', () => {
  it('readConfig: file, HABBLAUD_PORT fallback, defaults and wait limits', () => {
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4851, waitMs: 25_000 });
    writeConfig({ port: 4900, permissionTimeoutS: 60 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4900, waitMs: 60_000 });
    writeConfig({ port: 'x', permissionTimeoutS: 1 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 5_000 });
    writeConfig({ permissionTimeoutS: 999 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 120_000 });
    writeFileSync(join(home, '.habblaud', 'codex-hook.json'), '{ broken');
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
  });

  it('codexHomeOf/accountOf: CODEX_HOME (with ~), transcript_path (sessions/ or archived_sessions/) and ~/.codex', () => {
    // resolve/join like the hook: on Windows, with the drive letter and `\`.
    expect(hook.codexHomeOf({ HOME: '/u', CODEX_HOME: '~/.codex-b/' }, {})).toBe(resolve('/u/.codex-b'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-c/sessions/2026/10/09/rollout-a-${CODEX_THREAD}.jsonl` })).toBe(resolve('/x/.codex-c'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-d/archived_sessions/rollout-a.jsonl` })).toBe(resolve('/x/.codex-d'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: 'relative/sessions/2026/10/09/r.jsonl' })).toBe(join('/u', '.codex'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: null })).toBe(join('/u', '.codex'));
    expect(hook.accountOf('/u/.codex')).toBe('.codex');
  });

  it('permissionBody: provider codex, account and only what Habblaud uses', () => {
    const body = hook.permissionBody(permission({ agent_id: 'child', agent_type: 'worker', tool_input: { command: 'y'.repeat(20_000) } }), '.codex', '/u/.codex', 25_000);
    expect(Object.keys(body).sort()).toEqual(['account', 'agent_id', 'agent_type', 'codexHome', 'cwd', 'provider', 'session_id', 'timeout_ms', 'tool_input', 'tool_name', 'turn_id']);
    expect(body).toMatchObject({ provider: 'codex', account: '.codex', codexHome: '/u/.codex', session_id: CODEX_THREAD, tool_name: 'Bash', timeout_ms: 25_000 });
    expect((body.tool_input as { command: string }).command.length).toBe(8_000);
    expect(JSON.stringify(hook.eventBody(codexEvent('Stop'), '.codex', '/u/.codex'))).toContain('"hook_event_name":"Stop"');
  });

  it('decisionOutput: only allow and deny (+message); never updatedInput, updatedPermissions or interrupt', () => {
    const allow = hook.decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 0 });
    expect(allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', interrupt: true })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the user in Habblaud.' } },
    });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'answer', answers: [] })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'released', reason: 'terminal' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(hook.decisionOutput(undefined)).toBeUndefined();
  });
});
