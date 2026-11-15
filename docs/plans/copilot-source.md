# Plan: GitHub Copilot CLI in the office

## What Sean asked for

"Add GitHub Copilot CLI support, so Copilot sessions show up in the office as characters next to the other agents."

## What we found

- Habblaud reads each agent tool's own session files. Codex already has its own reader (`server/sources/codex/`), which is the model for this one.
- Copilot CLI keeps one folder per session in `~/.copilot/session-state/<id>/`. Each holds `events.jsonl` (one event per line: prompts, turns, tool runs, permission prompts, usage, shutdown) and `workspace.yaml` (session id and working folder). `~/.copilot/open-sessions-state.json` lists the sessions that are open.
- `open-sessions-state.json` can still list a session after it has shut down, so it can only be a hint. The events file decides.
- Habblaud World only accepts the two existing tool names as an agent's tool. The world server checks every packet against that list, and that server isn't in this repo. Today the code would report a Copilot agent under the default tool name, which would be untrue.

## What we'll change

1. **A new Copilot reader** in `server/sources/copilot/`: `accounts.ts`, `files.ts`, `events.ts`, `source.ts`, `history.ts` and `terminal.ts`, copied from the Codex reader and cut down.
   - It finds Copilot homes from `COPILOT_HOME` or `~/.copilot`, or from a new `HABBLAUD_COPILOT_DIRS` list. `HABBLAUD_COPILOT=0` switches it off.
   - It reads only `session-state/<id>/events.jsonl`, `session-state/<id>/workspace.yaml` and `open-sessions-state.json`. It never opens `config.json`, `permissions-config.json`, `session-store.db*`, `logs/`, `command-history-state.json`, `settings.json` or `hooks/`.
   - `workspace.yaml` is read with a small built-in reader for top-level `key: value` lines, because the server has no runtime dependencies.
   - Checked by: new tests next to each file, with made-up sample sessions.
2. **Events to office activity.**
   - `session.start` and `workspace.yaml` `cwd` set the room.
   - `user.message` is a prompt. Lines the tool adds itself, such as memory notes, are skipped.
   - `assistant.turn_start`, `tool.execution_start` and `tool.execution_complete` mean working, with the tool's name and title as the activity line.
   - A final `assistant.message` with no tool requests, then `assistant.turn_end`, means idle.
   - `permission.requested` without a matching `permission.completed` means "needs you".
   - `session.shutdown` means the character leaves.
   - Token counts come from `session.usage_record`.
   - Checked by: event tests for each case, including unknown event types and broken lines.
3. **Wiring.**
   - Register the reader in `server/index.ts` next to the Codex one, with a `copilot` switch in `server/config.ts`.
   - Add `copilot` to the agent-tool type and give it its own text wherever the code now splits Codex from the rest. Examples: the messages and approvals panels, where Copilot gets a plain "not available for Copilot" state, and the terminal view.
   - Checked by: `npm run typecheck` and the existing tests.
4. **Screen.**
   - A COPILOT tag on characters and an account chip for each Copilot home, built the same way as the Codex ones.
   - The usage card says Copilot shares no usage limits. Copilot writes no quota data to its files, so there is no account usage bar. Each session's token counts still show.
   - Checked by: client tests (`provider.test.ts` and others).
5. **Habblaud World.** Copilot agents are left out of World packets until the world server accepts `copilot`. They are never reported as another tool. Checked by: a World projection test.
6. **Docker.** `scripts/docker-up.ts` mounts each Copilot home's `session-state/` folder and `open-sessions-state.json` file read-only at `/copilot/<account>/...`, the same way as the Codex mounts, and passes `HABBLAUD_COPILOT_DIRS`. `docker-compose.yml` passes `HABBLAUD_COPILOT`. Checked by: the docker-up tests.
7. **Words and docs.**
   - Every new visible text is translated in all four languages (`npm run i18n:check` shows none missing).
   - A "Copilot" section goes in each of the four READMEs and in `server/README.md`.
   - A `CHANGELOG.md` entry goes under Unreleased.

## Who's on it

Research (done), an Engineer, QA, a Security Officer and an independent Auditor.

## Risks

- Copilot's file format isn't documented and may change. Unknown events and fields are ignored, not treated as errors.
- In Docker, a single-file mount can go stale if Copilot replaces the file instead of rewriting it. Because the events file decides presence, a stale `open-sessions-state.json` can't keep a character in the office.
- Leaving Copilot out of World means World visitors don't see those characters for now.

## Out of scope

- Live status through Copilot hooks. The events file is read every second, which is already close to live. Hooks would need an installer like the Codex one.
- Sending messages or approving permissions from the office for Copilot.
- A Copilot usage/quota bar.
- Changing the World protocol.
