# Habblaud's Claude Code plugins

The repository is also a Claude Code plugin marketplace: `.claude-plugin/marketplace.json` (at the root)
lists the `habblaud` marketplace with three plugins, one in each folder here: the `habblaud` mod (only observes),
`habblaud-permissoes` (answer permissions from the office) and `habblaud-mensagens` (send messages from the
office). `npm run mod:install` installs all three; `--sem-permissoes` and `--sem-mensagens` leave theirs out.
The versions follow `package.json` (the test `server/test/mod.test.ts` fails if they diverge).

Tested with **Claude Code 2.1.293** (`habblaud-mensagens`, for now only through the `claude plugin test` of
2.1.295). Mods (TypeScript hooks loaded by Claude Code itself) exist from 2.1.287 on; the API is still
"early access" and can change between versions. On earlier versions, use the usual installers
(`npm run usage:install` and `npm run hooks:install`); sending messages from the office only exists with the mod.
Installation is in the main README.

## `habblaud` — the mod

`habblaud/hooks/register.ts`, a single module, no build. It connects each session to the office without reading the
conversation:

- **Plan usage (5h and weekly):** at the start of the session and on every `session.measure` (after each turn and when
  a limit moves one point) it reads `$.session.usage().rateLimits` and writes `~/.habblaud/usage/<account>.json` (or to
  `HABBLAUD_USAGE_DIR`) in the same format as the statusline tap, plus `"source": "mod"`. It replaces
  `npm run usage:install`: your statusline stays untouched. The account is the folder of `CLAUDE_CONFIG_DIR` (the
  first item) or `~/.claude` (`~` is `HOME`; on Windows without it, `USERPROFILE`). Equal values written less than
  10 s ago are not rewritten; a failed write = silence.
- **"Needs you" below the prompt:** every 5 s it asks the local Habblaud
  (`GET http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/summary`) who is waiting, already without this session and
  its subagents, and shows `🏢 Valentina needs you in online-store` or
  `🏢 2 need you: Valentina (online-store), Elias (app-mobile)` (up to 3 names, then "and N more").
  Nobody waiting or Habblaud down: the line disappears; while it is down, the questions go to every 30 s until
  it comes back. Only in sessions that draw (under `claude -p` it asks nothing).
- **`/habblaud`:** summary of the whole office, answered by the mod itself (doesn't call the model, doesn't spend usage):

  ```
  Habblaud 0.3.0 at http://localhost:4747
  7 agents · 3 working · 2 need you
  ✋ Valentina (online-store): approve a permission · you can reply from the office
  ✋ Elias (app-mobile): answer in the terminal
  ```

  Down: `Habblaud did not answer at http://localhost:4747. To start it: npm run docker:up in the Habblaud folder.`

### What it accesses

Output of `claude plugin validate --strict mod/habblaud` (the static analysis that Claude Code does before
loading the module; nothing outside this list is called):

```
❯ ./register.ts hooks: session.start, session.measure, command.run{command=habblaud}
❯ ./register.ts answers its own command: command.run{command=habblaud}
❯ ./register.ts calls: $.clock.after (via askHabblaud), $.clock.every (via schedule), $.clock.now (via writeUsage), $.command.register, $.env.get (via readEnv), $.fs.write (via writeUsage), $.http.fetch (via askHabblaud), $.session.id (via poll), $.session.surfaces (via poll), $.session.usage, $.ui.status (via setStatus)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HABBLAUD_USAGE_DIR, HOME, USERPROFILE
```

In words: it only observes (no hook decides anything: it doesn't approve tools, doesn't change prompts, doesn't read
messages), writes a single file (the usage one), talks only to `127.0.0.1` and reads five environment variables.
`$.clock.after` is the 2 s deadline of each question to Habblaud (`$.http.fetch` doesn't accept AbortSignal).

## `habblaud-permissoes` — answer permissions from the office

A regular `PermissionRequest` hook (no mod), in `habblaud-permissoes/hooks/hooks.json`:

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs\"", "timeout": 86430, "statusMessage": "Waiting for an answer in Habblaud" }] }
```

The script `hooks/permission-hook.mjs` is the same one that `npm run hooks:install` installs (single source; pure Node,
only `node:*`, because Claude Code copies only the plugin folder to the cache). It sends the request to the local
Habblaud and waits for the answer for up to 5 min; the dialog stays in the terminal and whatever you answer first
counts. Without Habblaud up or without any page open, it exits right away. Port: `HABBLAUD_PORT` (default 4747); wait:
`HABBLAUD_PERMISSION_TIMEOUT` (default 300 s, up to 86400 s = 24 h; the hook's timeout in the plugin is 86430 s). To
approve from your phone away from the computer, put `"env": { "HABBLAUD_PERMISSION_TIMEOUT": "86400" }` in the
account's `settings.json`: it applies to sessions opened afterwards. Background subagents only show the dialog when
the hook finishes, so the default stays 5 min. Needs `node` 22+ on the session's `PATH`.

`claude plugin validate --strict mod/habblaud-permissoes`: `✔ Validation passed` (the validator also checks the
schema of `hooks.json`).

## `habblaud-mensagens` — messages from the office

`habblaud-mensagens/hooks/register.ts`, a single module, no build. It brings into the session what you type in the
office (in the agent's panel or in the T key terminal), as if you had typed it in the terminal:

- **Fetch:** every 2 s, only in sessions that draw (under `claude -p` it asks nothing),
  `POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox` with `{session, account}`. The question also marks the
  session as present: that is what shows, on the page, the agent's message box (without the plugin, the page gives the
  hint to install it). When it is down, or answering something else (403 with messages turned off, 404 on a version
  without the route), it switches to asking every 30 s until it comes back.
- **Delivery:** each message, in order, goes through `$.prompt.submit({ text, asUser: true })`. The model reads the
  text as yours, without the "The habblaud-mensagens plugin sent a message" (the session log still says it came from
  the plugin), and the text goes exactly as it was typed. With the session in the middle of a turn, Claude Code holds
  the prompt and runs it in a turn of its own when the current one ends (a plugin prompt never enters in the middle of
  the turn, as a typed one can). A hook that refuses the message (`{drop}`) or an exception become a failure, with the
  reason, on the page.
- **Confirmation:** a `POST /api/mod/inbox/ack` with the result of each one (`{session, results: [{id, ok, error?}]}`).
  The wait per message is at most 2 s: past that, the session is busy, the message is in its queue and
  counts as delivered (the next ones go right after, in order). This way a round never takes more than a few seconds
  and the server's presence (10 s) and confirmation (30 s) don't expire with the session busy; the price is that a
  refusal after those 2 s doesn't reach the page.

It is kept separate from the `habblaud` mod on purpose: that one only observes; this one acts, typing in the session
on your behalf. To go without it: `npm run mod:install -- --sem-mensagens` (one already installed stays; to remove it:
`claude plugin uninstall habblaud-mensagens@habblaud`). `npm run docker:up` updates the plugin for those who already
have it, but doesn't install it on its own: on an account with the mod and without it, it only gives the hint to run
`npm run mod:install`.

### What it accesses

Output of `claude plugin validate --strict mod/habblaud-mensagens`:

```
❯ ./register.ts hooks: session.start
❯ ./register.ts calls: $.clock.after (via waitAtMost), $.clock.every (via schedule), $.env.get (via readEnv), $.http.fetch (via postJson), $.prompt.submit (via submitOne), $.session.id (via round), $.session.surfaces (via round)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CODE_ENTRYPOINT, CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HOME, USERPROFILE
```

In words: a single hook (`session.start`, which starts the clock of the rounds); the only action in the session is the
`$.prompt.submit` of the messages; it doesn't read the conversation, doesn't write any file, talks only to `127.0.0.1`
and reads four environment variables (the account comes from `CLAUDE_CONFIG_DIR`, as in the mod). `$.clock.after` is
the 2 s deadline of each request to Habblaud and of each `$.prompt.submit`.

Port: `HABBLAUD_PORT` (default 4747). Needs Claude Code 2.1.287+ and a Habblaud with messages turned on: the
same lock as the terminal and the permissions (port bound to `127.0.0.1` and local Host header) and `HABBLAUD_MENSAGENS`
not turned off (`0`, `false`, `off` or `no` turn it off). Any process on this machine that talks to Habblaud
can send a message to the sessions with the plugin: hence the local lock.

## Developing

```bash
claude --plugin-dir mod/habblaud                     # loads the mod in a session, without installing (reloads on save)
claude -p "/habblaud" --plugin-dir mod/habblaud      # tests the command without an interactive session (doesn't call the model)
cd mod/habblaud && claude plugin test                # the mod's tests (tests/*.test.ts), no session, login or network
cd mod/habblaud-mensagens && claude plugin test      # same for the messages plugin
claude plugin validate --strict mod/habblaud         # static analysis + manifest (same for the other folders and .)
npx tsc -p mod/habblaud                              # types (after loading the mod once with --plugin-dir)
```

When it loads a mod, Claude Code writes the types of the installed version to `<folder>/.claude-plugin/types/` and a
`<folder>/tsconfig.json` that extends them; both are generated and stay out of git (`mod/.gitignore`). The mods' tests
import `claude-code/testing` and only run through `claude plugin test`: `npm test` (vitest) and
`npm run typecheck` don't look at this folder.
