# PromptVeil

PromptVeil is a Chrome and Edge extension that protects personal data in prompts sent to AI chatbots on chatgpt.com, gemini.google.com and claude.ai. Before a prompt is sent, it finds items such as names, email addresses, phone numbers and ID numbers, and replaces each one with a realistic stand-in in the same format. When the reply comes back, it restores the real values so the conversation still reads naturally. Everything runs on your device, and nothing is sent anywhere else.

**Status:** early development.

## Build and run

Requires Node.js 24.

```sh
cd extension
npm ci
npm run dev
```

`npm run dev` builds the extension into `.output/chrome-mv3-dev` and rebuilds on every change. It does not open a browser. Load the extension once:

1. Open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
2. Choose "Load unpacked" and select `extension/.output/chrome-mv3-dev`.

Run the tests with `npm test`.

## Repository layout

- `extension/` – the extension (WXT, TypeScript, React, Tailwind)
  - `entrypoints/` – background worker, popup and one content script per site
  - `src/` – adapters, core logic, in-page UI and shared code
  - `tests/` – unit and end-to-end tests and fixtures
  - `scripts/` – build-time scripts
- `ml/`, `eval/` – model training and evaluation work
