# How to contribute

Thank you for wanting to contribute to Habblaud! Bug reports, ideas and improvements are welcome.

## Before you start

- For bugs and ideas, search the [issues](https://github.com/marmottajr/habblaud/issues) to see if the topic has already been filed.
- For larger changes or ones that alter Habblaud's behavior, open an issue to discuss the proposal before implementing.
- Prefer small, focused changes. If the change alters what appears or happens in the office, describe that behavior in the pull request.

## Set up the environment

Habblaud requires Node.js 22.12 or newer and npm. After cloning the repository:

```sh
npm install
npm run dev
```

The development office is at <http://localhost:4747>.

## Texts and translations

Habblaud has an interface in English, Portuguese, Spanish and French. English is the source language:

- Every text that appears to the user (interface, errors, logs, installation scripts) is written in English inside
  `tr()` (`shared/i18n.ts`). Values go in through numbered placeholders: `tr('Reading {0}', [file])`, never a
  template string inside `tr()`.
- The translation key is the English text itself: changing the text changes the key. Update its translations in
  `shared/locales/` (`pt-BR.ts`, `es.ts`, `fr.ts`) or leave it without: a text without a translation appears in
  English.
- `npm run i18n:check` lists the texts without a translation and the leftover translations.

## Verify a change

Before opening the pull request, run:

```sh
npm run typecheck
npm test
npm run build
```

If the change alters a Claude Code plugin, also validate the affected plugin:

```sh
claude plugin validate mod/habblaud
claude plugin test mod/habblaud
```

Use the path of the changed plugin (`mod/habblaud-permissoes` or `mod/habblaud-mensagens`) when that is the case.

## Open a pull request

- Use a clear title and explain the problem, the change and how it was verified.
- Reference the related issue, if there is one.
- For visual changes, include a screenshot or a GIF, if it helps show the result. Take the screenshots in
  demo mode (`?mock=1` in the URL or `npm run demo`), which shows only fictional agents.
- Update the **Unreleased** section of `CHANGELOG.md` when the change brings something visible to those who use Habblaud.
- PRs that touch `shared/world/` or `server/world/` (Habblaud World) explain what changes in what leaves the computer, and
  the review checks the list in [`docs/world/privacidade.md`](docs/world/privacidade.md) against the code. Read
  [`shared/world/README.md`](shared/world/README.md) first.
- Do not include personal data, credentials or private session content in screenshots, examples or logs.

If something is not clear, ask in the related issue before going in a direction that could change the project's behavior.
