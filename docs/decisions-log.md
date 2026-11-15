# Decisions log

## 2026-11-15: GitHub Copilot CLI source ([PR #6](https://github.com/HoneyBearTech/habblaud/pull/6))

**Copy and adapt the Codex reader instead of generalising it.** This keeps the working Codex code and its tests untouched. Rejected: a shared base for both readers, which means a larger, riskier diff for no visible gain.

**The events file decides presence. `open-sessions-state.json` is only a hint.** The file still lists sessions after `session.shutdown`, and in Docker a single-file mount can go stale. Rules:
- A session is shown while it has no shutdown event and is either listed as open or was written in the last 30 minutes.
- A waiting state with no write for one hour drops to idle.
- A working state with no write for 30 minutes drops to idle.
- `refreshedAt` counts as activity only when it is newer than the file.

**When a reply is finished.** `assistant.turn_start` / `turn_end` wrap every model call. A reply is done only when an `assistant.message` has no tool requests, no tool call is still open, and `turn_end` follows.

**Copilot is left out of Habblaud World, agents and tokens both.** The world server's schema only accepts the two existing tool values. Reporting Copilot under one of them would be untrue, so it is left out until the server accepts `copilot`. Rejected: changing the World schema or protocol in this repo alone, because the world server would reject the packets.

**No usage bar, hooks, messaging or approvals for Copilot.** Copilot writes no quota data to its files. Live hooks would need an installer. The office has no channel to send messages or approve prompts for Copilot. Token counts come from `session.usage_record`.

**A small built-in `workspace.yaml` reader** for top-level `key: value` lines, because the server has no runtime dependencies. Indented lines are ignored, and quoted values keep ` #`.

**Docker mounts only `session-state/` and `open-sessions-state.json`**, read-only and never creating host paths. A mount source that a symlink takes outside the Copilot home is skipped.

**Test fix outside the feature:** `server/world/uplink.test.ts` "changed theme sends again" failed every year from 1 Nov to 26 Dec, because the automatic theme was already the one the test set. The test now starts from a fixed theme. Nothing else in `server/world/` changed.

**Review findings rejected:**
- *Tokens may always be 0 because `session.usage_record` is missing.* Current Copilot versions do write `session.usage_record` with `data.usage.inputTokens` and `outputTokens`. The two sessions the reviewer had locally were from an old and an aborted run.
- *The replay buffer can grow while background reads queue up.* It is capped at 8 MB of text per session and drains on its own.
- *Time-of-check/time-of-use gap between the realpath check and the open.* This needs a local attacker racing file swaps inside the user's own Copilot home. That is acceptable for a read-only local viewer.
- *Filesystem error messages in the log can contain session file paths.* This matches the Codex reader. No session content reaches the logs.
