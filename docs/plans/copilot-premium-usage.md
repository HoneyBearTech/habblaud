# Plan: Copilot AI-credit usage

## What Sean asked for

"Copilot usage isn't reporting in Habblaud." Then: "I have Copilot Pro and get 1,500 AI credits every month." He wants the usage card to show how many of those credits are used, with a bar.

## What we found

- The Copilot account's usage card says "Copilot shares no usage limits", and the account reports usage as off. That was the plan in PR #6: we thought Copilot wrote no usage data.
- Copilot bills in **AI credits**. One credit is $0.01, and credits are charged by model and tokens, not per request. Pro gets 1,500 a month (1,000 base plus 500 flex).
- Copilot's session files carry a running AI-unit total for each session. It is `totalNanoAiu` on `session.usage_checkpoint` and on `session.shutdown`, in billionths of a unit, with `accountingSnapshot.aiCreditsStatus: "complete"`.
  - On 8 real sessions it ranged from about 2.9 to 49 units per session, about 140 in all.
  - A checkpoint and its shutdown give the same number.
  - We take one unit as one AI credit. This still has to be checked once against GitHub's billing page.
- Per-prompt "premium request" counts (`cost` with `initiator: "user"`) also exist, but they are 1 per session. They no longer match how Pro is billed, so they are not used.
- Copilot's files have no allowance, reset date or "remaining" figure. A bar therefore needs the allowance as a setting.

## What we'll change

1. **Count AI credits.** For each session, the Copilot reader follows the running `totalNanoAiu` from `session.usage_checkpoint` and `session.shutdown` events.
   - Each rise in the total is counted at that event's time.
   - Credits are the total divided by 1,000,000,000.
   - It sums them per account for the current UTC month and for today.
   - It goes over every session folder in `session-state/`, not just the open ones. Each file's total is cached by size and change time, so a file is read once and then only its new lines.
   - A total that goes down, or a file that is rewritten or shrinks, starts that session's count again without counting anything twice.
   - Checked by: tests with made-up sessions across a month boundary, several checkpoints, a checkpoint and a shutdown with the same total, files that grow, files that are replaced, and broken lines.
2. **Report it as account usage.** The Copilot account's usage goes from "off" to "ok" once there is data. It carries the month's credits, today's credits, the allowance if one is set, and the reset date (the 1st of next month, UTC).
   - Checked by: account usage tests and the `/api/health` output.
3. **Allowance setting.** `HABBLAUD_COPILOT_CREDIT_LIMIT` (a positive number, e.g. `1500` for Pro) sets the monthly allowance for every Copilot account. `HABBLAUD_ACCOUNTS` can also give one account its own `creditLimit`. Anything else is ignored with one warning.
   - `docker:up` passes the setting into the container.
   - Checked by: config and docker-up tests.
4. **Usage card.**
   - With an allowance: a bar ("140 of 1,500 AI credits"), the percent used and "resets in N days", in the same style as the other cards.
   - Without one: "140 AI credits this month · 35 today", with a one-line hint on how to set an allowance.
   - With no data yet: "No Copilot AI credits used this month".
   - The card says this is the usage on this computer.
   - All new text goes through `tr()` with pt-BR, es and fr entries.
   - Checked by: client tests (`usage-source.test.ts` and others), and `npm run i18n:check` showing nothing missing.
5. **Docs.** Update the Copilot sections of the four READMEs and `server/README.md`, and add a `CHANGELOG.md` entry under Unreleased.

## Who's on it

An Engineer, QA, a Security Officer and an independent Auditor. Research was done by the team lead while looking at the real data.

## Risks

- `totalNanoAiu` is an undocumented field and could change. Only events that have it are counted, and the card says "no data" rather than showing a wrong number.
- One unit is taken as one AI credit. If GitHub's billing page shows a different figure, the scale is one constant to change.
- The count only covers sessions that still have folders in `session-state/` on this computer. Credits used on other machines, in the editor or on the website aren't in these files.
- GitHub may reset credits on the billing date rather than on the 1st. The 1st (UTC) is used until we know.
- The flex part of the allowance can change. The setting is a plain number Sean sets.

## Out of scope

- Reading Copilot's account or billing data from GitHub.
- A Copilot usage history chart.
- Sending Copilot usage to Habblaud World (Copilot is still left out of World).
