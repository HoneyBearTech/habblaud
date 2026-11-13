// Protocol shared between the server (Node) and the client (browser).
// Pure code: no Node or DOM APIs.
//
// Evolution rule: changes here must be ADDITIVE (new optional fields).
// Renaming/removing fields breaks server, world and UI at the same time.

import type { AppearanceParts } from './appearance';
import type { WorldMeta } from './world/api';

export type AgentKind = 'main' | 'sub';

/**
 * Which tool the agent (or the account, the source, the session, the request) comes from. In the protocol types the
 * `provider` field is optional and ABSENT means 'claude' (everything that existed before Codex stays the same).
 * - claude: Claude Code;
 * - codex: OpenAI Codex (the `codex` CLI and the desktop app, which write to the same CODEX_HOME).
 */
export type Provider = 'claude' | 'codex';

/**
 * High-level state of an agent — it is what drives the character's behavior.
 * - working: processing a turn (busy). Stays at the desk typing.
 * - waiting: needs the user (permission, question, dialog). Stays at the desk with a hand raised.
 * - idle: finished the turn and waits for the next instruction. Walks around the office (coffee, water cooler...).
 * - shell: finished the turn, but there are shell(s) running in the background (see `shells`); it is waiting
 *   for the shell to finish. Stays at the desk, watching the terminal. (The Claude Code registry writes "shell"
 *   when the session is idle with background shells.)
 * - done: subagent finished. Hands the result to the main agent and leaves.
 * - offline: session ended. Leaves (if it is the last one in the room, turns off the light).
 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'shell' | 'done' | 'offline';

/** A shell command the agent is waiting to finish. */
export interface ShellJob {
  /** Id of the background task (e.g. "bo0ov3q3l") or, in the foreground, the id of the tool_use. */
  id: string;
  /** Short text in the server's language: the Bash description or a summary of the command (secrets masked). */
  label: string;
  /** Full command (masked, up to ~300 characters), when there is one. */
  command?: string;
  /** Epoch ms at which the command started. */
  startedAt: number;
  /** true = run_in_background (the agent ended the turn and waits for the notification); false = foreground command with no result yet. */
  background: boolean;
  /** 'monitor' = Monitor tool (follows a process); 'shell' = Bash. */
  kind: 'shell' | 'monitor';
}

export type ActivityKind =
  | 'prompt' // received a new instruction from the user
  | 'think' // thinking (thinking block)
  | 'respond' // writing a text response
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'run' // terminal command
  | 'test'
  | 'git'
  | 'web'
  | 'browser'
  | 'plan' // tasks / planning
  | 'delegate' // spawned subagent(s)
  | 'communicate' // message to another agent / notice
  | 'ask' // question to the user
  | 'mcp'
  | 'skill'
  | 'wait'
  | 'error'
  | 'compact' // context compaction
  | 'done' // finished the turn
  | 'other';

export interface Activity {
  /** Unique per activity (e.g. uuid of the entry + index of the block). */
  id: string;
  kind: ActivityKind;
  /** Emoji that represents the activity. */
  icon: string;
  /** Short text in the server's language (up to ~46 characters). E.g. "Editing App.tsx". */
  text: string;
  /** Optional detail (full command, path, query...), up to ~300 characters. */
  detail?: string;
  /** Raw name of the tool, when there is one. */
  tool?: string;
  /** Epoch ms. */
  at: number;
  durationMs?: number;
  error?: boolean;
  /** Full questions of an AskUserQuestion (kind 'ask'), for the office to show the options. */
  questions?: AskQuestion[];
}

/**
 * One AskUserQuestion question, already masked and cut. With the request in the office (PermissionRequestInfo.questions),
 * it can be answered from there; otherwise the answer is given in Claude Code.
 */
export interface AskQuestion {
  /** Position of the question in `tool_input.questions` (invalid entries are skipped, so there may be gaps). */
  index: number;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `index` = position of the option in the original's `options`: it is what comes back in the answer (PermissionAnswer). */
  options: Array<{ index: number; label: string; description?: string }>;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** Gerund form ("Writing tests"), when available. */
  activeForm?: string;
}

export interface AgentStats {
  toolCalls: number;
  /** input + cache read + cache creation. */
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Total subagents spawned by this agent. */
  subagents: number;
}

export interface AgentInfo {
  /**
   * Stable while the agent exists. Claude Code: main "<account>:<pid>", sub "<sessionId>:<agentId>".
   * Codex: main and sub "<account>:<threadId>" (the sub with `parentId`).
   */
  id: string;
  kind: AgentKind;
  /** Agent's tool; absent = 'claude'. */
  provider?: Provider;
  /** For subagents: id of the agent that spawned it. */
  parentId?: string;
  roomId: string;
  /** Human name, unique in the office. E.g. "Marina". */
  name: string;
  /** Presentation hint for the name (used by the art to vary the look). */
  look: 'f' | 'm';
  /** Role. Main: "Main agent". Sub: type of the subagent ("Explore", "Plan", "fork"...). */
  role: string;
  /** Session title (main) or task description (sub). */
  title?: string;
  sessionId: string;
  /** Source account = AccountInfo.id (basename of the config dir, e.g. ".claude", ".claude-conta2"). */
  account: string;
  status: AgentStatus;
  /** Reason in the server's language when status === 'waiting'. E.g. "approve a permission". */
  waitingFor?: string;
  /** Current activity (or the most recent one). */
  activity?: Activity;
  /** Last activities, from the oldest to the most recent (max. ~30). */
  recent: Activity[];
  tasks: TaskItem[];
  /** Running shells the agent is waiting on: background ones and the foreground command with no result yet. */
  shells?: ShellJob[];
  model?: string;
  gitBranch?: string;
  permissionMode?: string;
  startedAt: number;
  lastEventAt: number;
  /** When the status last changed (epoch ms). */
  statusSince: number;
  stats: AgentStats;
  /** 32-bit seed for the character's deterministic appearance. */
  seed: number;
  /** Parts chosen in the character editor, applied on top of the `seed` appearance (see shared/appearance.ts). */
  parts?: AppearanceParts;
  /** Uses the character chosen for the project (the room): the panel offers "Back to random". */
  custom?: true;
  /** Subagent running in the background. */
  background?: boolean;
  /**
   * Permission request that can be answered from Habblaud (PermissionRequest hook; the oldest one, if
   * there are several). While it exists, the agent shows up as 'waiting'. See PermissionRequestInfo.
   */
  permission?: PermissionRequestInfo;
  /**
   * A message can be sent to this agent from Habblaud (main ones only): the session has the habblaud-mensagens
   * plugin and asked for the inbox a short while ago. See POST /api/messages.
   */
  canMessage?: boolean;
}

export interface RoomInfo {
  /** Stable key: normalized cwd of the project. */
  id: string;
  /** Displayed name (basename of the cwd, disambiguated if repeated). */
  name: string;
  /** Full path of the project. */
  path: string;
  /**
   * Arrival order of the room, assigned by the server and stable while the room exists (a freed slot is only
   * reused after a waiting period). The client uses it only as an order: in the building, each room takes the first
   * free spot and, when a spot becomes free between rooms, the farthest one moves into it
   * (client/src/world/sim/sim.ts, compact). Spot on the client: column = floor(spot / 2); even = north side of the
   * hallway, odd = south side.
   */
  slot: number;
  /** Seed for deterministic colors/decoration. */
  seed: number;
  createdAt: number;
  /** Temporary visual effect in the room (GitHub events detected in the transcripts; see shared/github.ts). */
  effect?: RoomEffect;
}

/**
 * Temporary effect in a project room, triggered by a GitHub event seen live:
 * - party: celebration (PR opened or merged, release, green CI after an alarm); lasts ~12 s;
 * - alarm: red CI; lasts until a green CI in that room or expires in ~10 min.
 */
export interface RoomEffect {
  kind: 'party' | 'alarm';
  /** Short banner in the server's language. E.g. "PR #12 merged!", "CI failed (feat/x)". */
  text: string;
  /** Start (epoch ms, server clock): a new effect has another `at`. */
  at: number;
  /** Expected end (epoch ms, server clock). */
  until: number;
  /** Responsible agent: who opened/merged (party) or who saw the CI fail (alarm, "!" speech bubble). */
  agentId?: string;
}

/**
 * New version check: the server queries the most recent release of the repository on GitHub
 * (server/updates/checker.ts) and compares it with the version in use.
 */
export interface UpdateStatus {
  /**
   * - off: check turned off (HABBLAUD_UPDATE_CHECK=0 or package.json with no repository on GitHub);
   * - pending: has not checked yet;
   * - ok: checked (with or without a published release);
   * - error: the last attempt failed (no internet, GitHub query limit...).
   */
  state: 'off' | 'pending' | 'ok' | 'error';
  /** Repository queried, "owner/name". */
  repo?: string;
  /** Last query that worked (epoch ms). */
  checkedAt?: number;
  /** Version of the most recent release, without the "v" (absent: no release published). */
  latest?: string;
  /** Page of the most recent release on GitHub. */
  url?: string;
  /** Publication of the most recent release (epoch ms). */
  publishedAt?: number;
  /** The most recent release is newer than the version in use. */
  available: boolean;
  /** Reason for the failure (state "error"). */
  error?: string;
}

export interface SourceInfo {
  /** Account label (basename of the config dir). */
  label: string;
  /** Source's tool; absent = 'claude'. */
  provider?: Provider;
  path: string;
  /** Open sessions detected in this source. */
  sessions: number;
  ok: boolean;
  error?: string;
}

/** One usage limit window of the plan (e.g. 5h session, week). */
export interface UsageWindow {
  /** Percentage used, 0–100. */
  utilization: number;
  /** When the window resets (epoch ms). */
  resetsAt?: number;
}

export interface AccountUsage {
  /** 5-hour session. */
  fiveHour?: UsageWindow;
  /** Weekly limit (all models). */
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /**
   * Origin of the numbers (all of them are local files written by the tool itself):
   * - 'statusline': captured live and written to ~/.habblaud/usage/<conta>.json by the Habblaud mod
   *   (mod/habblaud, recommended) or by scripts/statusline-tap.mjs (rate_limits field of the statusline);
   * - 'cache': `cachedUsageUtilization` written by Claude Code itself (updates when someone runs /usage);
   * - 'codex': `rate_limits` from the Codex session files (they only refresh while some session is running).
   */
  source: 'cache' | 'statusline' | 'codex';
  /** Who wrote the file live ('statusline'): the Habblaud mod in Claude Code or the statusline tap. */
  via?: 'mod' | 'tap';
  /**
   * Account with no quota or credits to use now (Codex: `rate_limits.primary` null, e.g. workspace credits
   * used up). It is not "0% used": the windows are absent.
   */
  noQuota?: boolean;
  /** When the numbers were obtained at the origin (epoch ms). */
  fetchedAt: number;
}

/** A Claude account (one config dir: ~/.claude, ~/.claude-conta2, ...) or a Codex one (one CODEX_HOME: ~/.codex). */
export interface AccountInfo {
  /** = AgentInfo.account (basename of the config dir, e.g. ".claude"); unique among the accounts of all the tools. */
  id: string;
  /** Account's tool; absent = 'claude'. */
  provider?: Provider;
  /** Very short label (1–3 characters), e.g. "C" and "D" — shortcuts detected in the shell — or derived. */
  short: string;
  /** Friendly name. E.g. "Account C". */
  name: string;
  email?: string;
  organization?: string;
  /** Plan, when known (e.g. "Max", "Pro"). */
  plan?: string;
  /** Identification color of the account (hex). */
  color: string;
  configDir: string;
  /** Sessions open now in this account. */
  sessions: number;
  usage?: AccountUsage;
  /**
   * - ok: recent numbers;
   * - stale: old numbers (e.g. /usage cache from hours ago);
   * - disabled: no numbers (statusline tap not installed and no /usage cache).
   */
  usageStatus: 'ok' | 'stale' | 'disabled';
}

export interface OfficeSnapshot {
  /** Increments at each change. */
  rev: number;
  serverTime: number;
  rooms: RoomInfo[];
  agents: AgentInfo[];
  /** Interactive terminals opened by Habblaud (Claude Code running inside the browser). */
  ptys?: PtyInfo[];
  /** Claude accounts detected (with 5h/weekly usage when available). */
  accounts: AccountInfo[];
  meta: {
    demo: boolean;
    sources: SourceInfo[];
    startedAt: number;
    version: string;
    /**
     * Identifier of the client build the server is serving (bundle name, e.g. "main-BFqheOCa").
     * A page opened with another build is out of date and must reload itself. Absent in dev mode.
     */
    build?: string;
    /**
     * Terminal (GET /api/agents/:id/terminal) available: only when Habblaud is not
     * exposed beyond the computer itself (local bind). Absent/false = feature turned off.
     */
    terminal?: boolean;
    /**
     * Messages from the office turned on (POST /api/messages): the same lock as the terminal and HABBLAUD_MENSAGENS
     * not turning it off. Who receives now is told by AgentInfo.canMessage. Absent/false = feature turned off.
     */
    messages?: boolean;
    /**
     * Interactive terminal (opening/taking over sessions and ending agents from the office): only outside Docker, with
     * node-pty and local access. Absent = feature turned off.
     */
    pty?: PtyStatus;
    /** New version check on GitHub (absent in the tests and in the timelapse). */
    updates?: UpdateStatus;
    /**
     * Habblaud World (server/world/): `enabled` = the section shows up (HABBLAUD_WORLD is not 0 and the world server was
     * accepted: the default, server.habblaud.com, or a valid HABBLAUD_WORLD_URL; if refused, the feature stays off and
     * nothing of World shows up); `configured` = world server accepted; `state` = the
     * account on this computer; `building` (additive, only with the account approved and the character created) = the
     * summary of the building in the world: connected, paused, floors and agents of the last upload and its time,
     * whether it left the world and whether the world server stopped it (without the reason, which only goes in the
     * status). Nothing of the account beyond that (the snapshot also goes to the phone and to the timeline). Absent in
     * the tests and in the timelapse.
     */
    world?: WorldMeta;
  };
}

/**
 * What THIS page can do (GET /api/access): the local port allows everything by the local Host; the remote port with
 * login (server/http/remote.ts) only what HABBLAUD_REMOTE_ALLOW allows. `local` = opened from the computer itself
 * (editing the character and renaming rooms, which never apply through the remote port).
 */
export interface AccessInfo {
  remote: boolean;
  local: boolean;
  permissions: boolean;
  messages: boolean;
  terminal: boolean;
  /** Can open new agents in the Claude app (POST /api/spawn). */
  spawn: boolean;
  /**
   * Can use the Habblaud World account (/api/world/*): feature turned on (HABBLAUD_WORLD), terminal lock and local port
   * with local Host. Absent in old servers.
   */
  world?: boolean;
}

export interface FeedItem {
  id: string;
  agentId: string;
  roomId: string;
  agentName: string;
  roomName: string;
  /** Agent's account (= AccountInfo.id). */
  account?: string;
  activity: Activity;
}

export type NoticeLevel = 'info' | 'success' | 'warn' | 'alert';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  agentId?: string;
  roomId?: string;
  at: number;
}

/**
 * Server messages over SSE on GET /api/stream.
 * Each message arrives as a named SSE event (`event: snapshot|feed|notice`) whose `data` is the JSON of `data`.
 * On connect, the server sends a full `snapshot` and a `feed` with the recent items.
 */
export type ServerMessage =
  | { type: 'snapshot'; data: OfficeSnapshot }
  | { type: 'feed'; data: FeedItem[] }
  | { type: 'notice'; data: Notice };

/** Response of GET /api/agents/:id */
export interface AgentDetail {
  agent: AgentInfo;
  /** Longer history (max. ~200), from oldest to most recent. */
  history: Activity[];
}

// ------------------------------------------------------------------ Claude Code mod

/**
 * Response of GET /api/mod/summary: the minimum the Claude Code mod (mod/habblaud) needs for the
 * "needs you" line below the prompt and for the /habblaud command. Only real agents (the demo is left out)
 * that are present (without those that have already ended or delivered); with `?session=` (and `?account=`),
 * without the asker's own session: its main agent and the subagents.
 */
export interface ModSummary {
  /** Habblaud version in use. */
  version: string;
  /** Agents present and how many are working. */
  agents: number;
  working: number;
  /** Who needs you, from whoever has waited longest to whoever has waited least. */
  waiting: ModWaitingAgent[];
}

export interface ModWaitingAgent {
  /** = AgentInfo.id. */
  id: string;
  name: string;
  /** Displayed name of the room (project). */
  room: string;
  /** = AccountInfo.id. */
  account: string;
  /** Reason in the server's language (AgentInfo.waitingFor), e.g. "approve a permission". */
  waitingFor: string;
  /** Since when it has been waiting (epoch ms). */
  since?: number;
  /** There is a permission request to answer from the office (AgentInfo.permission). */
  answerable: boolean;
}

// ------------------------------------------------------------------ terminal

/**
 * How to display the `input` of a tool call:
 * - command: shell command; diff: lines "- old" / "+ new" (Edit/Write); json: raw arguments; text: free text.
 */
export type TerminalInputKind = 'command' | 'diff' | 'json' | 'text';

/**
 * A terminal entry: the session's conversation rebuilt from the JSONL transcript,
 * in the format Claude Code shows it. All text already comes with secrets masked and truncated.
 * Entries are only appended (never edited): a tool's result arrives later, in a
 * 'result' entry that points to the 'tool' by `toolUseId`.
 */
export type TerminalEntry =
  /** User prompt or slash command (e.g. "/model"). */
  | { kind: 'user'; id: string; at: number; text: string }
  /** Text of the agent's response (markdown). */
  | { kind: 'assistant'; id: string; at: number; text: string }
  /** Reasoning block; `text` absent when the transcript only keeps the signature. */
  | { kind: 'thinking'; id: string; at: number; text?: string }
  /**
   * Tool call. `id` = id of the tool_use. `title` in the Claude Code style: "Bash(npm test)",
   * "Read(server/index.ts)". `input` = relevant arguments (command, diff...), when there are any.
   */
  | { kind: 'tool'; id: string; at: number; tool: string; title: string; input?: string; inputKind?: TerminalInputKind }
  /** Result of a tool. `truncated` = the text was cut (result too long). */
  | { kind: 'result'; id: string; at: number; toolUseId: string; text: string; error?: boolean; truncated?: boolean }
  /** Session event: compaction, interruption, background result, API error... */
  | { kind: 'system'; id: string; at: number; text: string; detail?: string; level?: 'info' | 'warn' | 'error' };

/** `init` event of the terminal stream: the recent conversation (replaces everything the client has). */
export interface TerminalInit {
  agentId: string;
  /** From oldest to most recent. */
  entries: TerminalEntry[];
  /** There is earlier conversation that was not loaded (the transcript is larger than the window read). */
  truncated: boolean;
}

/**
 * Terminal stream (Server-Sent Events) on GET /api/agents/:id/terminal.
 * On connect (and on each reconnection, or if the transcript is truncated/replaced) an `init` arrives;
 * after that, `append` with the new entries. Errors before the stream respond with JSON `{error}`:
 * 403 (feature turned off or access that is not local), 404 (unknown agent/transcript),
 * 429 (too many open terminals).
 */
export type TerminalMessage = { type: 'init'; data: TerminalInit } | { type: 'append'; data: TerminalEntry[] };

/**
 * A recent session (open or already ended) in the terminal history, on
 * GET /api/sessions/recent. The conversation of an ended session comes, with the same protocol as the agent's
 * terminal (TerminalMessage), from GET /api/sessions/:conta/:sessionId/terminal.
 */
export interface RecentSession {
  /** = AccountInfo.id. */
  account: string;
  /** The session's tool; absent = 'claude'. */
  provider?: Provider;
  sessionId: string;
  /** Project path (the `cwd` from the first lines of the transcript); absent if it could not be found out. */
  project?: string;
  /** Name of the project folder in `projects/` (the encoded cwd), for when `project` is missing. */
  projectDir: string;
  /** Title like the agent's: /rename > agent name > automatic title > last prompt (or the first). */
  title?: string;
  /** First and last activity with a time (epoch ms); `lastAt` falls back to the file mtime with no time at the end. */
  firstAt?: number;
  lastAt: number;
  /** Transcript size in bytes. */
  size: number;
  /** The session is still open: `agentId` is its main agent in the office. */
  open: boolean;
  agentId?: string;
}

// ------------------------------------------------------------------ deliveries

/** Type of a delivery attachment, to choose the viewer. */
export type DeliveryAttachmentKind = 'image' | 'pdf' | 'video' | 'page' | 'text' | 'file';

/** File the agent delivered (SendUserFile, link in the response) or a screen captured at the end of the work. */
export interface DeliveryAttachment {
  /** Opaque id for GET /api/deliveries/file/:id (never the path). */
  id: string;
  name: string;
  kind: DeliveryAttachmentKind;
  /** The agent's caption (SendUserFile) or "Screenshot taken". */
  caption?: string;
  /** Screenshot that came inside the conversation (it is not a file on the computer). */
  capture?: boolean;
}

/**
 * A delivery: the end of a request the agent worked on (used tools) and answered. Built from the transcript
 * (server/deliveries/deliveries.ts), the way a BA would receive it: headline, summary, request and attachments.
 */
export interface DeliveryInfo {
  /** "<account>:<session>:<request entry>". */
  id: string;
  account: string;
  provider?: Provider;
  sessionId: string;
  /** Agent still in the office (for the avatar and the "open terminal"). */
  agentId?: string;
  /** Name of the agent (the office one) or the session title. */
  agentName?: string;
  project?: string;
  /** What was asked (one line). */
  request: string;
  /** First sentence of the response, without markdown. */
  headline: string;
  /** Paragraph in plain language (the last of the response), when there is one. */
  summary?: string;
  /** The whole response (markdown). */
  text: string;
  startedAt: number;
  finishedAt: number;
  /** Tools used and files changed in the request. */
  tools: number;
  edited: number;
  attachments: DeliveryAttachment[];
}

export interface DeliveriesResponse {
  deliveries: DeliveryInfo[];
}

/** Response of GET /api/sessions/recent: from the most recent activity to the oldest. */
export interface RecentSessionsResponse {
  sessions: RecentSession[];
  /** Window of the listing (days) and maximum number of sessions. */
  days: number;
  limit: number;
}

// ------------------------------------------------------------------ answer from the office

/** "always allow" rule suggested by Claude Code for a request (permission_suggestions of the hook). */
export interface PermissionSuggestionInfo {
  /** Position in the list the hook got: it is what returns in the decision (the hook applies the original suggestion). */
  index: number;
  /** Rules in the format of Claude Code permissions, e.g. "Bash(npm test:*)". */
  rules: string[];
  /** Where the rule is stored: 'session', 'localSettings', 'projectSettings' or 'userSettings'. */
  destination: string;
}

/**
 * Pending permission request that can be answered from Habblaud: the Claude Code PermissionRequest hook
 * (mod/habblaud-permissoes/hooks/permission-hook.mjs) registers it and keeps waiting for the decision. It only exists
 * with local bind (the same lock as the terminal) and with some Habblaud page open.
 * In the snapshot it goes without `input` (the full arguments only go out through GET /api/permissions/:id, with
 * local access); the demo's fictional requests already come with it.
 */
export interface PermissionRequestInfo {
  id: string;
  /** Tool of whoever asked; absent = 'claude'. */
  provider?: Provider;
  /** Raw tool name (e.g. "Bash", "Edit", "mcp__github__create_issue"). */
  tool: string;
  /** Title in the Claude Code style: "Bash(npm test)", "Edit(src/app.ts)". Masked and cut. */
  title: string;
  /** Summary in the server's language (e.g. "Running the tests") and the activity icon. */
  text: string;
  icon: string;
  /** Arguments (command, diff, JSON...), masked and truncated. */
  input?: string;
  inputKind?: TerminalInputKind;
  /** Request from a subagent that Habblaud does not show yet: its type (e.g. "Explore"). */
  subagent?: string;
  /** "always allow" rules that can be applied together with the approval. */
  suggestions?: PermissionSuggestionInfo[];
  /**
   * AskUserQuestion request: the questions, to answer from the office (decision `answer`). It also goes in the
   * snapshot (without them the card has nothing to show).
   */
  questions?: AskQuestion[];
  /** Other requests from the same agent waiting after this one. */
  queued?: number;
  createdAt: number;
  /** When the hook gives up waiting and the request becomes valid only in the terminal. */
  expiresAt: number;
}

/**
 * Answer to an AskUserQuestion question, by POSITION (AskQuestion.index and the `index` of the options): the hook swaps
 * the positions for the original texts it received from Claude Code (the page only sees the masked and cut texts).
 */
export interface PermissionAnswer {
  /** AskQuestion.index. */
  question: number;
  /** Positions of the chosen options (only one without multiSelect). */
  options?: number[];
  /** Free text ("Other"). Without multiSelect, it counts in place of an option. */
  other?: string;
}

/** Body of POST /api/permissions/:id/decision (coming from the page). */
export interface PermissionDecision {
  /**
   * allow = approve; deny = refuse; terminal = return the request to the terminal (the hook exits without deciding);
   * answer = answer the questions of an AskUserQuestion (`answers`).
   */
  behavior: 'allow' | 'deny' | 'terminal' | 'answer';
  /** Refusal: reason passed on to the agent. */
  message?: string;
  /** Refusal: interrupts the agent (it stops and waits for you). */
  interrupt?: boolean;
  /** Approval: also applies the suggestion at this position (PermissionSuggestionInfo.index). */
  suggestion?: number;
  /** Answer (`answer`): one per question of the request. */
  answers?: PermissionAnswer[];
}

// ------------------------------------------------------------------ messages from the office

/**
 * Status of a message sent from the page to an agent (GET /api/messages/:id):
 * queued = waiting for the session to fetch it; sent = the session fetched it and is delivering it; delivered = it
 * entered the session (or its queue, if the agent was busy); failed = it did not enter (`error` says why).
 */
export type OutboxStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface OutboxMessage {
  id: string;
  /** AgentInfo.id of the recipient (always a main one). */
  agentId: string;
  status: OutboxStatus;
  error?: string;
  createdAt: number;
  /** Last status change. */
  updatedAt: number;
}

/** State of the interactive terminal (OfficeSnapshot.meta.pty). */
export interface PtyStatus {
  enabled: boolean;
  /** Why it is off. */
  reason?: string;
}

/** Interactive terminal opened by Habblaud (node-pty on the server, xterm.js in the browser). */
export interface PtyInfo {
  id: string;
  /** PID of Claude Code: the matching agent is `${account}:${pid}` (= agentId). */
  pid: number;
  cwd: string;
  account: string;
  agentId: string;
  /** Resumed session (`claude --resume`), when the terminal took over a session that already existed. */
  resumed?: string;
  /** Agent this terminal took over (the old id, of the ended process). */
  fromAgent?: string;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
}

/** Message delivered to the habblaud-mensagens plugin (POST /api/mod/inbox). */
export interface InboxMessage {
  id: string;
  /** The text as it was typed: the plugin sends it to the session as if you had typed it. */
  text: string;
}
