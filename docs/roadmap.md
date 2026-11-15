# Roadmap

## Done

- **GitHub Copilot CLI in the office** (2026-11-15, [PR #6](https://github.com/HoneyBearTech/habblaud/pull/6)): a read-only Copilot source, a COPILOT tag and account chip, Docker mounts, and texts in four languages.

## Open

- **Copilot in Habblaud World:** Copilot agents and their tokens are left out of World until the world server accepts a `copilot` tool value in its schema.
- **Copilot live status through hooks** (`~/.copilot/hooks/*.json`): optional. The events file is already read every second.
- **Copilot usage bar:** blocked. Copilot writes no quota data to its session files.
- **Copilot subagents** as separate characters: their events live inside the main session's file, and the layout isn't confirmed yet.
- **Docker single-file mount:** check whether Copilot replaces `open-sessions-state.json` (new inode) or rewrites it in place. If it replaces it, the container's copy goes stale. The source already treats the file as a hint.
