// Copilot CLI terminal: converts the events.jsonl lines into TerminalEntry (prompts, replies, tool calls with their
// output, permission prompts, interruptions and the end of the session), with secrets masked and texts truncated by
// the same rules as the other terminals (sources/terminal.ts). Prompts that Copilot adds itself (with a `source`,
// e.g. memory notes) are left out, like in the activity parser (events.ts).
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { describePermission } from './events';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

const SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Copilot tool → the name and arguments of the terminal view (toolView). */
function viewOf(name: string, args: Rec): { tool: string; input: Rec } {
  const path = str(args.path) ?? str(args.file_path);
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
    case 'powershell':
      return { tool: 'Bash', input: { command: str(args.command) ?? '' } };
    case 'view':
    case 'read':
    case 'read_file':
      return { tool: 'Read', input: path ? { file_path: path } : {} };
    case 'edit':
    case 'str_replace':
    case 'str_replace_editor':
      return { tool: 'Edit', input: { file_path: path ?? '', old_string: args.old_str ?? args.old_string ?? '', new_string: args.new_str ?? args.new_string ?? '' } };
    case 'create':
    case 'write':
    case 'write_file':
      return { tool: 'Write', input: { file_path: path ?? '', content: args.file_text ?? args.content ?? '' } };
    case 'glob':
      return { tool: 'Glob', input: { pattern: args.pattern, path: args.paths ?? args.path } };
    case 'grep':
    case 'rg':
      return { tool: 'Grep', input: { pattern: args.pattern, path: args.paths ?? args.path } };
    case 'web_fetch':
      return { tool: 'WebFetch', input: { url: args.url } };
    default:
      return { tool: name, input: args };
  }
}

/** Text of a tool result: `result.content` (text) or `error.message`. */
function resultText(d: Rec): string {
  return str(rec(d.error)?.message) ?? str(rec(d.result)?.content) ?? '';
}

class CopilotTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Line too strange: whatever has already come out of it stays; the reading goes on.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    if (!j || typeof j.type !== 'string') return;
    const d = rec(j.data) ?? {};
    const ts = toMs(j.timestamp);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const key = str(j.id) ?? `l${++this.seq}`;
    switch (j.type) {
      case 'session.start':
        this.cwd = str(rec(d.context)?.cwd) ?? this.cwd;
        return;
      case 'user.message': {
        if (d.source !== undefined && d.source !== null) return;
        const text = marked(prepare(str(d.content) ?? '', TEXT_MAX));
        if (text) this.emit({ kind: 'user', id: `${key}:u`, at, text });
        return;
      }
      case 'assistant.message': {
        const thinking = str(d.reasoningText);
        if (thinking) this.emit({ kind: 'thinking', id: `${key}:t`, at, text: marked(prepare(thinking, THINKING_MAX)) });
        const text = marked(prepare(str(d.content) ?? '', TEXT_MAX));
        if (text) this.emit({ kind: 'assistant', id: key, at, text });
        return;
      }
      case 'tool.execution_start': {
        const id = str(d.toolCallId) ?? key;
        const name = str(d.toolName) ?? 'tool';
        const v = viewOf(name, rec(d.arguments) ?? {});
        return this.tool(id, at, v.tool, toolView(v.tool, v.input, this.cwd));
      }
      case 'tool.execution_complete': {
        const id = str(d.toolCallId);
        if (!id) return;
        return this.result(id, at, resultText(d), d.success === false);
      }
      case 'permission.requested':
        return this.sys(key, at, tr('Needs you: {0}', [describePermission(rec(d.permissionRequest))]), { level: 'warn' });
      case 'abort':
        return this.sys(key, at, tr('Interrupted by user'), { level: 'warn' });
      case 'session.shutdown':
        return this.sys(key, at, tr('Session ended'));
      default:
        return;
    }
  }

  private sys(id: string, at: number, text: string, o: { level?: SystemEntry['level'] } = {}): void {
    this.emit({ kind: 'system', id: `${id}:s`, at, text: maskSecrets(text), level: o.level ?? 'info' });
  }

  private tool(id: string, at: number, tool: string, view: { title: string; input?: string; inputKind?: TerminalInputKind }): void {
    const e: ToolEntry = { kind: 'tool', id, at, tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private result(toolId: string, at: number, raw: string, error: boolean): void {
    const p = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${toolId}:r`, at, toolUseId: toolId, text: p.text || tr('(no output)') };
    if (error) e.error = true;
    if (p.truncated) e.truncated = true;
    this.emit(e);
  }
}

/** Stateful parser of the Copilot terminal: one instance per file read, fed in file order. */
export function createCopilotTerminalParser(): TerminalParser {
  return new CopilotTerminalParser();
}
