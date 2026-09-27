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
   defaults to `claude-haiku-4-5`).
3. Redeploy. The "Check and compare" step will now try the server-side merge
   first (15s timeout) and fall back locally if it fails.

Privacy note: the page scans pasted digests for personal details in the
browser *before* anything is sent to `/api/merge`.

## Deploy

Push to `main` → Vercel auto-deploys (GitHub App installed with repo access).
