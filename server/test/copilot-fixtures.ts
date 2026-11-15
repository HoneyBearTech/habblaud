// Builders of SYNTHETIC Copilot CLI session events (events.jsonl lines) and of a temporary Copilot folder
// (session-state/<session>/events.jsonl and workspace.yaml, open-sessions-state.json), for tests. The shapes follow
// the documented envelope {type, data, id, timestamp, parentId}; every value here is made up.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLines, tempDir, writeLines } from './fixtures';

/** Synthetic session id (UUID shape). */
export function sessionId(n: number): string {
  return `5e550000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let seq = 0;
const ts = (at: number) => new Date(at).toISOString();

/** One events.jsonl line. */
export function ev(type: string, data: Record<string, unknown>, at: number, id?: string): string {
  return JSON.stringify({ type, data, id: id ?? `e0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, timestamp: ts(at), parentId: null });
}

/** Events builders. */
export const E = {
  start(s: string, o: { at: number; cwd?: string; model?: string }): string {
    return ev('session.start', { sessionId: s, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.0', startTime: ts(o.at), selectedModel: o.model ?? 'test-model-1', context: { cwd: o.cwd ?? '/home/user/project' } }, o.at);
  },
  modelChange(model: string, at: number): string {
    return ev('session.model_change', { newModel: model, previousModel: 'test-model-1' }, at);
  },
  user(text: string, at: number, extra: Record<string, unknown> = {}): string {
    return ev('user.message', { content: text, transformedContent: `<wrapped>${text}</wrapped>`, ...extra }, at);
  },
  turnStart(at: number): string {
    return ev('assistant.turn_start', { agentMode: 'interactive' }, at);
  },
  turnEnd(at: number): string {
    return ev('assistant.turn_end', {}, at);
  },
  message(text: string, at: number, toolRequests: Array<Record<string, unknown>> = []): string {
    return ev('assistant.message', { content: text, toolRequests, model: 'test-model-1' }, at);
  },
  toolStart(callId: string, toolName: string, args: Record<string, unknown>, at: number): string {
    return ev('tool.execution_start', { toolCallId: callId, toolName, arguments: args, toolTitle: 'Running command' }, at);
  },
  toolEnd(callId: string, at: number, o: { success?: boolean; content?: string } = {}): string {
    return ev('tool.execution_complete', { toolCallId: callId, success: o.success ?? true, result: { content: o.content ?? 'ok' } }, at);
  },
  permission(requestId: string, req: Record<string, unknown>, at: number): string {
    return ev('permission.requested', { requestId, permissionRequest: req }, at);
  },
  permissionDone(requestId: string, at: number, kind = 'approved'): string {
    return ev('permission.completed', { requestId, result: { kind } }, at);
  },
  usage(o: { input: number; output: number; cacheRead?: number; model?: string; at: number }): string {
    return ev('session.usage_record', { usage: { model: o.model ?? 'test-model-1', inputTokens: o.input, outputTokens: o.output, cacheReadTokens: o.cacheRead ?? 0 } }, o.at);
  },
  agentStop(at: number): string {
    return ev('hook.start', { hookType: 'agentStop', input: { stopReason: 'end_turn' } }, at);
  },
  abort(at: number): string {
    return ev('abort', { reason: 'user' }, at);
  },
  /** session.shutdown; with `totalNanoAiu`, the session's running AI-unit total (billionths of a unit). */
  shutdown(at: number, totalNanoAiu?: number): string {
    const data: Record<string, unknown> = { shutdownType: 'routine' };
    if (totalNanoAiu !== undefined) data.totalNanoAiu = totalNanoAiu;
    return ev('session.shutdown', data, at);
  },
  /** session.usage_checkpoint with the session's running AI-unit total (billionths of a unit; 1e9 = 1 credit). */
  checkpoint(totalNanoAiu: unknown, at: number): string {
    return ev('session.usage_checkpoint', { totalNanoAiu, accountingSnapshot: { aiCreditsStatus: 'complete' } }, at);
  },
  /** A premium-request record (`cost`, `initiator`): never counted as AI credits. */
  premium(at: number): string {
    return ev('session.usage_record', { cost: 1, initiator: 'user', totalNanoAiu: 999_000_000_000 }, at);
  },
};

/** A temporary Copilot folder (`name` inside a temporary $HOME). */
export function copilotHome(name = '.copilot') {
  const tmp = tempDir('habblaud-copilot-');
  const dir = join(tmp.dir, name);
  mkdirSync(join(dir, 'session-state'), { recursive: true });
  return {
    home: tmp.dir,
    dir,
    cleanup: tmp.cleanup,
    /** Writes the session's events.jsonl (and, with `cwd`, its workspace.yaml). Returns the events path. */
    session(s: string, lines: string[], o: { cwd?: string; mtime?: number; workspace?: string } = {}): string {
      const folder = join(dir, 'session-state', s);
      const path = join(folder, 'events.jsonl');
      writeLines(path, lines);
      if (o.workspace !== undefined) writeFileSync(join(folder, 'workspace.yaml'), o.workspace);
      else if (o.cwd) writeFileSync(join(folder, 'workspace.yaml'), `id: ${s}\ncwd: ${o.cwd}\ncreated_at: 2026-11-01T10:00:00.000Z\nclient_name: test-client\n`);
      if (o.mtime !== undefined) utimesSync(path, o.mtime / 1000, o.mtime / 1000);
      return path;
    },
    append(path: string, lines: string[]): void {
      appendLines(path, lines);
    },
    /** Writes open-sessions-state.json listing these sessions (refreshedAt: epoch ms, default an old fixed date). */
    open(ids: string[], o: { refreshedAt?: number } = {}): void {
      const body: Record<string, unknown> = {};
      const refreshedAt = o.refreshedAt === undefined ? '2026-11-01T10:00:00.000Z' : ts(o.refreshedAt);
      for (const id of ids) body[id] = { schemaVersion: 1, openedAt: '2026-11-01T10:00:00.000Z', refreshedAt, working: false };
      writeFileSync(join(dir, 'open-sessions-state.json'), JSON.stringify(body));
    },
  };
}
