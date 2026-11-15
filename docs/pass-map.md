# Pass map

| Date | Job | What shipped | PR |
|---|---|---|---|
| 2026-11-15 | copilot-source | A read-only GitHub Copilot CLI source (`server/sources/copilot/`) that reads `session-state/<id>/events.jsonl`, `workspace.yaml` and `open-sessions-state.json`. Also a COPILOT tag and account chip, a usage card note, Copilot left out of World, read-only Docker mounts, texts in pt-BR/es/fr, README sections, and a date-independent uplink theme test. | [#6](https://github.com/HoneyBearTech/habblaud/pull/6) |
| 2026-11-15 | copilot-premium-usage | Copilot AI credits used this month and today (UTC). They come from each session's running `totalNanoAiu` on usage checkpoints and shutdown, across every session folder. The usage card shows a bar against `HABBLAUD_COPILOT_CREDIT_LIMIT` (or `creditLimit` per account), a "counting" state while files are first read, and a time-lapse summary that keeps the credits. `docker:up` passes the allowance through. | [#11](https://github.com/HoneyBearTech/habblaud/pull/11) |
