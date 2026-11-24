# Browser checks

End-to-end checks of the built extension in headless Chrome against a local
copy of chatgpt.com. They never contact the real site: `chatgpt.com` and
`other.test` are mapped to a server on 127.0.0.1 inside the browser only.

## Run

```sh
npm run e2e                      # build, then every check in order
npm run e2e -- --shuffle 7       # every check in a seeded random order
npm run e2e -- --only refresh,card-email
npm run e2e -- --no-build        # reuse the last e2e build
npm run e2e -- --list            # print the checks
npm run e2e:build                # build only
```

Needs Google Chrome (any recent stable version). The harness looks in the
usual install locations; set `CHROME_PATH` to use another binary. The exit
code is 0 only when every check passed. A full run takes about 10–15 minutes
on a slow laptop (the timing checks make 45 sends).

## What it does

- `build.ts` makes a development build (dev logs on) in
  `.output/chrome-mv3-e2e`. It never writes to `.output/chrome-mv3-dev`,
  which is the build loaded for live testing.
- `support/site.ts` serves the copy over HTTPS with a certificate created in
  memory for each run (`support/cert.ts`): the sanitised ChatGPT fixtures
  from `tests/fixtures/sites/chatgpt`, a nonce-only CSP like ChatGPT's,
  conversations stored on the server, a conversation ID shown in the URL
  0.8 s after the first send, and replies that echo the prompt. Replies to
  "Draft an email to …" carry an editable writing card that saves like
  ChatGPT does (POST …/writing-blocks, `\@` escapes, `&#x20;` between
  digits). Every request is recorded.
- `support/page.ts` is the copy's page script (served from the function's
  source).
- `support/browser.ts` starts Chrome with the extension, collects every
  console line of the pages and the service worker, and drives tabs with the
  keyboard and mouse.
- `checks/` holds the checks. Each one opens its own tabs, starts its own
  conversations and uses its own values, and puts back any global state it
  changes, so they pass in any order. The audit always runs last: no real
  value may appear in any request the site received (decoded, unescaped,
  compared without spacing or case) or in any log line.

## Test data

Published examples (with their sources in `support/values.ts`) and values
generated in memory from fixed labels. Nothing personal is written to the
repository.
