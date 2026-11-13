import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ptyRequestProblem } from '../http/pty';
import {
  claudeBinFrom,
  findExecutable,
  fixSpawnHelper,
  isExecutableFile,
  MAX_PTYS,
  PtyError,
  PtyManager,
  spawnProblem,
  type PtyAgentRef,
  type PtyManagerOptions,
  type PtyProcess,
  type PtyScreen,
  type SpawnPty,
} from './manager';
import type { ProcInfo } from './procinfo';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PID = 4242;
const STARTED = 1_791_557_339_236;

class FakeProc implements PtyProcess {
  data: (d: string) => void = () => {};
  exit: (e: { exitCode: number }) => void = () => {};
  written: string[] = [];
  constructor(readonly pid: number) {}
  onData(cb: (d: string) => void) {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {
    this.exit({ exitCode: 0 });
  }
}

interface Setup {
  manager: PtyManager;
  spawned: { args: string[]; cwd: string }[];
  alive: Set<number>;
  killPid: ReturnType<typeof vi.fn>;
  forceKill: ReturnType<typeof vi.fn>;
}

/** Gerenciador com tudo de fora trocado: um agente "acc:4242" aberto noutro terminal, vivo e conferido. */
function setup(over: Partial<Omit<PtyManagerOptions, 'agent'>> & { agent?: Partial<PtyAgentRef>; proc?: ProcInfo | undefined; session?: unknown } = {}): Setup {
  const { agent: agentOver, proc: procOver, session, ...opts } = over;
  const alive = new Set([PID]);
  const spawned: Setup['spawned'] = [];
  let nextPid = 9000;
  const agent: PtyAgentRef = { id: `acc:${PID}`, kind: 'main', account: 'acc', sessionId: SESSION, cwd: tmpdir(), ...agentOver };
  const proc = 'proc' in over ? procOver : { startMs: STARTED - 800, name: 'claude' };
  const killPid = vi.fn((pid: number) => void alive.delete(pid));
  const forceKill = vi.fn((pid: number) => void alive.delete(pid));
  const manager = new PtyManager({
    spawn: (_file, args, o) => {
      spawned.push({ args, cwd: o.cwd });
      return new FakeProc(++nextPid);
    },
    claudeBin: process.execPath,
    accounts: () => [{ id: 'acc', dir: join(tmpdir(), 'account'), isDefault: true }],
    agent: (id) => (id === agent.id ? agent : undefined),
    onChange: () => {},
    readSession: () => session ?? { sessionId: SESSION, startedAt: STARTED },
    procInfo: async (pid) => (alive.has(pid) ? proc : undefined),
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    killPid,
    forceKill,
    ...opts,
  });
  return { manager, spawned, alive, killPid, forceKill };
}

async function rejects(p: Promise<unknown>, status: number): Promise<PtyError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PtyError);
  expect((err as PtyError).status).toBe(status);
  return err as PtyError;
}

describe('PtyManager: checking the process before ending it', () => {
  it('ends it when record, start and executable match', async () => {
    const s = setup();
    await s.manager.stop(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledWith(PID, expect.objectContaining({ name: 'claude' }));
  });

  it('refuses when the record is from another session', async () => {
    const s = setup({ session: { sessionId: 'other', startedAt: STARTED } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('refuses a reused PID (the live process started well after the record)', async () => {
    const s = setup({ proc: { startMs: STARTED + 3_600_000, name: 'claude' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('refuses when the executable is not Claude Code', async () => {
    const s = setup({ proc: { startMs: STARTED - 800, name: 'chrome' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('on Windows, the FILETIME of the record has to be the exact one', async () => {
    const reg = { sessionId: SESSION, startedAt: STARTED, procStart: '134360309381229341' };
    const other = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229342' } });
    await rejects(other.manager.stop(`acc:${PID}`), 409);
    const same = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229341' } });
    await same.manager.stop(`acc:${PID}`);
    expect(same.killPid).toHaveBeenCalledOnce();
  });

  it('refuses when nothing can be known about the process', async () => {
    const s = setup({ proc: undefined });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });
});

describe('PtyManager: taking over', () => {
  it('ends it there and resumes the same conversation here', async () => {
    const s = setup();
    const info = await s.manager.takeover(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toEqual([{ args: ['--resume', SESSION], cwd: tmpdir() }]);
    expect(info).toMatchObject({ resumed: SESSION, fromAgent: `acc:${PID}` });
  });

  it('folder that does not exist: refuses before ending the session over there', async () => {
    const s = setup({ agent: { cwd: join(tmpdir(), 'does-not-exist-habblaud-test') } });
    await rejects(s.manager.takeover(`acc:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('unknown account: refuses before ending', async () => {
    const s = setup({ agent: { account: 'gone', id: `gone:${PID}` } });
    await rejects(s.manager.takeover(`gone:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('terminal limit: refuses before ending', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS; i++) s.manager.create({ cwd: tmpdir() });
    await rejects(s.manager.takeover(`acc:${PID}`), 429);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('the last slot goes to the takeover in progress', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS - 1; i++) s.manager.create({ cwd: tmpdir() });
    const run = s.manager.takeover(`acc:${PID}`);
    expect(() => s.manager.create({ cwd: tmpdir() })).toThrow(/limit/);
    await run;
    expect(s.spawned).toHaveLength(MAX_PTYS);
  });

  it('simultaneous requests from the same agent open only one terminal', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.manager.takeover(`acc:${PID}`), s.manager.takeover(`acc:${PID}`)]);
    expect(a.id).toBe(b.id);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toHaveLength(1);
  });

  it('did not exit in time: ends it by force and goes on with --resume', async () => {
    const s = setup({ killPid: vi.fn() });
    await s.manager.takeover(`acc:${PID}`);
    expect(s.forceKill).toHaveBeenCalledWith(PID);
    expect(s.spawned).toHaveLength(1);
  });

  it('not even by force: error, without opening the second copy of the conversation', async () => {
    const s = setup({ killPid: vi.fn(), forceKill: vi.fn() });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toMatch(/still open/);
    expect(s.spawned).toHaveLength(0);
  });

  it('claude that does not run: refuses before ending', async () => {
    const s = setup({ claudeBin: join(tmpdir(), 'does-not-exist-habblaud-claude') });
    await rejects(s.manager.takeover(`acc:${PID}`), 503);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('did not open here after ending there: the error says how to continue the conversation', async () => {
    const s = setup({
      spawn: () => {
        throw new Error('posix_spawnp failed.');
      },
    });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toContain(`claude --resume ${SESSION}`);
    expect(err.message).toContain('posix_spawnp failed');
  });

  it('old record (reused PID): does not end anyone', async () => {
    const s = setup({ proc: { startMs: STARTED + 86_400_000, name: 'node' } });
    await rejects(s.manager.takeover(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.spawned).toHaveLength(0);
  });
});

/** Resposta SSE de mentira: guarda o que foi escrito. */
function fakeStream(): { req: IncomingMessage; res: ServerResponse; out: string[] } {
  const out: string[] = [];
  const req = Object.assign(new EventEmitter(), { socket: { setTimeout() {}, setNoDelay() {} } }) as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead() {},
    write(chunk: string) {
      out.push(chunk);
      return true;
    },
    end() {
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  }) as unknown as ServerResponse;
  return { req, res, out };
}

describe('PtyManager: screen for whoever connects', () => {
  it('sends the assembled screen and, afterward, the output that arrived while it was finishing processing', () => {
    const pendingWrites: (() => void)[] = [];
    let content = '';
    const screen: PtyScreen = {
      write(data, done) {
        // Processa depois, como o xterm.
        pendingWrites.push(() => {
          content += data;
          done?.();
        });
      },
      resize() {},
      serialize: () => `[screen:${content}]`,
      dispose() {},
    };
    let proc: FakeProc | undefined;
    const manager = new PtyManager({
      spawn: () => (proc = new FakeProc(77)),
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: tmpdir(), isDefault: true }],
      agent: () => undefined,
      onChange: () => {},
      createScreen: () => screen,
    });
    const info = manager.create({ cwd: tmpdir() });
    proc!.data('before ');
    const { req, res, out } = fakeStream();
    manager.attach(info.id, req, res);
    proc!.data('during');
    // Nada além do cabeçalho até a tela processar o que veio antes.
    expect(out.join('')).not.toContain('screen');
    for (const w of pendingWrites.splice(0)) w();
    const text = out.join('');
    expect(text.indexOf('[screen:before ]')).toBeGreaterThan(-1);
    expect(text.indexOf('during')).toBeGreaterThan(text.indexOf('[screen:before ]'));
    proc!.data('after');
    expect(out.join('')).toContain('after');
  });
});

describe('ptyRequestProblem', () => {
  const req = (h: Record<string, string>, addr = '127.0.0.1') => ({ socket: { remoteAddress: addr }, headers: h }) as unknown as IncomingMessage;

  it('accepts the computer itself, same origin', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://localhost:4747', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(ptyRequestProblem(req({ host: '127.0.0.1:4747' }, '::ffff:127.0.0.1'))).toBeNull();
  });

  it('refuses a connection from outside, a network Host, another origin and a request from another site', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747' }, '192.168.0.9'))).toMatch(/the computer running/);
    expect(ptyRequestProblem(req({ host: 'my-mac.local:4747' }))).toMatch(/localhost/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://evil.example' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'same-site' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'cross-site' }))).toMatch(/origin/);
  });
});

describe('loading node-pty and finding claude', () => {
  const unix = process.platform !== 'win32';

  /** Pasta temporária, apagada no fim. */
  function withDir(fn: (dir: string) => void | Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'habblaud-pty-'));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it.runIf(unix)(
    'gives the execute permission back to spawn-helper (node-pty 1.1.0 is published without it)',
    withDir((dir) => {
      const sub = join(dir, 'prebuilds', 'darwin-arm64');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'spawn-helper'), '');
      chmodSync(join(sub, 'spawn-helper'), 0o644);
      fixSpawnHelper(dir, 'darwin', 'arm64');
      expect(statSync(join(sub, 'spawn-helper')).mode & 0o777).toBe(0o755);
      // Sem spawn-helper nenhum: nada a fazer, sem erro.
      expect(() => fixSpawnHelper(join(dir, 'empty'), 'darwin', 'arm64')).not.toThrow();
    }),
  );

  it('test terminal: points out the reason when the spawn fails or the process exits with an error', async () => {
    const failing: SpawnPty = () => {
      throw new Error('posix_spawnp failed.');
    };
    expect(await spawnProblem(failing)).toMatch(/posix_spawnp failed/);
    const exiting = (code: number): SpawnPty => () => {
      const p = new FakeProc(1);
      queueMicrotask(() => p.exit({ exitCode: code }));
      return p;
    };
    expect(await spawnProblem(exiting(0))).toBeNull();
    expect(await spawnProblem(exiting(1))).toMatch(/code 1/);
  });

  it.runIf(unix)(
    'executable: must exist and be able to run; the PATH skips what does not run',
    withDir((dir) => {
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, 'claude'), '#!/bin/sh\n');
      chmodSync(join(a, 'claude'), 0o644);
      writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
      chmodSync(join(b, 'claude'), 0o755);
      expect(isExecutableFile(join(a, 'claude'))).toBe(false);
      expect(isExecutableFile(join(b, 'claude'))).toBe(true);
      expect(isExecutableFile(dir)).toBe(false);
      const env = { PATH: `${a}:${b}` };
      expect(findExecutable('claude', env)).toBe(join(b, 'claude'));
      expect(claudeBinFrom(env)).toBe(join(b, 'claude'));
      // HABBLAUD_CLAUDE_BIN: um caminho vale como está; um nome é procurado no PATH.
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: join(a, 'claude') })).toBe(join(a, 'claude'));
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: 'claude' })).toBe(join(b, 'claude'));
      expect(claudeBinFrom({ ...env, HABBLAUD_CLAUDE_BIN: 'other' })).toBeUndefined();
    }),
  );
});
