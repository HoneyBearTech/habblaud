# Plan: Copilot premium-request usage

## What Sean asked for

"Copilot usage isn't reporting in Habblaud." He chose: show the premium requests used this month, and draw a bar against a monthly allowance he sets.

## What we found

- The Copilot account's usage card says "Copilot shares no usage limits", and the account reports usage as off. That was the plan in PR #6: we thought Copilot wrote no usage data.
- Copilot does record what it spends. Each `session.usage_record` event in `events.jsonl` has a timestamp, `data.usage.cost` and `data.usage.initiator`. The records started by a prompt (`initiator: "user"`) add up to exactly the session's own `totalPremiumRequests` total (checked on 7 real sessions).
- Copilot's files have no monthly allowance, reset date or "remaining" figure. A bar therefore needs the allowance as a setting.
- Premium requests reset on the 1st of each month (UTC).

## What we'll change

1. **Count premium requests.** The Copilot reader sums `cost` over the `session.usage_record` events with `initiator: "user"`, per account, for the current UTC month and for today.
   - It goes over every session folder in `session-state/`, not just the open ones. Each file's total is cached by size and change time, so a file is read once and then only its new lines.
   - A file that is rewritten or shrinks is read again from the start, so nothing is counted twice.
   - Checked by: tests with made-up sessions across a month boundary, records started by the agent, files that grow, files that are replaced, and broken lines.
2. **Report it as account usage.** The Copilot account's usage goes from "off" to "ok" once there is data. It carries the month's count, today's count, the allowance if one is set, and the reset date (the 1st of next month, UTC).
   - Checked by: account usage tests and the `/api/health` output.
3. **Allowance setting.** `HABBLAUD_COPILOT_PREMIUM_LIMIT` (a whole number, e.g. `300`) is the monthly allowance for every Copilot account. `HABBLAUD_ACCOUNTS` can also give one account its own `premiumLimit`. Anything that isn't a positive whole number is ignored with one warning.
   - `docker:up` passes the setting into the container.
   - Checked by: config and docker-up tests.
4. **Usage card.**
   - With an allowance: a bar ("123 of 300 premium requests"), the percent used and "resets in N days", in the same style as the other cards.
   - Without one: "123 premium requests this month · 4 today", with a one-line hint on how to set an allowance.
   - With no data yet: "No Copilot premium requests this month".
   - All new text goes through `tr()` with pt-BR, es and fr entries.
   - Checked by: client tests (`usage-source.test.ts` and others), and `npm run i18n:check` showing nothing missing.
5. **Docs.** Update the Copilot sections of the four READMEs and `server/README.md`, and add a `CHANGELOG.md` entry under Unreleased.

## Who's on it

An Engineer, QA, a Security Officer and an independent Auditor. Research was done by the team lead while looking at the real data.

## Risks

- `cost` and `initiator` are undocumented fields and could change. The count only uses records that have both fields, and the card says "no data" rather than showing a wrong number.
- The count only covers sessions that still have folders in `session-state/`. Premium requests made from other machines or from the website aren't in these files. The card will say it is "this computer's" usage.
- A plan's real allowance can differ per model or per account. The setting is a plain number Sean sets, so the bar is only as right as that number.

## Out of scope

- Reading Copilot's account or billing data from GitHub.
- A Copilot usage history chart.
- Sending Copilot usage to Habblaud World (Copilot is still left out of World).
