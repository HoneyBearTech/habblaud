# What's new

What went into each version of Habblaud. Each version has its section here, and its text becomes the notes of the
[GitHub release](https://github.com/marmottajr/habblaud/releases) (`npm run release`), which Habblaud opens in
**Settings › About › See what changed**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the numbers follow [semantic
versioning](https://semver.org/): a fix bumps the last number (0.2.**1**), a new feature bumps the middle one
(0.**3**.0).

## [Unreleased]

## [1.0.3] - 2026-10-16

### Fixed

- **City: “Reply” and “Show in the office” on notices go back to the office and open the agent's request.** With the
  city open, clicking the notice of a request or question (and the browser notification, the requests chip in the bar
  and Deliveries) did nothing visible: the agent was selected behind the city. Now the city closes, the drawer opens
  on the agent and the request card gets the focus.

## [1.0.2] - 2026-10-16

### Fixed

- **City: entering and liking work again after leaving the tab in the background.** After half a minute with Habblaud
  in another tab or window, the character stopped sending its position to Habblaud World: it walked on screen, but
  "Enter" and liking said to get closer to the door.

## [1.0.1] - 2026-10-16

### Fixed

- **City: the keys walk again.** In 1.0.0, with the launch popups and the Habblaud World window on the page, WASD, the
  arrows and the office shortcuts stopped responding even with everything closed: a closed `<dialog>` stays on the
  page and was taken for an open modal. Only open dialogs count now.

## [1.0.0] - 2026-10-16

Why 1.0: the office (rooms, characters, subagents, usage per account, terminal, timelapse, phone with login) has been
stable for several versions, and Habblaud World arrives whole: account, character, building, city, visits and the
light social features. To update: `git pull` and `npm run docker:up`.

### Habblaud World

Habblaud's online city is live: each Habblaud becomes a building, lit up live while the agents work, and each person
walks around the city with a character. **It comes on by default**, pointing at `server.habblaud.com`; **nothing
leaves the computer until you create the account** and sign in, and `HABBLAUD_WORLD=0` turns everything off (it even
hides the routes). Access is granted through a waitlist. What can leave and what never leaves is in
[`docs/world/privacidade.md`](docs/world/privacidade.md); the README has the full **Habblaud World** section, in the
four languages.

- **Configure and test:** without `HABBLAUD_WORLD_URL`, the official server (`https://server.habblaud.com`;
  `npm run docker:up` and the server log say "(default)"); if set, the one set applies (only `https://` or `wss://`;
  if refused, World stays off, with the reason in the log). `HABBLAUD_WORLD=0` turns everything off, and
  `HABBLAUD_WORLD_DEV=1` accepts a local world server without TLS at `http://127.0.0.1:<porta>` (`npm run dev` already
  accepts it) or, from inside Docker, at `http://host.docker.internal:<porta>`. `docker-compose.yml` passes the three
  variables through and maps `host.docker.internal` to the host (`extra_hosts` with `host-gateway`, harmless on
  macOS), and `npm run docker:up` ends by saying whether World is on and for which server. The build writes
  `dist/build.json` with the commit and whether the copy was modified (it goes in the first message of the building's
  connection).
- **Its own window:** Habblaud World has a button of its own in the top bar (the city icon, next to Settings; it only
  shows up with the world server configured) and opens in a modal of its own, outside Settings: the building in
  pixels, the account state in the header and everything that follows in a scrollable body. The "in the world" chip
  next to the version, the launch popups and the "While you were away" notice open the same window, on the right
  screen.
- **Account:** in the Habblaud World window. **Create account** (e-mail and a password of 12 characters or more, the
  summary of what leaves and what never leaves the computer, the line about real data and the required acceptance of
  the Terms of Use and the Privacy Policy; the anti-robot challenge is solved by Habblaud itself) or **I already have
  an account**; 6-digit code with resend; **Forgot password**; **Devices** (up to 3, with revoke) and sign out. On the
  waitlist, only the notice, with no position or estimate, and an open Habblaud checks on its own every 30 minutes
  whether access was granted. All of it only from the computer itself: never through the phone port, and what acts for
  the account only with local access (the terminal lock). The device token stays in `~/.habblaud/world.json`
  (permission 600; in Docker, in the `/data` volume) and never goes to the browser, the snapshot, the logs or the URL.
- **Player name chosen at sign-up (it stays reserved on the waitlist):** sign-up asks for the player name (3 to 20
  characters, unique in the world) along with the e-mail and the password, checked on the spot and, if it is already
  in use, with the notice on the field itself. It stays reserved for the account while it waits on the list (the
  waiting screen shows "Your player name: X (reserved)") and becomes the character's name, which is born with it
  without asking for the name again (it can be changed later, once every 30 days); old accounts, with no reservation,
  keep choosing the name when creating the character. `docs/world/privacidade.md` now says that the world server
  keeps, besides the country, the IP of the sign-up and of the last password login, for auditing (only the
  administration sees them; deleted with the account; included in "Download my data"), and no other.
- **Launch popups:** three notices in a modal window, on top of the office (and of Settings). **New: Habblaud World**,
  for those who don't have an account yet, with the **Create account** button: "Not now" brings it back in 3 days (at
  most 3 times), "Don't show again" ends it and, with the account created, it doesn't come back. **You're on the
  waitlist**, right after sign-up (or when opening the page already on the waitlist), once per browser. **Access
  granted!**, when your turn comes and the character doesn't exist yet, with **Create character** taking you straight
  to its screen. None of them shows up through the phone port, in the timelapse or in demo mode.
- **Character:** player name, visual hint, the same appearance editor as the agent's drawer, 2 or 3 personality traits
  (the ones that don't go together are disabled) and an intro phrase from the list; you can create it while still on
  the waitlist. If moderation changes the name, the section asks for a new name, which applies without waiting the 30
  days.
- **Building visibility:** live or discreet, closed to visitors, hide the country, tokens (only in ranges),
  leaderboard, compactions and **Let me know when someone knocks** (off by default).
- **Account and data** (new screen of the Habblaud World window): the switch **E-mail me before my building is removed
  for inactivity**; **Download my data**, which saves `habblaud-world-dados.json` with what the world keeps about the
  account (once a day); and **Delete account** in three steps: what goes away and when (the building and the profile
  right away; the account, the likes, the blocks, the reports made and the devices from the database in 7 days; from
  the backups, within 30), the confirmation, which sends a code to the e-mail, and the code. With the account deleted
  (from here or from another computer), the building's connection closes and `world.json` disappears from this
  computer; the section says that the account was deleted.
- **Your building in the world:** with access granted and the character created, the **Your building** card shows
  whether the building is connected, reconnecting, paused or out of the world (or whether the character is still
  missing), how many floors and agents it has, when the last upload went out and, if the world refuses an upload, the
  reason. When the world server stops the building, the card says why: **Update Habblaud** (old version), **Connected
  on another computer** (with **Bring it to this computer**), account suspended or banned (with **Appeal by e-mail**,
  which opens an e-mail to privacidade@habblaud.com with the account id in the subject) or account deleted. A building
  marked as **unverified** shows the badge and **Dispute by e-mail**, and the world under maintenance shows up as
  **Under maintenance** (Habblaud tries again on its own, with a wait). **Pause** stops the sending right away and
  turns the building off, keeping the lot; **Resume** lights it up again. **Leave the world** (in two clicks, with the
  difference from pausing next to it) removes the building right away and frees the lot; the account and the character
  stay, and **Back to the world** creates a new building, on another lot (leaving on another computer also counts
  here). **See what was sent** opens the exact JSON of the last upload, with the time, the size in bytes, the world's
  reply (with the bytes it counted) and a button to copy: it is everything that left the computer. The theme chosen in
  **Appearance › Office theme** also applies to the building (and the theme saved for the building applies to the
  office), and the top bar gets the "🏙️ in the world" / "⏸ paused" / "⚠️ stopped" badge, which opens the section (it
  disappears in the narrow bar and on the phone).
- **The building goes up to the world:** with the account approved and the character created, Habblaud opens a
  connection (WebSocket) to the world server and sends the building live: one floor per room with someone present and,
  per agent, only a random id, main or subagent, the tool, the status, a randomly picked name and the appearance; plus
  the theme, the tasks completed in the day as a range, the building's tokens rounded (can be turned off) and, if you
  turn it on, the compactions. The ids of the floors and of the agents are random and change every 24 h (±6 h); paths,
  room names, titles, activities, model, branch, account and edited names never leave. It sends on change (at most
  once every 5 s), reconnects on its own with a growing wait (2 s to 60 s, also during the world's maintenance) and
  stops when the server asks (account suspended, banned or deleted, old version, connected somewhere else). Demo mode
  agents never go up. The tasks and the compactions are also counted with the building paused or without a connection,
  and go in the next upload.
- **The city (World button):** with the scene available (`meta.world.scene.available`), the **World** button next to
  Timelapse swaps the office for the Habblaud World city, in 3/4 pixel art in the same style: blocks of 6 lots with
  sidewalk, curb, lampposts, trees, crosswalks and the central square with the fountain, the benches and the totem;
  empty lots become gardens (park, pond, orchard, café). Each building has the height of the open projects (up to 12
  floors drawn, with a "+N" sign above that), windows lit in proportion to the agents working and, blinking in amber,
  those of whoever is waiting, the owner's theme (pumpkins, webs and bats on Halloween; snow, lights, garland and tree
  at Christmas), everything off with the "Closed" sign when the building is out, color and finish from the lot's seed
  and the sign with the flag, the owner's name and the ❤️ likes. The bottom row of each block shows the facade with
  the shop window and the door; the top one, with the door facing north, shows the roof with the entrance canopy and
  the back. At night the lampposts and the windows light up. You walk with arrows/WASD (Shift runs) or by clicking
  (the office's A*); the camera follows, with the usual zoom and zooming out until you see some 200 buildings; near a
  door **Enter (E)** shows up (see "Visit a building", below). Hovering over a building opens the card (owner,
  country, state, floors up to "24+", agents working, waiting and idle or "discreet mode", likes, "in the world
  since"); clicking a player opens the profile (character, country, traits, phrase, building and likes received). The
  other players walk smoothly, a little behind, at the pace the positions arrive (5 per second for the 20 closest, 2.5
  for the others), with the name on top; whoever stops on a bench shows up sitting (you too), and when you are away
  your character stays still where it is. The minimap in the corner shows the blocks around, brighter the more
  buildings are on, and takes the camera to where you click. Esc or **Office** go back, and reopening the city returns
  exactly to where you were (the character, the camera and the zoom, without flickering); Settings stays open in the
  city, and the office stops drawing meanwhile. The scene is loaded only when it opens. **Paused or out of the world,
  your building stays off, but you can walk around the city**: with the scene open, the connection carries only the
  first message, the heartbeat and the scene's commands, never the building's packet, and closes together with the
  scene. Account banned, suspended or deleted (or the building stopped because of an old version or another computer):
  the World button disappears; it also only shows up on the page of the computer itself (never through the phone port
  or without local-only access).
- **The city through the local server:** with the scene open, Habblaud asks the world server for the piece of the city
  around your character (`view`) over the same connection as the building and passes it on to the browser through
  `GET /api/world/stream` (SSE: the whole state on open, then each change in order); with the scene closed, it says so
  (`view.off`) and nothing more comes down. Buildings by chunk with a revision (a jump asks for the area again),
  players nearby, minimap and your position stay only in memory. The character's commands (`POST /api/world/cmd`:
  walk, profile, enter and leave a building and the light social ones) are checked field by field, at most 5 batches
  per second and only the last step of each batch; at most 4 tabs with the city. Only from the computer itself and
  only from its own page (never from another site). The city's geometry (lots, blocks, doors, chunks and what is
  walkable) is in `shared/world/city.ts`, the same as the world server's. Your character enters the street at the
  position the world server validated (on the sidewalk at your door or in the square).
- **Visit a building:** within 2 tiles of a building's door, **Enter (E)** takes you inside: the owner's office as
  they see their own, with their theme, the rooms with the made-up names of the day ("Project Ipê", "Project Jade"...)
  and the agents in their current status (typing, with a hand raised, watching the terminal or idle, with the social
  life simulated in your browser), changing right away with each packet from the owner. You come in through the
  elevator with your character and the **visitor** badge and walk with the keyboard or by clicking (without sitting at
  the desks). The top banner says whose building it is, how many floors and agents and whether it is in discreet mode
  (empty rooms, with the lights on) or off (paused: all dark); the panel on the side lists the rooms and the agents
  (name, role, tool and status; clicking opens a card with that and nothing else). Nothing that comes from the world
  has a time, so in there there is no popcorn, cobweb, stopwatch or "waiting for X". **Leave** by the button, by Esc
  or by the reception elevator goes back to the sidewalk in front of the door. In the panel, **Like** (with the total;
  from inside, without the distance from the door) and **Leave a stamp** (one of the 8 front desk stamps, one per
  building per day); the cork board in the reception shows the stamp you left today and, in your own building, the
  ones from "While you were away". A building closed to visitors, full (20 visitors), blocked or too far away gives a
  notice on screen. Nothing that acts on the office exists in the visit (no terminal, drawer, feed, notices,
  permission requests, messages, My day, timelapse, editor or room renaming): it runs in a separate world, which only
  talks to `/api/world/*`, and no step of yours in there leaves the computer. The little coins from the social life of
  the visited agents stay in a separate key and disappear on leaving. **See it as others do** (on the **Your
  building** card and at your building's door) enters your own building. **For the owner:** the top badge gets "👀 N"
  and the **Your building** card, "N visitors now" (only the count, never who); the first visitor of each connection
  gives the notice "Someone entered your building", which can be turned off in **Habblaud World › Notify me when
  someone visits**. Through the local server, the scene's stream passes on the interior (`building`, `building.patch`
  with the revision checked and `resync {building}` on a jump) and the visitors (`visitors`, also in
  `meta.world.building.visitors`).
- **The light social features, with no free text at all:** in the city, **L** (or the ❤️ button that shows up near the
  door, up to 4 steps) likes a building, and the heart flies to the sign, whose counter jumps; **G** opens the wheel
  with the 10 greetings (keys 1–9 and 0, arrows or touch), for whoever just greeted you, whoever is on the card or
  whoever is closest, with 5 s speech bubbles over the heads (one doesn't cover another) and "G to reply" when someone
  greets you; **K** knocks on the door of those who accept it (up to 2 steps). The player's card gets **Greet**,
  **Block** (in two clicks: you stop seeing each other) and **Report** (fixed reasons, "Report sent"); the building's,
  **Like**, **Knock**, the building's code and the "unverified" badge. On the minimap, **Go to HB-XXXX** and **Visit a
  random building**, with a fade while the character goes to the sidewalk at the door. In the square, the thermometer
  of the week's collective goal ("10 thousand hours of agents working") and the city hall sign (the lit buildings and
  "the city used ≈ X this week", only with 10 buildings or more); with the goal hit, 20 s of fireworks (sometimes
  heart-shaped) and, for everyone, bunting with little light bulbs and the season's decoration. On the facades, the
  day's token meter next to the door, the signboard with 5 intensities by the week's range (from off to neon with
  sparks) and confetti when a building finishes the turn. On the phone, the buttons stay in the corner, with the icons
  only. **In the office:** the bar chip gets "❤️ N today"; on connecting, the **While you were away** card (visits,
  likes and the stamps left at the front desk, without who) shows up in the corner and also in **Your building**, with
  the building's code to send to a friend; **Let me know when someone knocks** (Visibility, off by default) shows
  "Someone knocked on your building's door"; **Habblaud World › Blocked** lists who you blocked, with **Unblock**.
  **Through the local server:** `POST /api/world/summary/seen` and `/api/world/unblock`, and the commands `like`,
  `unlike`, `greet`, `block`, `unblock`, `report`, `stamp`, `teleport`, `knock` and `summary.seen` in the scene,
  checked field by field.
- **Local routes** (`/api/world/*`, only from the computer itself): the account (sign-up, code, sign in, sign out,
  resend, change the password, character, visibility with the optional inactivity notice, devices); the building
  (`POST /api/world/pause` and `/resume`, which stop the sending before replying; `/leave`, which only replies after
  the world server removes the building; `/join`, which asks to come back before reconnecting; `PUT /api/world/theme`,
  with automatic becoming the theme of the day; `GET /api/world/last-uplink`, the last upload kept in
  `~/.habblaud/world-last-uplink.json`, permission 600); and the account and the data
  (`POST /api/world/delete-account` and `/delete-account/confirm`, which only replies after closing the building and
  deleting `world.json`; `GET /api/world/export`, the account's JSON as an attachment, only from its own page). A
  resume that the world server did not confirm tries again with the reconnection wait. The World status and the
  snapshot (`meta.world.building`) carry the building's summary: connected, paused, out of the world, stopped, floors,
  agents and the last upload.
- **Open protocol and transparency:** `shared/world/protocol.ts` and `schema.json` define everything Habblaud
  exchanges with World (Phase 4 adds the door notices, the owner's visitors and the building's `resync`; Phase 5, the
  names of the light social features: stamps, city goals, the day's likes, the "while you were away" summary, knocking
  on the door and the building's code; Phase 6, the `goodbye` `deleted`, the `maintenance` error, the packet's
  `implausible` refusal, the visibility's `notifyInactivity`, the building's `unverified` badge and the formats of the
  deletion and of the export); the player name rules, the 14 traits, the 20 intro phrases, the 10 greetings and the 60
  made-up floor names ("Project Ipê", "Project Jade"...) are in `shared/world/`. `docs/world/privacidade.md` lists
  each field of the packet and of the connection, with a test that checks the page against `schema.json`; the
  projection tests check each key and that no text from the office shows up in the packet. The notice about real data,
  for people and AI agents, is in `CLAUDE.md`, in `AGENTS.md`, in `shared/world/README.md` and in the World files, and
  `CONTRIBUTING.md` has the review rule for PRs that touch it.
- **Demo mode:** `?mock=1&world=logged_out` (or `waiting`, `approved`) simulates the server (the code is 123456), with
  the example building and upload from `docs/world/privacidade.md`; `?mock=1&world=approved&scene=city` opens a
  make-believe city (20 buildings, yours on lot (3,1), 5 people walking and one sitting on a bench in the square;
  `&perf=N` fills N lots), with buildings to visit (live, discreet and off) and the light social features (bots that
  greet each other and reply, the goal at 80% and, with `&fireworks=1`, a test button for the fireworks).
  `npm run shots:world` redoes the screenshots `docs/screenshots/world-predio.png`, `world-enviado.png`,
  `world-cidade.png`, `world-cartao.png`, `world-visita.png`, `world-visita-painel.png`, `world-social.png` and
  `world-praca.png`.

## [0.11.0] - 2026-10-13

To update: `git pull` and `npm run docker:up` (it also updates the Habblaud mod in the accounts). Phone access is
optional and stays off until you run `npm run remote:setup`; the step-by-step is in the README, under
"Phone with login and HTTPS". New agent needs `HABBLAUD_PTY=1` in the `.env`.

### Added

- **Phone with login and HTTPS (optional, off until set up):** `npm run remote:setup` asks for a username, a password
  (stored only as a scrypt hash in the `.env`), a name for the address (`https://<nome>.local`) and, if you want, an
  address of your own (e.g. `meuclaude.home`). It creates a local CA and the server certificate and leaves the
  announcement of `<nome>.local` running as a service. The phone comes in on a **second port** (443 if it is free,
  otherwise 4748), which is only published after the setup: every request on it requires login, and by default the
  phone **approves and denies permission requests**; messages, the terminal (with the **Deliveries**: what each agent
  finished, with a summary and attachments) and New agent only with `HABBLAUD_REMOTE_ALLOW`. Port 4747 stays on the
  computer only and without login. **Settings › Phone access › Sign out** ends the login on that device (a copy of
  the cookie also stops working). Contribution by @jasminaladdn (#96).
- **New agent (+ button in the top bar, opt-in with `HABBLAUD_PTY=1`):** starts a Claude Code session in the
  background on the computer (`claude --bg`), in the chosen folder (recent projects come suggested), with the written
  request and attachments; it shows up in the office and receives messages and permissions through Habblaud. In a
  folder that Claude Code doesn't know yet, it opens the Claude app's new session screen filled in. In Docker, the
  host helper is the one that starts it (`npm run codex:bridge`, which now also runs without Codex). From the phone,
  it also needs `spawn` in `HABBLAUD_REMOTE_ALLOW`.
- **Dictation** in New agent and in the message box: the browser records and the **local Whisper** transcribes
  (`whisper-cli` + `ffmpeg` + a multilingual model); the voice doesn't leave the computer. Without them, the button
  doesn't appear.
- **Wait of up to 24 h for the office:** `HABBLAUD_PERMISSION_TIMEOUT` accepts up to 86400 s (before, 1800, and the
  plugin cut it off at 330 s). The default is still 5 min. On a long wait, with no page that answers for 5 min (and
  without the phone with login set up to answer), the request goes back to the terminal.
- **Messages to sessions of the Claude desktop app:** the `habblaud-mensagens` plugin also asks Habblaud in
  sessions with `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (before, only in those that had a terminal on screen).
- Request waiting with no buttons in the office (the hook already handed it back to the terminal, or the session
  opened without the plugin): the terminal footer says to answer in Claude Code (or in Codex).

### Security

- On the remote port, what separates "from the computer itself" from "from the network" is the port the connection
  arrived on, never the Host header. The routes of the hooks, the plugins and the host helper, the interactive
  terminal, the character editor and renaming rooms never work through it, not even with login.
- The local CA only signs `localhost`, `.local` names, the address of your own and private network IPs (critical
  `nameConstraints`): even with the key leaked, a certificate for another site is refused. The key never goes to the
  container.
- Session in an `HttpOnly`, `SameSite=Strict` and `Secure` cookie, signed with HMAC (changing the password drops them
  all). One password check at a time, counted before the scrypt; after 5 wrong passwords in a row, each attempt waits
  from 1 s to 5 min.
- In Docker, the host helper only reads delivery files from known project folders (the ones Claude Code has in
  `<account>/projects`), from the temporary folder and from the attachments, and nothing that looks like a secret. Files
  and dictation use rounds with a wait (the server only answers when work arrives), instead of asking every half second.

### Fixed

- Phone: tapping a text field no longer zooms (iPhone Safari enlarges fields with text smaller than 16 px).
- In the timelapse, the corner notices stay above the playback bar, instead of covering the timeline and the buttons.
- With many accounts or a narrow window, the usage cards go to a second line of the top bar, instead of
  covering the buttons on the right (zoom, My day, Settings, Help).
- On the phone (up to 480 px), the top bar no longer cuts off the logo and the sidebar button: the
  counters move down to the line of the usage cards.
- "My day" on the phone: the Demo | Real data selector no longer goes off the screen (in French, not even at 390 px).
- Two permission requests from the same agent at the same instant: the detail of the newer one no longer says there
  is another request waiting behind it.
- "My day": the limit of 1,000 waits per day also applies when all of them are open (before, the list and the day's
  file grew without a cap).
- A conversation file rewritten in place (instead of only growing) is read from the start again; before, the
  new content was ignored or read from the middle.

## [0.10.0] - 2026-10-13

To update: `git pull` and `npm run docker:up`. The interface follows the browser's language (or Settings › Language).
The texts the server builds stay in Portuguese; for another language, set `HABBLAUD_LANG` (`en`, `es` or `fr`)
in the `.env` before `docker:up`. In October, the automatic theme already puts the office in the Halloween mood; for
the usual look, choose **None** in Settings › Appearance.

### Added

- **Office themes** in Settings › Appearance: pixel-art decoration (trees with presents, wreaths and snow on the
  windows at Christmas; pumpkins, ghosts, webs and bats at Halloween), lights, rugs and accessories on the
  characters. **Automatic**, the default, follows the calendar: Halloween from October 1 to 31 and Christmas from
  November 1 to December 26 (the rest of the year, the usual look). **None** keeps the usual look all year, and
  **Christmas** and **Halloween** pin a theme. The choice is saved in the browser.
- **Interface in English, Spanish and French.** The texts go through `tr()` (`shared/i18n.ts`), with Portuguese as
  the source language: a text with no translation stays in PT. The interface follows the browser and can be pinned in
  **Settings › Language**. The texts built by the server (activities, notices, terminal, logs and install
  scripts) follow `HABBLAUD_LANG` (`pt-BR`, `en`, `es` or `fr`) and, without it, the system language, except English
  (many machines and every container come in English by default): for the server in English, `HABBLAUD_LANG=en`.
  `npm run i18n:check` lists the texts still without translation. The French came from the community (#67).
- **README in English**, with versions in Portuguese (`README.pt-BR.md`), Spanish and French, and the language line
  at the top of each one.

## [0.9.0] - 2026-10-13

To update: `git pull` and `npm run docker:up`. The interactive terminal comes turned off and only works outside Docker:
`npm install`, `npm run build` and `HABBLAUD_PTY=1 npm start` (first read the warning under "Privacy and security" in
the README).

### Added

- **Interactive terminal (opt-in, `HABBLAUD_PTY=1`):** the real Claude Code in an office window, with tabs for
  the agents of the same project. **New session** opens a Claude Code in the room's folder; **Take over here** ends the
  session open in another terminal and continues the same conversation here (`claude --resume`); **End** and the X on
  the tabs close the session, here or in another terminal. Only for Claude Code sessions (neither Codex nor demo).
  Before ending an outside process, Habblaud checks that the PID is still that Claude Code. It uses `node-pty` and
  `@xterm/headless` (optional dependencies); the screen comes back whole on reconnecting or switching tabs, with the
  modes Claude turned on. On startup, it opens a test terminal: if `node-pty` or `claude` don't work, the feature
  stays off, with the reason in the log (on macOS, it first fixes the missing execute permission on the
  `spawn-helper` of `node-pty` 1.1.0).
- **Terminal tabs and shortcut:** the terminal window got tabs with the main agents of the same project (with the
  start of what each one is doing), and the side list, a shortcut next to each agent that opens its terminal. With a
  terminal open, clicking another agent in the list switches the window to that agent's. They also apply to the live
  terminal, with the interactive one turned off.

### Fixed

- A message sent from the office no longer goes to the wrong conversation: if the agent switches conversations
  (`/clear`, `/resume` or another thread in Codex) before fetching it, it fails with the reason instead of entering
  the new conversation.
- The old tasks and their states are preserved when recovering sessions with a long history that got new tasks.
- The activity detail no longer shows the secret of webhooks (Slack, Discord and Telegram) or of `npm_` and
  `hf_` tokens pasted into a command.
- Messages to Codex in Docker are now delivered one at a time per session and confirmed individually, reducing
  premature failures and duplicate resends.
- Malformed task lists from Claude Code don't interrupt the reading; the office preserves the other activities
  of the same batch, including in the subagents.
- A Codex image saved on Windows (drive `C:` or network folder `\\servidor\...`) appeared with the wrong path
  in the activity and in the terminal (`/C:/...`, or the folder without the server). Now the path is the source file's.
- Saving a character or going back to random no longer closes another edit that is open while the response arrives,
  nor shows in it an error from the previous edit.
- A huge line in a conversation, or a line that never closed, stayed whole in memory and the reading
  kept getting slower. A line over 8 MB is now ignored, and Habblaud goes on at the next line.
- Reverted Codex sessions now show the current turn in the office and in the terminal, even when the previous
  conversation's file is still on disk.
- In the timelapse, the agent's timeline stops showing what happened after the replayed moment when you go
  back in time. A history response that was still on its way also doesn't come in during the replay.
- In the timelapse, the times in the panels follow the playback and stand still when paused, along with the office
  and the replay badge.
- The paused feed keeps only the 50 most recent events and frees the data of old sessions, keeping the count of
  new items.
- In the timelapse, the arrows on the speed control now change the speed, instead of moving the office camera.
- The office avoids duplicate live connections and frees the network and font resources when it is closed.
- `usage:install`, `hooks:install`, `mod:install` and `codex:install` stop when the configuration file changes
  in the middle of the install, instead of erasing that edit (it also disappeared from the backup). Run the command
  again; the backup becomes the file that was replaced.

## [0.8.0] - 2026-10-09

To update: `git pull` and `npm run docker:up`. Renaming rooms and editing the character work only from the computer
itself (the same lock as the terminal). The room names are kept in `rooms.json` and the characters in `names.json`,
in Habblaud's data folder; going back to 0.7 makes the chosen characters disappear on the first write.

### Added

- The side list and the character's tooltip show the session title (for subagents, the task) below the name. In
  the list, a main agent that has been stopped for 1 minute or more shows **idle 12 min** in place of "Main"; in the
  tooltip, the state comes with how long it has been that way (**12 min ago**).
- **Movable windows:** the terminal and the agent's drawer come loose when dragged by the bar, change size from
  any edge or corner and go back into place with a double-click on the bar. The terminal gets the **Expand to full
  screen** button. Position and size are kept in the browser; on a narrow screen everything stays fixed. Loose, the
  drawer stops reserving the side of the office.
- **Reorder the side list:** dragging a main agent's row changes the order of the agents in the room, and dragging
  a room's header changes the order of the rooms (in the building they stay where they are). The order is kept in
  the browser; the agents' order goes by the Claude Code session and survives resuming the session.
- **Rename room:** right-clicking a room (in the side list or in the office) opens a field to give it another name;
  empty goes back to the folder's name. The name is kept on the server (`rooms.json`, in Habblaud's data folder), per
  folder: it applies in any browser and survives restarts. In the room's drawer, a pencil next to the name opens the
  same field. Only from the computer itself; the demo rooms don't change.
- **Edit a project's character.** In the main agent's details, the pencil next to the name opens an editor
  with the name, **Randomize** and the pieces (skin, hair, beard, eyes, clothes, shoes and accessory), with a preview.
  The choice applies to the project: the next session in the same room arrives with the same character, and **Back to
  random** undoes it. It only works from the computer itself, like the terminal.

### Changed

- The agent's timeline shows the 15 most recent items, with **Show more** (15 more on each click, up to
  the 200 kept) and **Show less** (back to 15). Before, it was 80 at once.

### Fixed

- On Windows, messages to Codex looked for `codex` in the PATH and found the script that npm installs next to the
  executable: Habblaud said the messages were on, but each delivery failed, because the script doesn't run
  without a shell. Now the search is for `codex.exe`. With Codex installed only through npm, point
  `HABBLAUD_CODEX_BIN` to a `codex.exe`.
- On Windows, the statusline command that already existed before `npm run usage:install` (Habblaud keeps it and
  goes on running it) was run by `cmd.exe`, and what worked in Claude Code (single quotes, variables, pipes)
  broke. Now it runs in Git Bash, as in Claude Code: the one from `CLAUDE_CODE_GIT_BASH_PATH` or the one from the Git
  install. Without Git Bash, it stays on `cmd.exe`.
- On Windows, the installers (`usage:install`, `hooks:install`, `codex:install` and `mod:install`) showed the
  paths of the user folder in full (`C:\Users\...`) instead of `~/...`.
- The test suite (`npm test`) passes on Windows: the tests that assumed Linux and macOS paths, shell or permissions
  now hold on all three systems, and the few that depend on something Windows doesn't have are skipped on it.

## [0.7.0] - 2026-10-09

To update: `git pull` and `npm run docker:up` (Codex shows up by itself, if there is a `~/.codex` folder). To see
Codex live and approve from the office: `npm run codex:install` and approve Habblaud's hooks in `/hooks` in Codex
(restart Codex first, if it was open). With Habblaud in Docker, to send messages to Codex keep
`npm run codex:bridge` running on the Mac.

### Added

- **Codex in the office.** OpenAI's Codex sessions (the `codex` CLI and the app) come into the office like Claude
  Code's: each project is a room (the same one as Claude Code's, when both are in the same project), each session a
  character with the **CODEX** badge, with activity, subagents, terminal, history, 5-hour and weekly usage (with the
  age of the numbers and "no quota" when the credits run out) and My day (tokens only: Codex doesn't report cost).
  With nothing to install, Habblaud reads Codex's files (`~/.codex`, `CODEX_HOME` or `~/.codex*`; `HABBLAUD_CODEX_DIRS`
  chooses the folders and `HABBLAUD_CODEX=0` turns it off). A session comes in with the first message, which is when
  Codex says the project folder (an open CLI with no conversation yet doesn't appear). In Docker, only `sessions/`,
  `archived_sessions/` and `thread-writer-locks/` are mounted, read-only.
- **Codex live and approving from the office:** `npm run codex:install` adds Habblaud's hooks to
  `~/.codex/hooks.json` (with a backup; the hooks of other apps stay in the same place) and, after you approve them in
  `/hooks` in Codex, the activity is what is happening now (and not only when each step ends) and the approval
  requests wait for your answer in the office for up to 25 s (`-- --espera <s>`) before going to the terminal.
  `codex:status` checks and `codex:uninstall` removes them.
- **Messages to Codex** through the same **Send message** box, via `codex queue` (they come in when the session
  finishes what it is doing). In Docker, keep `npm run codex:bridge` running on the Mac.

### Changed

- A Codex folder never becomes a Claude Code account, not even when listed in `HABBLAUD_CLAUDE_DIRS` or
  `CLAUDE_CONFIG_DIR`; the server and `docker:up` warn about it.
- With four accounts or more, the usage cards at the top get narrower and the zoom buttons disappear up to 1700 px
  of width, so they don't run into the buttons on the right.

## [0.6.0] - 2026-10-09

To update: `git pull`, `npm run docker:up` and `npm run mod:install` (it brings the new permissions plugin and the
messages one); in the sessions already open, `/reload-plugins`.

### Added

- **Answer the agent's questions from the office.** When the agent asks a question (`AskUserQuestion`), the questions
  card shows each one with the options and the descriptions: choose one (or several, when the question allows it),
  write your own in "Other" or deny. As with permissions, the dialog stays in the terminal and what you answer
  first is what counts; the `P` key and the "need you" counter also lead to the questions. It needs the
  `habblaud-permissoes` plugin of this version.
- **Send messages to the agents from the office.** The details of each main agent get the "Send
  message" section: the text enters the session as if you had typed it in its terminal (with the agent busy, it enters
  when it finishes the turn), and the box shows whether the message is in the queue, was delivered or not. It comes
  from a new plugin, `habblaud-mensagens` (Claude Code 2.1.287+), installed by `npm run mod:install`
  (`-- --sem-mensagens` leaves it out); `npm run docker:up` doesn't install it by itself, it only warns. It follows the
  terminal's lock (local access only) and `HABBLAUD_MENSAGENS=0` turns it off. Read the warning under "Privacy and
  security" in the README: any program on this machine can send a message to the sessions that have the plugin.

### Changed

- **The terminal (`T` key) accepts typing.** It is no longer "read-only": for the main agents, the footer
  became the message box (`Enter` sends, `Shift+Enter` breaks the line). Subagents and history sessions are still
  only for reading.
- `npm run mod:install`, `mod:status` and `mod:uninstall` also take care of the `habblaud-mensagens` plugin, and
  `mod:status` says whether Habblaud has messages turned on.

## [0.5.0] - 2026-10-09

### Added

- The "Needs you" card shows the `AskUserQuestion` questions in full, with the options and the descriptions
  (up to 4 questions, with 6 options each). It is only for reading: the answer is still given in Claude Code.
- Automatic check on GitHub (Actions): on each push to `main` and on each pull request, the project runs
  `typecheck`, tests and build on Node 22.12, the minimum version that `package.json` declares.

### Fixed

- When a transcript file was deleted and another, larger one was created in its place, Habblaud could miss the
  swap: some file systems reuse the number (inode) of the deleted file, and only the inode was compared.
  Now the file's creation time (when the system reports it) and its beginning also count, and the reading
  restarts from the beginning of the new file.
- On Windows, with Node 23 through 24.19, the hook of the `habblaud-permissoes` plugin crashed on exit (code
  0xC0000409, a Node bug: nodejs/node#56645) right after receiving the office's answer. The decision arrived before
  the crash, but with no decision (as in "Answer in terminal") the session could record a hook error. Now the hook
  exits without crashing.
- `npm install` changed `package-lock.json` (the repository's was out of date relative to
  `package.json`), and because of that the next version's `git pull` stopped with "Your local changes … would be
  overwritten". Now the file stays the same. Whoever already has the change runs `git checkout -- package-lock.json`
  once before `git pull`.
- On Windows, the mod didn't record the 5-hour and weekly usage when `HOME` wasn't set (the normal case outside Git
  Bash): now it uses `USERPROFILE`. And a `CLAUDE_CONFIG_DIR` with `\` (e.g. `C:\Users\voce\.claude-conta2`) became an
  invalid file name; now it gives the same account, including with Habblaud in Docker.

## [0.4.0] - 2026-10-08

### Changed

- **CodeTown is now called Habblaud.** The name changes everywhere: interface, logo, reception sign, entrance
  totem, link preview, repository (`github.com/marmottajr/habblaud`), marketplace and Claude Code plugins
  (`habblaud` and `habblaud-permissoes`, with the `/habblaud` command), environment variables (`HABBLAUD_*`), state
  folder (`~/.habblaud`) and Docker (container and image `habblaud`, volume `habblaud-data`).
- For those coming from CodeTown: run `npm run mod:install` once (it swaps the old marketplace and plugins for the new
  ones in each account) and `npm run docker:up` (it removes the old container and copies the names, the timeline and
  the statistics from the `codetown_codetown-data` volume to the new one, without deleting the old one). The
  `~/.codetown` folder and the preferences and coins kept in the browser move to the new names by themselves. The
  `CODETOWN_*` variables no longer work: rename them to `HABBLAUD_*` in the `.env` (the server and `docker:up` warn
  about it). Details in the README, under "Coming from CodeTown".

## [0.3.2] - 2026-10-08

### Fixed

- When a terminal closed and its room was taken down, a garden was left in the middle of the building, between rooms.
  Now the farthest room moves to the empty spot: it is set up there, still dark; the first one to arrive turns on the
  light and each one goes back to the same desk. The old address goes dark and is taken down, and the building
  shrinks. A room that opens takes the first free spot, and the initial load already comes without holes.
- Whoever was on the way to something that no longer exists, like the water cooler of a hallway column that went away
  when the building shrank, was teleported. Now they change plans and keep walking.

## [0.3.1] - 2026-10-08

### Fixed

- Whoever was dozing at the desk (idle for more than 10 minutes) and got up for a hangout, a party or a walk went off
  walking with the "zzz" overhead. Now the "zzz" only appears while the character sleeps.

## [0.3.0] - 2026-10-08

### Added

- **Habblaud mod for Claude Code** (2.1.287 or newer): `npm run mod:install` installs, in each account, the
  marketplace of this folder with the `habblaud` mod (live 5-hour and weekly usage, a line in the terminal when
  another session needs you and the `/habblaud` command) and the `habblaud-permissoes` plugin (answering permissions
  from the office; `-- --sem-permissoes` leaves it out). `npm run mod:status` shows what each account has and
  `npm run mod:uninstall` removes everything. `npm run docker:up` updates the mod for those who already installed it.

### Changed

- The statusline tap (`npm run usage:install`) and the permission hook (`npm run hooks:install`) become the old way,
  for Claude Code before 2.1.287. `npm run mod:install` removes both from the account (with a backup), because the mod
  does the same. The interface and the README now teach `npm run mod:install`.
- The permission hook script moved to `mod/habblaud-permissoes/hooks/permission-hook.mjs`. The old path
  (`scripts/permission-hook.mjs`) became a shortcut, so whoever installed the hook before keeps working.
- In Accounts and usage, the source of the numbers says when they come from the mod ("live (Habblaud mod)").
- The live usage reader ignores a half-read file and keeps the last good number, instead of hiding the
  account for a cycle.

## [0.2.0] - 2026-10-08

First published version.

### Added

- **Version and updates:** the version in use appears in the top bar and in Settings › About. Every 6 hours
  Habblaud checks the releases on GitHub; when a new version comes out, the **New version** badge appears, with a
  notice and the link to what changed. `HABBLAUD_UPDATE_CHECK=0` turns the check off.
- **My day** (M key): where the agents' time went, how long they waited for you, tokens and cost, with 30 days
  of history.
- **GitHub in the office:** a PR opened or merged and a release published become a party in the room; a red CI turns
  on the alarm, until a green CI.
- **Answering from the office** (P key): with the hook installed (`npm run hooks:install`), approve, deny or
  "always allow" permission requests without going to the terminal. Local access only.
- **Day timelapse** (L key): the office replays the day at high speed.
- **Read-only terminal** (T key): each agent's conversation, live, in the style of Claude Code, with search,
  filter, copy button and history of the sessions of the last 7 days. Local access only.
- **Day and night** by local time and **sounds** synthesized in the browser (off by default).
- **Social life:** whoever is idle gets together in hangouts (TV, video games, ping-pong, a chat in the kitchen,
  rock-paper-scissors for coins), with personalities, friendships and rivalries.
- **Waiting on shell:** the agent that waits on a long command stays at the desk with the hourglass, and the wait
  becomes a gag.
- Session forks appear in the office.
- The open page reloads by itself when the server starts serving another version.
- The container uses the computer's time zone.
- **The office:** each project open in Claude Code becomes a room and each session, a character with its own name.
  Subagents arrive, work and deliver to the main agent. It shows the two accounts, with the 5-hour and weekly usage of
  each one (statusline tap), plus an activity feed, notices and demo mode. Runs on Node or on local Docker.

[Unreleased]: https://github.com/marmottajr/habblaud/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/marmottajr/habblaud/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/marmottajr/habblaud/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/marmottajr/habblaud/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/marmottajr/habblaud/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.11.0
[0.10.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.10.0
[0.9.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.9.0
[0.8.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.8.0
[0.7.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.7.0
[0.6.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.6.0
[0.5.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.5.0
[0.4.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.4.0
[0.3.2]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.2
[0.3.1]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.1
[0.3.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.0
[0.2.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.2.0
