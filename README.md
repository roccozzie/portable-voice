# Portable Voice — fitting flow

Teach any AI how to work with you. This is the deployable fitting MVP: an
interview + exercises flow that builds a portable `agent.md` / `voice.md`
pair, with a paste-and-merge loop for importing pattern digests.

## Layout

- `index.html` — the whole experience (static, self-contained). Works fully
  client-side: interview, exercises, comparison proof, rule-based digest
  merge, copy/download of the generated files.
- `api/merge.js` — Vercel serverless function. `POST /api/merge` with
  `{ digest, agent, voice }` returns `{ configured, items }`. When no
  `ANTHROPIC_API_KEY` is set it answers `{ configured: false }` and the page
  silently falls back to its built-in rule-based merge — so the site works
  with zero secrets configured.

## Enabling the AI merge

1. Create an API key at console.anthropic.com (needs billing enabled).
2. In the Vercel project: Settings → Environment Variables → add
   `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL` to pin a model ID;
   defaults to the pinned `claude-haiku-4-5-20251001` snapshot — the $1/$5
   efficiency tier, with prompt caching on the static system prompt).
3. Redeploy. The "Check and compare" step will now try the server-side merge
   first (15s timeout) and fall back locally if it fails.

Privacy note: the page scans pasted digests for personal details in the
browser *before* anything is sent to `/api/merge`.

## Product rules

- **1,500 characters per file.** Each generated file is budgeted to fit every
  paste box out of the box (ChatGPT Free: 1,500/box × 2). The settings page
  shows a per-file budget meter; the setup page reports both sizes and, when
  a file runs over, points at review to trim lines.
- **8 + 8 free.** The interview (8) and the deeper pass's first 8 exercises
  are free; the remaining 16 deeper exercises unlock with Pro.
- **Pro ($10 once):** full deeper pass, the extraction prompt + digest
  importer (`#/import`), and MCP early access.

## Deploy

Push to `main` → Vercel auto-deploys (GitHub App installed with repo access).
