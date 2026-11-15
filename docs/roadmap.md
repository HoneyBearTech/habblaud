# Roadmap

## Done

- **GitHub Copilot CLI in the office** (2026-11-15, [PR #6](https://github.com/HoneyBearTech/habblaud/pull/6)): a read-only Copilot source, a COPILOT tag and account chip, Docker mounts, and texts in four languages.
- **Copilot AI-credit usage** (2026-11-15, [PR #11](https://github.com/HoneyBearTech/habblaud/pull/11)): AI credits used this month and today, counted from the session files, with a bar against `HABBLAUD_COPILOT_CREDIT_LIMIT`.
- **Copilot AI-credit scale confirmed** (2026-11-15): 1 unit (`totalNanoAiu` / 1e9) is 1 AI credit. GitHub's billing page showed 254 credits for the CLI, and the count from the session files was 253.7.

## Open

- **Copilot in Habblaud World:** Copilot agents and their tokens are left out of World until the world server accepts a `copilot` tool value in its schema.
- **Copilot live status through hooks** (`~/.copilot/hooks/*.json`): optional. The events file is already read every second.
- **Copilot AI credits, still to confirm:**
  - Check whether credits reset on the 1st (UTC) or on the billing date.
  - Check what a resumed session's running total does. Restart and continue are both handled, but neither has been seen in real data yet.
- **Copilot credits from other places:** editor and website use isn't in the CLI session files, so the count covers this computer's CLI sessions only.
- **Copilot subagents** as separate characters: their events live inside the main session's file, and the layout isn't confirmed yet.
- **Docker single-file mount:** check whether Copilot replaces `open-sessions-state.json` (new inode) or rewrites it in place. If it replaces it, the container's copy goes stale. The source already treats the file as a hint.
