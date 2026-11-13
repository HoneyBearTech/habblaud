# Habblaud server

Plain Node (no runtime dependencies). Watches the **open** Claude Code sessions in all the accounts on the
machine, keeps the office model and streams everything over SSE.

```
npm run dev      # server + Vite (middleware, HMR) at http://127.0.0.1:4747
npm run build && npm start   # production: serves dist/client
```

## Data sources (read-only)

| What | Where |
| --- | --- |
| Open sessions and status (busy/idle/waiting) | `<config>/sessions/<pid>.json` (+ live PID, outside Docker) |
| Activities, tasks, title, numbers | `<config>/projects/<cwd>/<sessionId>.jsonl` (reads the last ~1 MB at boot; the beginning in the background) |
| Subagents (including those of workflows) | `<config>/projects/<cwd>/<sessionId>/subagents/**/agent-*.jsonl` + `.meta.json` |
| Account (email, organization) and usage cache | `~/.claude.json` (default account) or `<config>/.claude.json` — only those fields |
| Live usage (5h and weekly) | `~/.habblaud/usage/<account>.json`, written by the Habblaud mod (`npm run mod:install`) or by `scripts/statusline-tap.mjs` (`npm run usage:install`) |
| Account shortcut (`c`, `d`...) | `alias x='... claude ...'` lines in `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.bash_profile` |

**Forks** (subagents that inherit the parent's context): the transcript starts with a `fork-context-ref` line, the
copy of the parent's `Agent` call (same `tool_use` id as the `.meta.json`) and its result ("Fork started…") together
with the fork's instruction. The parser ignores that copy — otherwise the inherited result looks like the end of the
subagent and the fork never enters the office — and uses the text after `</fork-boilerplate>` as its request.

## Waiting on shell

The `shell` status (see `shared/types.ts`) is the agent that finished the turn with command(s) running in the
background. It comes from the registry (`"status": "shell"`, Claude Code 2.1.292+, which doesn't count monitors); in
versions that don't write `shell`, registry `idle` + a background Bash without a notification, less than 12 h old,
becomes `shell`.

`sources/shells.ts` tracks, per session (main and subagents), the `ShellJob`s published in `AgentInfo.shells`:
Bash with `run_in_background` (the id becomes the `backgroundTaskId` of the tool_result), foreground Bash still
without a result (`background: false`; disappears from its place while the session waits for approval) and `Monitor`
(`kind: 'monitor'`).
End: `<task-notification>` (`queue-operation`/`enqueue` line, user message or attachment) matching `task-id` or
`tool-use-id`; `TaskStop`/`KillShell`/`KillBash`; end of turn/interruption (foreground); `/clear` or session
ended; jobs from before the current process (resumed session) or more than 24 h old. The end of a background shell
becomes the activity `tool: 'ShellDone'` (`error` = failed/interrupted; the world celebrates or mourns) and a notice;
while the status is `shell`, the speech bubble is "⏳ Waiting on shell: <label>" (`tool: 'ShellWait'`).

## GitHub in the office

`sources/github.ts` finds GitHub events in the transcripts, with no token and no network (works in Docker): the parser
keeps the calls that matter (Bash with `git push`/`gh pr create|merge|checks`/`gh run watch|view`/`gh release create`,
already without heredocs and with the chains split, and tools of GitHub MCP servers) and reads their result:

- **preferred source:** `toolUseResult.gitOperation`, written by Claude Code itself (`{pr: {number, url, action:
  'created'|'merged'}, push: {branch}}`);
- **command output:** the `…/pull/<n>` URL from `gh pr create`; `gh pr merge` with no error or sign of failure (and
  without `--auto`); `abc..def  main -> main` / `* [new branch]` lines after `To <remote>`; the
  `✓|X <branch> <workflow> · <id>` header or `completed with '<conclusion>'` from `gh run watch|view`, `--json`/`--jq`
  with the conclusion, `gh pr checks` (tabs, summary or `--json`; pending doesn't count); the `…/releases/tag/<tag>`
  URL from `gh release create` (a draft doesn't count); JSON from the MCP;
- **exit code:** `gh run watch --exit-status` or `gh pr checks` as the last command, with no pipe (otherwise the code
  is another program's) — in the foreground ("Exit code N") or in the background (summary of the
  `<task-notification>`). ≥ 128 (killed) and 8 (`gh pr checks` pending) don't count.

A command with an error, blocked or interrupted produces no event (only the red CI uses the error). The `github` signal
becomes `Office.githubEvent`: activity `tool: 'GitHub'` (`shared/github.ts`) and, only live (never in the initial load
nor for lines more than 2 min old), a notice and an effect in the room, published in `RoomInfo.effect`
(`{kind: 'party'|'alarm', text, at, until, agentId}`): party (PR opened/merged, release) for 12 s; alarm (red CI) until
a green CI in the room (which becomes a party) or 10 min. A push only gives a notice. The same CI seen again within
2 min doesn't repeat the notice.

## API

| Route | Description |
| --- | --- |
| `GET /api/stream` | SSE: `snapshot`, `feed`, `notice` events (see `shared/types.ts`); ping every 15 s |
| `GET /api/snapshot` | current `OfficeSnapshot` |
| `GET /api/agents/:id` | `AgentDetail` (history of up to 200 activities) |
| `GET /api/agents/:id/terminal` | SSE of the terminal: `init` and `append` events (`TerminalMessage`); only with a local bind (see below) |
| `PUT /api/agents/:id/character` | project character: `{name, seed, parts}` (see below); `200 {ok}`, `400`, `404` (not the main agent of an open session), `409` (name in use); only with local access |
| `DELETE /api/agents/:id/character` | "Back to random": deletes the room's character; `200 {ok}` or `404`; only with local access |
| `GET /api/sessions/recent` | `RecentSessionsResponse`: sessions of the last 7 days from all accounts (up to 150); same lock as the terminal |
| `GET /api/sessions/:account/:sessionId/terminal` | SSE of the conversation of a session from the history (same protocol as the terminal); same lock |
| `GET /api/stats?day=AAAA-MM-DD&tz=<IANA>&source=real\|demo` | `DayStatsResponse` for "My day" (see below); defaults: today, the server's time zone, demo if it is on and the day is today |
| `GET /api/stats/days?tz=<IANA>` | `StatsDaysResponse`: days with real data (and demo data, if on), most recent first |
| `GET /api/timeline/days` | `{recording, days:[{day, bytes, from, to}]}`: days recorded for the timelapse, from the most recent to the oldest |
| `GET /api/timeline/:dia` | the day's file (`AAAA-MM-DD`) in JSONL (`application/x-ndjson`, gzip if accepted); 400 for an invalid day, 404 with no recording |
| `GET /api/health` | `{ok, version, demo, docker, terminal, permissions, messages, updates:{state, latest, available}, sources, accounts:[{id, usageStatus}]}` |
| `POST /api/demo` | `{enabled: boolean}` turns simulated agents on/off (mixed with the real ones) |
| `GET /api/mod/summary?account=&session=` | `ModSummary` for the Claude Code mod: `{version, agents, working, waiting:[{id, name, room, account, waitingFor, since, answerable}]}`, without the demo and without the session of whoever asks (see below) |
| `GET /api/updates` | `{version, ...UpdateStatus}`: version in use and the result of the check for a new version (see below) |
| `POST /api/updates/check` | "Check now": queries GitHub (at most once every 30 s) and returns `{version, ...UpdateStatus}` |
| `/api/world/*` | Habblaud World (account, character and building; on by default, `HABBLAUD_WORLD=0` turns it off): only through the local port with a local `Host`; see below |
| `POST /api/permissions` | (hook) registers a permission request: `201 {id, expiresAt}` or `200 {skip}`; only with a local bind (see below) |
| `GET /api/permissions/:id/wait` | (hook) long-poll of up to 25 s (`?timeout=` in seconds): `{status: 'pending' \| 'decided' \| 'released', ...}` |
| `GET /api/permissions/:id` | (page) detail of the request with the arguments (`PermissionRequestInfo` with `input`) |
| `POST /api/permissions/:id/decision` | (page) `PermissionDecision`: `{behavior: 'allow' \| 'deny' \| 'terminal' \| 'answer', message?, interrupt?, suggestion?, answers?}` |
| `POST /api/messages` | (page) `{agentId, text}`: sends a message to a main agent; `201 OutboxMessage`; only with a local bind (see below) |
| `GET /api/messages/:id` | (page) state of the message (`OutboxMessage`: `queued` \| `sent` \| `delivered` \| `failed`) |
| `POST /api/mod/inbox` | (plugin `habblaud-mensagens`) `{session, account?}`: marks the session's presence and delivers `{messages: InboxMessage[]}` |
| `POST /api/mod/inbox/ack` | (plugin) `{session, results: [{id, ok, error?}]}`: confirms each message delivered (or the failure) |

The snapshot (SSE and `GET /api/snapshot`) carries only the last 8 activities of each agent in `recent`; the history
of up to 200 (including the beginning of long transcripts, read in the background) comes from `GET /api/agents/:id`.

Edge (`http/guard.ts`, applies to API, static files and Vite): `Host` must be `localhost`/`*.localhost`, an IP
or a name from `HABBLAUD_ALLOWED_HOSTS` (against DNS rebinding) → otherwise 403; `POST` on `/api/*` requires
`Content-Type: application/json` (415) and an `Origin` of the same origin or local (403), against CSRF. JSON responses
go out with `nosniff` and `Cross-Origin-Resource-Policy: same-origin`, without CORS.

## New version

`updates/checker.ts` queries `GET https://api.github.com/repos/<dono>/<nome>/releases/latest`, with no token, 5 s after
starting and then every 6 h (1 h after a failure). The repository comes from the `repository` field of `package.json`
(a fork only needs to change that field). The query sends `If-None-Match` with the ETag of the previous one, because
the 304 response doesn't use up the limit of 60 queries per hour without a token. The result (`repo`, `checkedAt`,
`etag`, `latest`, `url`, `publishedAt`) is kept in `<dataDir>/updates.json`, so that a restart doesn't repeat the query
before it is due. The tag must follow semver (`v1.2.3` or `1.2.3-beta.1`) and is compared with the version in
`package.json`. Responses: 404 = no release (`ok` without `latest`); 403/429 = GitHub limit (`error`). On a failure,
the last known release still holds. The status goes in the snapshot in `meta.updates` (`UpdateStatus` in
`shared/types.ts`) and, when it changes, the snapshot is republished. The release link only passes if it is from the
repository itself on GitHub. A new version found is announced once in the log. `HABBLAUD_UPDATE_CHECK=0` turns it off
(`state: 'off'`, no queries).

Each version has its own section in `CHANGELOG.md`; a test fails if the version in `package.json` has no section, and
`npm run release` (`scripts/release.ts`) creates the tag and the release with its text as the notes.

## Terminal

`GET /api/agents/:id/terminal` (`http/terminal.ts`) streams the session's conversation — prompts, replies,
tools and results, as Claude Code shows them — built from the transcript by `sources/terminal.ts`, with
secrets masked and texts truncated. On connecting (and on each reconnection) an `init` comes with the last 500
entries of the final ~4 MB of the transcript (`truncated: true` if some conversation was left out); after that, 400 ms
polling sends `append` with the new entries. Transcript truncated/replaced or swapped (`/clear` in the same process) =
`init` again; file gone = keeps trying. Demo agents have no transcript: the fictional conversation comes
from `shared/demo/terminal.ts` (updated every 500 ms). Ping every 15 s, at most 8 terminals at the same time,
a client with more than 8 MB accumulated is disconnected. What is typed in the terminal footer goes as a message (see
[Messages from the office](#messages-from-the-office)); the stream stays read-only.

The feature only exists with a **local bind** (`config.ts`, `terminalOffReason`), since it shows the whole conversation:

- Node: `HABBLAUD_HOST` loopback (127.0.0.0/8, `::1`, `localhost`); `0.0.0.0`, `::` or a network IP turn it off;
- Docker: the process always listens on `0.0.0.0` inside the container, so what counts is the port published on the
  host, `HABBLAUD_BIND` (the `docker-compose.yml` passes the same value on to the container): loopback turns it on;
  absent, empty or any other turns it off;
- `HABBLAUD_TERMINAL=0` always turns it off; no variable turns the terminal on with the port exposed.

Besides that, each request needs a local `Host` (`localhost`, `*.localhost`, 127.x or `[::1]`): network IPs and
names from `HABBLAUD_ALLOWED_HOSTS` (proxies, tunnels) get 403. The state goes out in `meta.terminal` of the snapshot
and in `terminal` in `/api/health`. Errors before the stream answer with JSON `{error}`: 403 (off or access that is not
local), 404 (unknown agent or transcript), 405 (method that is not `GET`), 429 (too many terminals) and 500
(unreadable transcript).

## Timeline (timelapse)

`history/timeline.ts` records the office for the client's timelapse in `<HABBLAUD_DATA_DIR>/timeline/AAAA-MM-DD.jsonl`
(the server's local day; in Docker, `/data/timeline`). Format and reconstruction in `shared/timeline.ts`; one record
per line:

- `{"t":"k", at, v, every, boot?, rooms, agents, accounts}`: **keyframe**, the full state. It opens each file,
  repeats every 5 min (`every`) and marks the server's boot;
- `{"t":"d", at, rooms?, agents?, accounts?}`: **delta**, only what changed (`[id, objeto | null]` for rooms and
  accounts; `[id, campos alterados | null]` for agents, with `null` = field or agent that left);
- `{"t":"end", at, reason?}`: the server stopped (`SIGTERM`/`SIGINT`) or the day reached the limit (`reason: "limit"`).

Each new snapshot of the `Hub` goes in (`hub.onSnapshot`, that is, each `Office` commit with a change), with a throttle
of 1 s and only when something the player draws changes. Per agent: id, kind, parentId, room, name, look, role, account,
status (with `statusSince`), waitingFor, activity (`kind`, `icon`, `text`, `at`, `tool`, `error`), seed,
background, title and summarized shells (without the command); agents, rooms and accounts of demo mode (`demo:`) carry
`demo: true`. Accounts without email, organization or folder. No transcript at all: it is the same exposure as
`/api/snapshot`, so the routes work with any bind.

- **Limits:** above 20 MB in the day, delta every 15 s and keyframe every 15 min; above 30 MB, stops until the rollover.
- **Retention:** the last 7 days (counting today); only `AAAA-MM-DD.jsonl` files are deleted.
- **Disk failures:** never bring the server down: a notice in the log, a new try in 1 min, starting over with a keyframe.
- **Gaps:** with no record for more than ~1.5× `every` (or after an `end`), the player shows "no data".
- `HABBLAUD_TIMELINE=0` turns the recording off (the routes keep serving the recorded days).

The day in the URL is only accepted as `AAAA-MM-DD` of a valid date and the file path is built only from it
(no `..`, encoded slashes or null bytes). `scripts/demo-timeline.ts` (`npm run demo:timeline`) uses the same
recorder, with a simulated clock and the `DemoSimulator`, to generate whole days with fictional data only.
## My day (the day's statistics)

`history/daystats.ts` samples the office snapshot every 1 s and passes the agents to the pure tracker in
`shared/daystats.ts`, which integrates, per agent, the time since the previous sample into the status it was in
(`working`, `waiting`, `shell`, `idle`; `done` and `offline` don't count), splitting the interval at `statusSince`.
Intervals of more than 2 min between samples (server stopped, computer asleep) don't count. Waits on you are
episodes of continuous `waiting` (those under 3 s are left out of the ranking); "wall-clock time with someone
waiting" joins the intervals of all the agents.

- **Counts:** `AgentStats` is cumulative per agent, so it counts what goes past the highest value seen so far (rereading
  a rewritten transcript doesn't count again). An agent that already existed (boot, `/resume`) becomes the baseline in
  the first 20 s (90 s at boot, while the beginning of the long transcripts is read in the background); a subagent born
  during the observation and a new session (or `/clear`) count from zero. An impossible jump in one sample (more than
  60 tools or 5 M tokens) is treated as a reread. Cost that shows up in an old agent is the session's total: it only
  becomes the reference. Prompts come from the `prompt` activities after the server's start; tasks, from what goes up
  in the number of completed ones. An agent that disappears and comes back keeps the baseline for 6 h.
- **1-hour buckets aligned in UTC** (per room, per account and who was present: sessions and subagents), stored
  per file day in the server's time zone. The requested day is assembled in the query, in the browser's `tz` time zone:
  in Docker (UTC) the panel's day still starts at the user's midnight.
- **Files:** `<dataDir>/stats/AAAA-MM-DD.json` (`StatsDayFile`, version 1), written every 30 s and on shutdown
  (temporary + `rename`); at boot it loads yesterday and today, indexes the others and deletes those more than 30 days
  old (again at each day rollover). An unreadable file becomes `.corrupt` and the day starts over; disk errors only
  produce a notice in the log.
- **Demo:** agents with a `demo:` id never enter the real data. With the demo on there is a separate bucket, in
  memory only, seeded with a fictional history from yesterday until now (`shared/demo/daystats.ts`) and fed live.
- **Exposure:** only aggregate numbers and project, account and agent names (the same as `/api/snapshot`), so the route
  doesn't have the terminal's local bind lock. Errors: 400 (`day` not in the `AAAA-MM-DD` format, nonexistent date, day
  in the future, repeated parameter, invalid `tz` or `source`), 404 (no data, outside the retention or demo off), 405.

Static files (`http/static.ts`): `/bundle/*` (Vite output with hash, `build.assetsDir`) with an `immutable` cache of
1 year; the rest (`index.html`, `client/public` at `/assets/*`) with `no-cache` + `ETag`/`Last-Modified` (304).

## Session history

`sources/history.ts` lists, on demand, the first-level transcripts `<config>/projects/*/<sessionId>.jsonl` of
each account (name in UUID format; subagents are left out) modified in the last 7 days, the 150 most recent.
From each file it reads only the first 64 KB (project = `cwd` of the first line that has it, first activity, the first
prompt) and the last 64 KB (title and last activity; with no title line there, it looks in the last 512 KB),
with asynchronous reading and a cache per path, valid while mtime and size don't change. The title follows the agent's
(`custom-title`/`custom-title.json` > `agent-name` > `ai-title` > `last-prompt`) and, with none, is the first prompt.
An open session (main agent of the account and of the `sessionId` in the office) goes out with `open: true` and
`agentId`; an ended one with no line with a time is omitted. The list goes from the most recent activity to the oldest.

`GET /api/sessions/:account/:sessionId/terminal` (`http/sessions.ts`) uses the same reader as the agent's terminal
(`TerminalStreams.attachSession`: `init` with the last 500 entries of the final ~4 MB, then `append`, with polling every
2 s in case the session is resumed) and counts toward the limit of 8 terminals. Validation: the account must be one of
the known ones (404), the id must have the UUID format (400) and the file, with links resolved (`realpath`), must be
inside the account's `projects/` folder (404); segments that don't decode answer 400. Both routes require the same
lock as the terminal (feature on and local `Host`, otherwise 403) and only accept `GET` (the list, also `HEAD`;
otherwise 405).
## Respond from the office

The Claude Code `PermissionRequest` hook (`mod/habblaud-permissoes/hooks/permission-hook.mjs`, with `matcher: "*"`:
through the `habblaud-permissoes` plugin in Claude Code 2.1.287+ or installed in `<account>/settings.json` by
`npm run hooks:install`) runs **together** with the terminal's permission dialog: whichever
answers first wins. In background subagents Claude Code runs the hook first and only shows the dialog after
it exits. The hook sends the request (`session_id`, `agent_id`/`agent_type`, `cwd`, `tool_name`, `tool_input` with
texts cut, `permission_suggestions` and its own `timeout_ms`) and waits; with `decided` it prints
`hookSpecificOutput.decision` (`allow`, with `updatedPermissions` = the original suggestion chosen, or `deny` with
`message`/`interrupt`); with `released`, an error or a timeout it exits without printing anything (the terminal wins).

Questions (`AskUserQuestion`) go through the same path. The request carries `questions` (masked and cut, with the
original position of each question and option in `index`; they also go in the snapshot) and the page answers with
`{behavior: 'answer', answers: [{question, options?, other?}]}`, by position. The registry checks against the original
format it kept (each question once; without `multiSelect`, one option or the free text; `other` up to 2,000
characters) and delivers `{status: 'decided', behavior: 'answer', answers}`; the hook swaps the positions for the
original texts from stdin and prints `allow` with `updatedInput` = the original input plus `answers`
(`{question: "Label A, Label B, free text"}`, as the hooks documentation says to answer `AskUserQuestion`). A plain
`allow` on a question is refused (400); `deny` is valid. A question that the office can't show in full (more than 4,
or none valid) is not diverted (`unsupported-tool`).

`permissions/registry.ts` (`PermissionRegistry`):

- it only accepts the request with some page connected through a local `Host` (`Hub.localSize`) and with the session
  known (main by the `session_id`; subagent by `<session_id>:<agent_id>`, or the main one with `subagent` = type);
  otherwise `{skip: 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many'}` (max. 32 open);
- it publishes the oldest request of each agent in `AgentInfo.permission` (without `input`, which only goes out through
  the detail; `queued` = how many wait after it) and sets the agent as `waiting`; `PermissionRequest` activity in the
  feed and the notice "asks for permission" (dedupe of the "needs you"); approving/denying become activities too;
- it releases the hook (`released`) when: `terminal` on the page, the hook's time limit + 5 s (`expired`), no hook
  waiting for 8 s (`orphan`), an agent that left (`gone`) or an answer in the terminal itself (`answered`): Claude Code
  doesn't end the hook when you answer there, so the registry finds the call at the end of the transcript
  (`permissions/transcript.ts`: name + signature of the arguments, the most recent one without a result) and waits for
  its `tool_result`; without the call, a main agent that was `waiting` in the session registry and left it 3 s ago;
- decisions not fetched are kept for 30 s; demo requests (`demo:perm-…`) go to the simulator.

The routes (`permissions/http.ts`) follow the terminal's lock: without `ServerConfig.terminal` → 403 on
all of them; a `Host` that is not local → 403. The guard already requires JSON and a local `Origin` on `POST`s. Errors:
400 (invalid body, suggestion or answer), 404 (request unknown, already delivered or expired), 405, 409 (already
answered).

## Messages from the office

The page sends text to a main agent (`POST /api/messages`, from the agent's drawer or from the terminal footer) and
the session's `habblaud-mensagens` plugin fetches it (`POST /api/mod/inbox`, every 2 s) and delivers it with
`$.prompt.submit({ text, asUser: true })`: the model reads it as if you had typed it. Then it confirms
(`POST /api/mod/inbox/ack`). Plugin details in [`mod/README.md`](../mod/README.md).

`messages/registry.ts` (`MessageRegistry`):

- **presence:** each time the plugin asks, it marks the session (the main agent with that `sessionId`, and the same
  `account` if it comes); seen up to 10 s ago, the agent goes out in the snapshot with `canMessage: true`. The
  snapshot only changes when the presence changes;
- **queue:** up to 5 open messages per agent (429) and 20,000 characters per message; the text goes as it was typed,
  never appears in the responses to the page or in the log, and is discarded when the message is resolved;
- **states:** `queued` → `sent` (the plugin fetched it) → `delivered` or `failed`. `queued` not fetched within 60 s,
  `sent` not confirmed within 30 s or an agent that left = `failed`, with the reason. `delivered` = it entered the
  session or its queue (with the agent busy, it enters when the agent finishes the turn). Resolved ones stay 10 min
  for the `GET`;
- delivered: activity ✉️ "Message via Habblaud" on the agent (the detail masked and cut); demo agents receive
  fictitious messages, delivered in ~1 s, with no real session.

The routes (`messages/http.ts`) follow the terminal lock plus one more switch: `ServerConfig.messages` = terminal on
and `HABBLAUD_MENSAGENS` not turned off (`0`, `false`, `off`, `no`). Turned off or a `Host` that is not local → 403 on
all of them. Errors from `POST /api/messages`: 400 (invalid body, empty text or too long), 404 (unknown agent), 409
(the agent doesn't receive: subagent, left or session without the plugin connected) and 429. The state goes out in
`meta.messages` of the snapshot and in `messages` in `/api/health`.

Any local process can call these routes (like the permission ones): turning messages on means accepting that a
program on the same machine can type into the sessions that have the plugin.

## Project character

`PUT /api/agents/:id/character` (`http/app.ts`, rules in `Office.setCharacter`) chooses the name and the appearance of
the main agent `:id` and saves them as the character of its room (the normalized cwd), in `names.json` › `rooms`:
`{name, look, seed, parts?, owner?, at}`.

The body has three fields:

- `name`: 1 to 24 characters, in NFC, with repeated spaces joined and no control characters;
- `seed`: integer from 0 to 4294967295;
- `parts`: pieces from `shared/appearance.ts`, with the styles from the enums and the colors in `#rrggbb`. The client
  applies the pieces on top of `appearanceFromSeed(seed, {look})`.

Rules:

- When a main agent arrives at a room that has a character, and the name is free, it is born with `name`, `look`,
  `seed`, `parts` and `custom: true`. Whoever is leaving doesn't count, because it is usually the same session
  reopened. If the name is not free, the usual random draw applies.
- The character has an owner (`owner`, the `sessionId` of whoever received it or saved it last; `/clear` passes the
  owner to the new session): a session that is not the owner and already has a stored name keeps its own, so that a
  Habblaud restart doesn't swap identities or change a session's character in the middle of it.
- The chosen names stay reserved: the random draw doesn't hand them out, ignoring case. The `PUT` responds `409`
  for the name of someone present (including from the demo) or the name of another room.
- `/clear` keeps the character and doesn't save the chosen name as the randomly drawn name of the new session.
- `DELETE` deletes the room's character, and the agent goes back to the session's randomly drawn name and to the
  id's seed.
- Lock: the same as the terminal's (local bind and local `Host`). Without it, `403`. A subagent, the demo or an
  unknown agent gives `404`.
- A character not used for 60 days disappears, like the names.

## Codex

Agent sources (`sources/source.ts`): `SourceSet` joins the Claude Code one (`ClaudeWatcher`) and, when there are
Codex folders, the Codex one (`sources/codex/`); the history likewise (`HistorySet`). Codex agents, accounts, sources
and history sessions carry `provider: 'codex'` (absent = Claude Code). Ids: `<account>:<threadId>`, `sessionId` = threadId.

- **Accounts** (`sources/codex/accounts.ts`): `HABBLAUD_CODEX_DIRS` (replaces) or `CODEX_HOME` and `~/.codex*` that
  look like Codex (`isCodexHome`: `thread-writer-locks/`, `archived_sessions/`, `config.toml`, `auth.json` or
  `sessions/AAAA/`, without `projects/`, which only Claude Code creates). A Codex folder never becomes a Claude Code
  account. `auth.json` and `config.toml` are never read; the plan comes from `rate_limits.plan_type`.
- **Open sessions** (`sources/codex/files.ts`, `source.ts`): `thread-writer-locks/<threadId>.lock` existing for 3 s
  (the quick maintenance locks are left out; the lock is never opened). Lock without rollout = open and empty session:
  the lock doesn't say the folder, so the main agent only enters when the rollout (created on the 1st prompt) or a
  hook says the cwd. Lock and rollout idle for 12 h, with no hook event = crash lock. Without the
  locks folder: rollout modified in the last 30 min. A hook event holds the presence for 60 s.
- **Rollout** (`sources/codex/rollout.ts`): `sessions/AAAA/MM/DD/rollout-*-<threadId>.jsonl` (the folder is the
  creation date; a resumed session continues in the old file) and `archived_sessions/`, read with `FileTail`. Formats
  "paginated" (default) and "legacy"; `.zst` is ignored with a notice. Status by `task_started`/`task_complete`/
  `turn_aborted`; activities by `item_completed` (`CommandExecution` like Bash, `FileChange`, `McpToolCall`,
  messages and reasoning); tokens without adding the cache again (in Codex it is already inside the input); no cost;
  plan usage by `token_count.rate_limits` (window of 300 min = 5 h, 10080 = week; `primary` null with
  `rate_limit_reached_type` = `noQuota`), pushed with `accounts.setUsage`. Subagents = threads with
  `source.subagent.thread_spawn.parent_thread_id`; internal threads (guardian, review, compact, memory) are left out.
- **Terminal and history** (`sources/codex/terminal.ts`, `history.ts`): the terminal parser is chosen per agent
  (`SourceSet.parserFor`).
- **Hook events** (`POST /api/codex/events`, `codex/http.ts`; the hook is `mod/habblaud-codex/hook.mjs`): only with
  a local `Host` and a connection over loopback (outside Docker). They go to the source's
  `CodexLive.applyHookEvent`: they match by account (by the `codexHome` folder) and `agent_id ?? session_id` (in
  Codex, `session_id` is the ROOT thread). SessionStart makes the agent appear, UserPromptSubmit/PreToolUse = working
  (with the current activity), PermissionRequest = waiting ("approve a command"), Stop = idle, SessionEnd closes.
- **Approve from the office** (`permissions/*`, `permissions/codex.ts`): the same `POST /api/permissions` with
  `provider: 'codex'`, `account` and `codexHome`; no suggestions, no questions, no search in the transcript;
  `interrupt` or `suggestion` in a Codex request = 400. The hook waits up to `permissionTimeoutS` from
  `~/.habblaud/codex-hook.json` (default 25 s) and prints only `allow` or `deny` (+`message`). Codex only shows the
  approval in the terminal after the hook finishes.
- **Messages** (`messages/*`, `messages/codex.ts`): for Codex agents, `codex queue --thread=<id> --message=<texto>`
  with `CODEX_HOME` = the account's folder (on the host). Outside Docker the server runs the command
  (`HABBLAUD_CODEX_BIN` or `codex` from the PATH); in Docker, the host helper (`npm run codex:bridge`) fetches from
  `POST /api/codex/bridge/poll` and confirms at `/ack` (same lock as the messages). `canMessage` = there is a
  deliverer (binary found, or helper seen up to 10 s ago). Return 0 = it entered the session's queue (`delivered`);
  Codex consumes the queue every ~10 s, when the session goes idle.

## Habblaud World

On by default, pointing at `server.habblaud.com` (`DEFAULT_WORLD_URL` in `config.ts`); nothing leaves the computer
before the person creates the account and signs in, and `HABBLAUD_WORLD=0` turns everything off (what leaves the computer:
`docs/world/privacidade.md`; how to work on it: `shared/world/README.md`). The protocol with the world server is `shared/world/protocol.ts` (source of truth, with
`schema.json`). On this side, `world/`:

- `settings.ts`: `<dataDir>/world.json` `{deviceId, token, email, access, player?, paused?, left?, updatedAt, theme?}`, mode 600
  and atomic write. The device token only leaves here in the `Authorization: Bearer` header of the calls to the world
  server and in the `hello` of the WebSocket: never in the browser, the snapshot, the log or the URL. `theme` (the
  Appearance choice, `auto` by default) stays even without a session (the file becomes just `{theme}`); `paused` and
  `left` (left the world, always with `paused`) belong to the session.
- `client.ts`: the `/v1/*` routes with the native `fetch` (15 s timeout, without following redirects, response of up
  to 256 KB copied field by field; the data export, up to 8 MB and as it came). A world server error comes back as
  `{status, code}` (maintenance, `503 maintenance`); network, timeout and a response outside the format get
  `world_unreachable`, `world_timeout` and `world_bad_response`.
- `altcha.ts`: the anti-robot challenge of the sign-up and of the email requests, solved here by brute force
  (SHA-256), in batches of 5,000 attempts that give the turn back to the event loop.
- `service.ts`: the account (one operation at a time). `/v1/me` is reread at most every 30 s (or with `?refresh=1`)
  and, on the waiting list, on its own every 30 min (`waitingPollMs`; a timer that doesn't hold the process), so that
  the approval reaches the snapshot without anyone clicking; a 401 from the world server on a route with a token
  deletes the session here (`lastError: session_expired`); signing in again revokes the previous device; signing out
  deletes `world.json` even without a response from the server. `lastError` carries only known codes
  (`worldLastError` in `shared/world/api.ts`): network and timeout become `network`, the rest that the interface
  doesn't know becomes `unknown`. Pause, resume and leaving the world go to the world server in a queue (in the order
  requested); a resume with no response (network, timeout, 429, 5xx) tries again with the wait of the uplink
  reconnection (2 s to 60 s), until it works or the building is paused again. Deleting the account (Phase 6): the
  code comes from `POST /v1/me/delete`; with `POST /v1/me/delete/confirm` accepted (or a `goodbye: deleted`), it
  closes the uplink and waits, deletes the whole `world.json` (theme included, `store.erase`) and the last upload,
  and the status is left with no account with `lastError: account_deleted`. Exporting the data
  (`GET /v1/me/export`) only passes the JSON along.
- `uplink.ts`: the building in the world, over WebSocket (the global `WebSocket` of Node) at `<HABBLAUD_WORLD_URL>/v1/socket`
  (`wss://`; `ws://127.0.0.1` and `ws://host.docker.internal` only in dev mode). It connects only with the approved account, the character created and the
  terminal lock; paused or out of the world, only while the World scene is open (the viewer tells it with `cityChanged`) and without
  any `uplink` (not even the one of the `welcome`): only `hello`, `ping`/`pong` and the scene's commands. It sends the `hello` (`{v, version, build: {commit, dirty}, locale, token}`) and, on each `welcome`, the
  whole packet; then, on each change of the office (`Office.onChange`) or every minute, it projects
  (`shared/world/projection.ts`) and sends if it changed: 3 s since the first change, at most one upload every 5 s.
  `{t: 'ping'}` every 30 s (no response for 75 s, it reconnects). Reconnection from 2 s to 60 s (doubles, ±25 %).
  `goodbye`: `deploy` reconnects (during world maintenance, `deploy` on each `hello`: the wait grows up to the cap and
  only resets with a `welcome`); `banned`, `suspended`, `update` and `other-device` stop until it is resumed (or
  reopened); `waiting`, `no_player` and `unauthorized` stop until the session changes and notify the account
  (`service.goodbye`); `deleted` stops and the account deletes the session. From the `welcome` it keeps, only in
  memory and only for the status, the account id (`me.id`, in the subject of the appeal by email) and the
  "unverified" badge of the building itself (`building.unverified`, which the `area`/`area.patch` of the scene
  also updates). `uplink.ack {error:
  'left'}` (the account left the world, here or on another computer) and the `left: true` of `/v1/me` save `left` and
  `paused` (`service.leftElsewhere`): no packet until the join (the connection only stays with the scene open). The
  last upload `{at, bytes, uplink, ack}` stays in memory and in `<dataDir>/world-last-uplink.json` (mode 600; only
  from the same session, deleted on signing out). It notifies the snapshot (`markDirty`) on connecting, dropping,
  pausing, resuming and on each ack. Tasks and compactions (`signals.ts`) are observed by the same
  `Office.onChange`, at most once per second, with or without a connection; during the office boot
  (`Office.isBooting`) nothing is observed or sent.
- `ids.ts`: the world ids, only in memory (`f_` + 10 hex per room, `a_` + 8 hex per agent, `crypto.randomBytes`),
  each with a life of 24 h ± 6 h drawn at random per id; whoever disappears and comes back (or Habblaud restarted)
  gets a new id.
- `tokens.ts`: the building's tokens (input + output) for today and for the 7 running days, from "My day" with the
  `real` source (the demo never enters), rounded to 2 digits; the past days stay stored, today's is reread every 15 s.
- `theme.ts`: the chosen theme resolved for the packet (the automatic one follows the office calendar, by the local
  date of the server: in Docker, UTC). `signals.ts`: tasks completed in the day per agent and new compactions
  (`/clear` doesn't count).
- `http.ts`: the `/api/world/*` routes (list and formats in `shared/world/api.ts`). `http/app.ts` only serves them on
  the local port with a local `Host` (the phone port gets 403 `local_only`, not even with login); everything, except `status`, requires
  the terminal lock (403 `terminal_off`); with `HABBLAUD_WORLD_URL` refused, 409 `not_configured`; `HABBLAUD_WORLD=0`, 404.
  Errors: `{error: {code, message?, retryAfter?}}`, with the status and the code of the world server when they come
  from there. For the building: `PUT /api/world/theme` `{theme}` (with or without an account),
  `POST /api/world/pause` (stops the sending before responding, closing the uplink if the World scene is not open,
  and notifies `POST /v1/me/building/pause`), `POST /api/world/resume` (notifies `/resume` and reconnects, or sends
  the whole packet over the scene's connection), `POST /api/world/leave` ("Leave the world": saves `left` and
  `paused`, stops the sending like the pause and responds after the `DELETE /v1/me/building`; without a good
  response, it stays only paused and returns the error), `POST /api/world/join` ("Back to the world":
  `POST /v1/me/building/join` and, only with the good response, removes `left` and `paused` and reopens the uplink;
  the 404 here doesn't count as done; the `/resume` out of the world goes through it and, without having left, it is
  the `/resume`) and `GET /api/world/last-uplink` (`{at, bytes, uplink, ack?}` or `{}`, without the terminal lock,
  like the status). `GET /api/world/status` gains `building` (approved account with a character) and `theme`;
  without `?refresh=1` it responds from memory and rereads `/v1/me` in the background when it has expired. For the
  account (Phase 6): `POST /api/world/delete-account` (`202 {}`: the code goes to the email),
  `POST /api/world/delete-account/confirm` `{code}` (responds with the status without an account after closing the
  building and deleting `world.json`), `GET /api/world/export` (the JSON as the attachment
  `habblaud-world-dados.json`; like the stream, only from the page itself, because it spends the day's quota; `HEAD`
  doesn't call the world server) and the optional `notifyInactivity` in `PUT /api/world/visibility`.

The state goes in the snapshot in `meta.world` (`{enabled, configured, state, building?, scene?}`, nothing from the account; `building` =
`{connected, paused, floors, agents, lastUplinkAt?, left?, stopped?}`, with `connected` = lit and sending (the
scene-only connection, paused, doesn't count) and `stopped: true` without the reason, which only goes in the status;
`scene` = `{available}` with the approved account and the character, `available` with the terminal lock and no stop
from `banned`, `suspended`, `update`, `other-device` or `deleted`: the World button of the bar) and in
`GET /api/access` (`world`). The build writes `dist/build.json` (`{commit, dirty, builtAt}`,
`scripts/build-info.mjs`; without git, `unknown`; `HABBLAUD_BUILD_COMMIT`/`HABBLAUD_BUILD_DIRTY` replace git), read
by `readBuildInfo()` (`build.ts`) on each uplink connection: the `hello` carries only `{commit, dirty}`.

### World scene: stream and commands

The city (Phase 3) comes down over the same connection as the building and only with the World scene open in the
browser. `world/viewer.ts` is the "viewer"; the state and the rules live in `shared/world/scene.ts` (pure, the browser
can use the same one), and the geometry in `shared/world/city.ts` (source of truth; the world server keeps the exact
copy).

- `GET /api/world/stream` (SSE, the same locks as the account routes, and only from the page itself: an `Origin` from
  another host or a cross-site/same-site `Sec-Fetch-Site` gets 403 `local_only`). At most 4 open (429
  `too_many_streams`). Events: `world.snapshot` (`WorldSceneSnapshot` from `shared/world/api.ts`: `{stream, connected, viewing, district?,
  me?, pos?, afk, chunks: [{chunk, rev, buildings}], players, minimap}`) on connecting and on each restart (connection
  opened or dropped, `view` again): the browser replaces the whole state; then `world` with each message from the city
  as it came (`area`, `area.patch`, `players`, `player.join`, `player.leave`, `pos`, `minimap`, `afk`, `profile`,
  `notice`, `like.update`, `greeting`, `building`, `building.patch`), in order and already without a `rev` gap;
  `: ping` every 15 s. A client with more than 1 MB accumulated is disconnected (the EventSource reconnects).
- The first stream (with the connection accepted) sends `view`; the last one to close sends `view.off`. On each
  `welcome` with a stream open, `view` again; on each drop, the city here is forgotten and a snapshot goes out with
  `connected: false`. Paused or out of the world, the connection only exists with the scene open: opening the first
  stream connects (`hello`, `view`) and closing the last one sends `view.off` and closes; no `uplink` goes out over it.
- State rules: `area` replaces the chunk and the `rev` (even a lower one); `area.patch` only with `rev` = last + 1
  (an item with `lot` replaces the building, without `lot` it merges, `removed` takes it out); a gap, an unknown chunk
  or a partial item of a building that is not here ask for `resync {chunk}` (at most one every 5 s per chunk) and the
  patch doesn't go through; only the 3×3 chunks around my position stay (the last `pos`, my id in a `players` or the
  last `move`); `players` only touches whoever is already there (by id); `player.join` replaces the profile; `afk`
  holds until walking or turning, `view` or `profile`. All only in memory, nothing in the log.
- `POST /api/world/cmd` `{stream, cmds}` → `202 {sent}`: 1 to 20 commands, only `move`, `profile`, `resync`, `view`,
  `view.off`, `enter`, `leave`, `like`, `unlike`, `greet`, `block`, `unblock` and `report`, rebuilt field by field
  (`parseSceneCommand`; `hello`, `uplink` and `ping` never: 400 `invalid`); from each batch only the last `move`. Up
  to 5 batches per second per stream (bucket of 5, refill of 5/s: one batch every 200 ms is never refused; 429
  `rate_limited` with `Retry-After: 1`). A stream that is not open: 409 `no_stream`; without the connection: 409
  `not_connected`. `view` and `view.off` say whether that stream wants the city (the viewer decides what goes to the
  world; `view` with the city open restarts everything).
- In the browser, `client/src/net/world-stream.ts`: `createWorldStream({mock})` with `on`, `send` (queue and one batch
  every 200 ms) and `close`; in demo mode, `FakeWorldStream` (20 buildings with mine on lot (3,1), 5 people walking
  on the sidewalks and one sitting on a bench in the square, minimap, `afk` after 60 s; `?perf=N` fills N lots).

## Environment variables

| Variable | Default | Use |
| --- | --- | --- |
| `HABBLAUD_PORT` | `4747` | HTTP port |
| `HABBLAUD_HOST` | `127.0.0.1` | interface (Docker uses `0.0.0.0`); outside loopback, the terminal (and the permissions and messages) stays off |
| `HABBLAUD_BIND` | — (Compose: `127.0.0.1`) | Docker only: host interface where the port is published, passed on to the container; only loopback turns the terminal on |
| `HABBLAUD_TERMINAL` | — | `0` turns off the terminal, the permissions and the messages from the office (it doesn't turn on with the port exposed) |
| `HABBLAUD_CODEX` | on | `0` turns off the Codex source |
| `HABBLAUD_CODEX_DIRS` | — | Codex folders separated by commas; replaces the detection (`CODEX_HOME` and `~/.codex*`) |
| `HABBLAUD_CODEX_BIN` | `codex` from the PATH | Codex binary for `codex queue` (Node mode and `npm run codex:bridge`) |
| `HABBLAUD_MENSAGENS` | on (with the terminal) | `0`, `false`, `off` or `no` turn off only the messages from the office |
| `HABBLAUD_CLAUDE_DIRS` | — | config dirs separated by commas; replaces the detection (`~/.claude*` with `projects/` or `sessions/` + `CLAUDE_CONFIG_DIR`) |
| `HABBLAUD_DATA_DIR` | `~/.habblaud` (Docker: `/data`) | Habblaud state (names and characters of the projects persisted in `names.json`, timeline in `timeline/`, My day statistics in `stats/`, last version check in `updates.json`) |
| `HABBLAUD_TIMELINE` | on | `0` turns off the recording of the timelapse timeline |
| `HABBLAUD_UPDATE_CHECK` | on | `0` turns off the check for a new version (releases of the `package.json` repository on GitHub, every 6 h) |
| `HABBLAUD_LANG` | system language (`LC_ALL`/`LANG`/Intl) | language of the texts built by the server: `pt-BR` or `fr` (shared/i18n.ts) |
| `HABBLAUD_DEMO` | off | `1` turns on demo mode at startup |
| `HABBLAUD_IN_DOCKER` | auto (`/.dockerenv`) | `1` = doesn't check PIDs (they are the host's) |
| `HABBLAUD_ACCOUNTS` | — | JSON with account metadata coming from the host (Docker): `[{id, configDir, mountDir, short, name, email, organization, plan, color, cachedUsage}]`, matched by `id`, `mountDir` or `configDir` |
| `HABBLAUD_USAGE_DIR` | `~/.habblaud/usage` (Docker: `/usage`) | folder of the usage captured by the statusline tap or by the Claude Code mod, reread every 5 s |
| `HABBLAUD_ALLOWED_HOSTS` | — | extra names accepted in `Host`/`Origin` (comma); `localhost`, `*.localhost` and IPs always count |
| `HABBLAUD_WORLD_URL` | `https://server.habblaud.com` | Habblaud World server: only `https://` or `wss://`, no path; `http://127.0.0.1:*` only in dev mode (refused, World stays off). The building goes up over the WebSocket on the same origin (`/v1/socket`) |
| `HABBLAUD_WORLD` | on | `0` (`false`, `off`, `no`) turns off Habblaud World: routes 404, nothing in the interface and nothing leaves |
| `HABBLAUD_WORLD_DEV` | off (`--dev` turns it on) | `1` accepts the world server at `http://127.0.0.1` or `ws://127.0.0.1` |

In the permission hook (Claude Code environment; the `--port`/`--timeout` arguments saved by the installer take
precedence): `HABBLAUD_PORT` (Habblaud port, default `4747`), `HABBLAUD_PERMISSION_TIMEOUT` (seconds to wait
for the answer in Habblaud, default `300`, between 5 and 1800) and `HABBLAUD_HOOK_DEBUG=1` (tells on stderr what it did).

## Plan usage (5h and weekly)

Two sources, both local files (no credentials and no network calls); the one with the most recent numbers wins
(`fetchedAt`):

- `statusline` (**recommended**, `accounts/statusline.ts`): Claude Code sends the statusline command a JSON
  with `rate_limits` (`five_hour`/`seven_day`: `used_percentage` and `resets_at` in seconds).
  `scripts/statusline-tap.mjs`, installed in front of each account's statusline by `npm run usage:install`,
  saves only those numbers in `~/.habblaud/usage/<account>.json` (matched with the account by `configDir`; otherwise
  by `accountId`). On Claude Code 2.1.287+ the Habblaud mod writes the same file (see below);
- `cache`: the `cachedUsageUtilization` that Claude Code itself writes when running `/usage`, reread every 60 s.

Without either of the two, the account stays `disabled` ("no usage data"). Numbers more than 30 min old show up as
`stale`. A window whose reset has already passed since the collection is omitted (the interface shows "—") until
new numbers arrive — never a made-up 0%.

## Claude Code mod

The repository is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, details in
[`mod/README.md`](../mod/README.md)). On the server side, the `habblaud` mod uses two things:

- **the usage file:** on each `session.start` and `session.measure` it writes `<HABBLAUD_USAGE_DIR>/<account>.json`
  in the tap's format (`{accountId, configDir, fetchedAt, five_hour, seven_day}`, `resets_at` in seconds, from
  `$.session.usage().rateLimits`) plus `source: "mod"`, which the reader ignores: for the server it is still the
  `statusline` source. The mod writes with `$.fs.write`, which is not atomic; so `StatuslineUsageReader` ignores an
  empty or half-done read, keeps the last good record of that file and rereads it on the next cycle;
- **`GET /api/mod/summary`** (`modSummary` in `http/app.ts`), asked every 5 s per session that draws (30 s with
  Habblaud down) and by the `/habblaud` command: only counts and who is waiting, built from the current snapshot. Left
  out are the demo agents (which live only in the snapshot, not in the `Office`), whoever has already ended or
  delivered and, with `?session=` (and `?account=`, if it comes), the session of whoever is asking: the main agent
  with that `sessionId` and its subagents (their `sessionId` is that of the session that launched them; to be safe,
  also whoever has an ancestor from it). `answerable` = there is a permission request to answer from the office
  (`AgentInfo.permission`). Without parameters, nothing is excluded (it is what `/habblaud` uses, so that the numbers
  match the screen). Only `GET`/`HEAD` (otherwise 405).

## Structure

- `config.ts`, `log.ts`, `index.ts` — configuration, short logs (never conversation content) and entry point.
- `accounts/` — account detection (`detect.ts`, also used by `docker-up`), usage (`usage.ts`), statusline tap (`statusline.ts`), service (`service.ts`).
- `sources/` — session registry, incremental reading (`tail.ts`), transcript parser (activities in `transcript.ts`; terminal conversation in `terminal.ts`; GitHub events in `github.ts`), subagents, the session history (`history.ts`) and the orchestrator (`watcher.ts`).
- `model/` — office (`office.ts`), rooms/slots (`rooms.ts`), persisted names (`names.ts`).
- `http/` — edge protections (`guard.ts`), routes (`app.ts`), SSE (`sse.ts`), terminal (`terminal.ts`) and its history (`sessions.ts`), timelapse (`timeline.ts`), My day (`stats.ts`), static files (`static.ts`).
- `history/` — recorder of the timelapse timeline (`timeline.ts`) and the My day statistics: sampling, persistence and retention (`daystats.ts`; the pure accumulator lives in `shared/daystats.ts`).
- `permissions/` — answering from the office (permissions and questions): registry of the requests (`registry.ts`), routes (`http.ts`) and the search for the call in the transcript (`transcript.ts`).
- `messages/` — messages from the office: queue, presence of the sessions and deadlines (`registry.ts`) and routes (`http.ts`).
- `updates/` — check for a new version in the GitHub releases (`checker.ts`).
- `world/` — Habblaud World: session in `world.json` (`settings.ts`), client of the world server (`client.ts`), ALTCHA (`altcha.ts`), the account (`service.ts`), the `/api/world/*` routes (`http.ts`) and the building in the world (`uplink.ts`, with `ids.ts`, `tokens.ts`, `theme.ts` and `signals.ts`).

Tests: `npx vitest run server shared` (synthetic fixtures in `server/test/fixtures.ts`; the host scripts —
statusline tap, permission hook (run as a process against a test server), installers and
`docker-up` — are tested in `server/test/` with fake HOME and config dirs).
