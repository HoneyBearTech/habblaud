// Interpretation of the Copilot CLI session events (<COPILOT_HOME>/session-state/<session>/events.jsonl): one JSON
// object per line, `{type, data, id, timestamp, parentId}`. Each line updates a CopilotState (project, model, title,
// numbers, whether the agent is busy, open permission prompts, shutdown) and can generate activities (what the
// character is doing).
//
// Turns: `assistant.turn_start`/`assistant.turn_end` wrap EVERY model call, not a whole user turn. The agent is idle
// only after an `assistant.message` without tool requests followed by `assistant.turn_end` (or the `agentStop`
// hook, or `abort`). A message with tool requests keeps it working (the next model call follows).
// Permission prompts: `permission.requested` until the `permission.completed` with the same requestId = "needs you".
// The prompt goes to the history; the "Needs you" line itself follows the status (Office.setStatus).
// Tokens: `session.usage_record` is per model call; its `inputTokens` already includes the cache reads (it is not
// added again), as in Codex.
// `session.shutdown` = the session ended (the character leaves). Unknown types, invalid lines and missing fields are
// ignored; nothing here ever brings the read down.
import { describeCommand, describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { Activity, AgentStats } from '../../../shared/types';
import type { ParsedActivity } from '../transcript';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Copilot session id (UUID, the folder name in session-state/). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID.test(v);
}

const TITLE_MAX = 90;
const MAX_TRACKED = 256;

/** Activity of a prompt received by Copilot: "Received “…”" (kind 'prompt', the basis of "Done in X"). */
export function describeCopilotPrompt(text: string): ActivityDescription {
  const shown = truncate(maskSecrets(text.slice(0, 1_000)), 34);
  return { ...describePrompt(text), text: truncate(tr('Received “{0}”', [shown]), 46) };
}

/**
 * Activity of a Copilot tool (bash, view, edit, create, glob, grep, web_fetch...) by its name and arguments. `tool`
 * comes back normalized (Bash, Read, Edit, Write...) for Activity.tool.
 */
export function describeCopilotTool(rawName: string, args: Rec): { desc: ActivityDescription; tool: string } {
  const name = rawName.trim();
  const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
    case 'powershell':
      return { desc: describeCommand(str(args.command) ?? '', str(args.description)), tool: 'Bash' };
    case 'read_bash':
    case 'read_powershell':
      return { desc: describeTool('BashOutput', {}), tool: 'BashOutput' };
    case 'write_bash':
    case 'write_powershell':
      return { desc: { kind: 'run', icon: '⌨️', text: tr('Interacting with a command') }, tool: name };
    case 'stop_bash':
    case 'stop_powershell':
      return { desc: describeTool('KillShell', {}), tool: 'KillShell' };
    case 'view':
    case 'read':
    case 'read_file':
      return { desc: describeTool('Read', { file_path: path }), tool: 'Read' };
    case 'edit':
    case 'str_replace':
    case 'str_replace_editor':
      return { desc: describeTool('Edit', { file_path: path }), tool: 'Edit' };
    case 'create':
    case 'write':
    case 'write_file':
      return { desc: describeTool('Write', { file_path: path }), tool: 'Write' };
    case 'glob':
      return { desc: describeTool('Glob', { pattern: args.pattern }), tool: 'Glob' };
    case 'grep':
    case 'rg':
      return { desc: describeTool('Grep', { pattern: args.pattern }), tool: 'Grep' };
    case 'web_fetch':
      return { desc: describeTool('WebFetch', { url: args.url }), tool: 'WebFetch' };
    case 'web_search':
      return { desc: describeTool('WebSearch', { query: args.query }), tool: 'WebSearch' };
    case 'task':
      return { desc: describeTool('Agent', { description: str(args.description) ? truncate(String(args.description), 60) : undefined }), tool: 'Agent' };
    default:
      return { desc: describeTool(name || 'tool', args), tool: name || 'tool' };
  }
}

/** Short description (already masked and cut) of a permission prompt, for "Needs you: …". */
export function describePermission(req: Rec | undefined): string {
  const kind = str(req?.kind);
  if (kind === 'shell') return tr('approve a command');
  if (kind === 'write') return tr('approve a file change');
  if (kind === 'read') return tr('approve reading a file');
  if (kind === 'url') return tr('approve a web access');
  return tr('approve a permission');
}

/** Detail of a permission prompt for the activity line (masked and cut by the activity builder). */
function permissionDetail(req: Rec | undefined): string | undefined {
  return str(req?.fullCommandText) ?? str(req?.intention) ?? str(req?.path) ?? str(req?.url);
}

// ------------------------------------------------------------------ state

export interface CopilotState {
  sessionId?: string;
  /** Working folder from session.start (the workspace.yaml one wins, in the source). */
  cwd?: string;
  model?: string;
  version?: string;
  /** First real prompt (session title), already masked and cut. */
  title?: string;
  stats: AgentStats;
  firstAt?: number;
  lastAt?: number;
  /** Start of the session (session.start startTime or its timestamp). */
  startedAt?: number;
  /** A turn is running (prompt submitted or model call started, and no final answer yet). */
  busy: boolean;
  /** The last model call answered without tool requests: the next turn_end ends the user turn. */
  finalAnswer: boolean;
  /** Time of the last change of `busy`/permissions (to order with other information). */
  statusAt: number;
  /** Open permission prompts (requestId → short description). */
  permissions: Map<string, string>;
  /** Running tool calls (toolCallId → normalized tool). */
  tools: Map<string, string>;
  /** session.shutdown seen (and nothing new after it). */
  shutdown: boolean;
}

export function createCopilotState(): CopilotState {
  return {
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    busy: false,
    finalAnswer: false,
    statusAt: 0,
    permissions: new Map(),
    tools: new Map(),
    shutdown: false,
  };
}

/** Status the state points to: 'waiting' (open permission prompt), 'working' or 'idle'. */
export function copilotStatus(s: CopilotState): { status: 'working' | 'waiting' | 'idle'; waitingFor?: string } {
  if (s.permissions.size) return { status: 'waiting', waitingFor: [...s.permissions.values()].pop() };
  return { status: s.busy ? 'working' : 'idle' };
}

export interface CopilotLineResult {
  activities: ParsedActivity[];
  /** Title, numbers or model changed. */
  changed: boolean;
  /** Epoch ms of the line (its `timestamp` or the context's `now`). */
  at: number;
}

export interface CopilotParseContext {
  /** Prefix of the activity ids (the agent's id). */
  idPrefix: string;
  now: number;
  /** false = only updates the state (without building activities). */
  activities?: boolean;
}

function remember(map: Map<string, string>, key: string, value: string): void {
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string);
}

class EventLineParser {
  readonly out: CopilotLineResult;
  private readonly withActivities: boolean;
  private autoKeys = 0;

  constructor(
    private readonly s: CopilotState,
    private readonly ctx: CopilotParseContext,
    private readonly j: Rec,
    private readonly d: Rec,
    private readonly at: number,
  ) {
    this.withActivities = ctx.activities !== false;
    this.out = { activities: [], changed: false, at };
  }

  /** Stable key of an activity: the event id (rereading the file generates the same keys) or its time. */
  private key(suffix = ''): string {
    const id = str(this.j.id);
    const base = id ?? `t${this.at.toString(36)}`;
    const n = this.autoKeys++;
    return `${base}${suffix}${n ? `:${n}` : ''}`;
  }

  private push(desc: ActivityDescription, opts: { key?: string; tool?: string; current?: boolean; callId?: string } = {}): void {
    if (!this.withActivities) return;
    const activity: Activity = { id: `${this.ctx.idPrefix}#${opts.key ?? this.key()}`, at: this.at, ...desc };
    if (opts.tool) activity.tool = opts.tool;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    this.out.activities.push(opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current });
  }

  private changed(): void {
    this.out.changed = true;
  }

  private setBusy(busy: boolean): void {
    this.s.busy = busy;
    this.s.statusAt = this.at;
  }

  /** Something new after a shutdown: the session was resumed. */
  private alive(): void {
    if (this.s.shutdown) {
      this.s.shutdown = false;
      this.changed();
    }
  }

  private model(v: unknown): void {
    const m = str(v);
    if (!m || m === this.s.model) return;
    this.s.model = truncate(m, 60);
    this.changed();
  }

  run(): void {
    const d = this.d;
    switch (this.j.type) {
      case 'session.start':
      case 'session.resume': {
        this.alive();
        const id = str(d.sessionId);
        if (id && isSessionId(id)) this.s.sessionId = id.toLowerCase();
        const cwd = str(rec(d.context)?.cwd);
        if (cwd) this.s.cwd = cwd;
        const version = str(d.copilotVersion);
        if (version) this.s.version = truncate(version, 40);
        const started = toMs(d.startTime) ?? this.at;
        if (this.j.type === 'session.start' && (this.s.startedAt === undefined || started < this.s.startedAt)) this.s.startedAt = started;
        this.model(d.selectedModel);
        this.changed();
        return;
      }
      case 'session.model_change':
        return this.model(d.newModel);
      case 'user.message':
        return this.prompt();
      case 'assistant.turn_start':
        this.alive();
        this.s.finalAnswer = false;
        this.setBusy(true);
        return;
      case 'assistant.message': {
        const requests = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        this.s.finalAnswer = requests.length === 0;
        const text = str(d.content);
        if (text) this.push(SPECIAL.respond(text), { key: this.key(':m') });
        return;
      }
      case 'assistant.turn_end':
        if (this.s.finalAnswer) this.endTurn();
        return;
      case 'hook.start':
        if (d.hookType === 'agentStop') this.endTurn();
        return;
      case 'abort':
        this.s.permissions.clear();
        this.s.tools.clear();
        this.endTurn();
        this.push(SPECIAL.interrupted(), { key: this.key(':int') });
        return;
      case 'tool.execution_start':
        return this.toolStart();
      case 'tool.execution_complete':
        return this.toolEnd();
      case 'permission.requested': {
        const id = str(d.requestId);
        if (!id) return;
        const req = rec(d.permissionRequest);
        const why = describePermission(req);
        remember(this.s.permissions, id, why);
        this.s.statusAt = this.at;
        const desc = SPECIAL.waiting(why);
        const detail = permissionDetail(req);
        if (detail) desc.detail = truncate(maskSecrets(detail.slice(0, 1_200)), 300);
        // History only: the "Needs you" line comes from the status (the office puts it up while waiting and, when the
        // wait ends, brings back what it was doing), as for Codex.
        this.push(desc, { key: this.key(':p'), current: false });
        return;
      }
      case 'permission.completed': {
        const id = str(d.requestId);
        if (id && this.s.permissions.delete(id)) this.s.statusAt = this.at;
        const kind = str(rec(d.result)?.kind);
        if (kind && /^denied/.test(kind)) this.push(SPECIAL.rejected(), { key: this.key(':r') });
        return;
      }
      case 'session.usage_record': {
        const u = rec(d.usage);
        if (!u) return;
        const tin = num(u.inputTokens) ?? 0;
        const tout = num(u.outputTokens) ?? 0;
        if (tin > 0 || tout > 0) {
          this.s.stats.tokensIn += tin;
          this.s.stats.tokensOut += tout;
          this.changed();
        }
        this.model(u.model);
        return;
      }
      case 'session.shutdown':
        this.s.shutdown = true;
        this.s.permissions.clear();
        this.s.tools.clear();
        this.s.finalAnswer = false;
        this.setBusy(false);
        this.changed();
        return;
      default:
        return;
    }
  }

  private endTurn(): void {
    this.s.finalAnswer = false;
    if (this.s.busy) this.setBusy(false);
  }

  private prompt(): void {
    const d = this.d;
    // Lines that Copilot adds itself (memory notes and the like) carry a `source`: they are not prompts of yours.
    if (d.source !== undefined && d.source !== null) return;
    const text = str(d.content)?.trim();
    if (!text) return;
    this.alive();
    this.s.finalAnswer = false;
    this.setBusy(true);
    if (this.s.title === undefined) {
      this.s.title = truncate(maskSecrets(text.slice(0, 1_000)), TITLE_MAX);
      this.changed();
    }
    this.push(describeCopilotPrompt(text), { key: this.key(':u') });
  }

  private toolStart(): void {
    const d = this.d;
    const callId = str(d.toolCallId);
    const name = str(d.toolName) ?? 'tool';
    const { desc, tool } = describeCopilotTool(name, rec(d.arguments) ?? {});
    if (callId) remember(this.s.tools, callId, tool);
    this.s.stats.toolCalls++;
    this.changed();
    this.push(desc, { key: callId ?? this.key(), tool, callId });
  }

  private toolEnd(): void {
    const d = this.d;
    const callId = str(d.toolCallId);
    const tool = callId ? this.s.tools.get(callId) : undefined;
    if (callId) this.s.tools.delete(callId);
    if (d.success !== false) return;
    const detail = str(rec(d.error)?.message) ?? str(rec(d.result)?.content);
    const line = detail?.split('\n').find((l) => l.trim());
    this.push(SPECIAL.error(tool, line ? truncate(line, 140) : undefined), { key: `${callId ?? this.key()}:e`, tool, current: false });
  }
}

/** Interprets a line of events.jsonl. Invalid or unknown lines generate nothing. */
export function parseEventLine(state: CopilotState, raw: string, ctx: CopilotParseContext): CopilotLineResult {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { activities: [], changed: false, at: ctx.now };
  }
  const r = rec(j);
  if (!r || typeof r.type !== 'string') return { activities: [], changed: false, at: ctx.now };
  const at = toMs(r.timestamp);
  if (at !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const p = new EventLineParser(state, ctx, r, rec(r.data) ?? {}, at ?? ctx.now);
  try {
    p.run();
  } catch {
    // line too strange: whatever has already come out of it stays
  }
  return p.out;
}
