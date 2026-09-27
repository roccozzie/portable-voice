// POST /api/merge — server-side digest → merge-proposal intelligence.
//
// Input:  { digest: string, agent: string, voice: string }
// Output: { configured: false } when no ANTHROPIC_API_KEY is set (the page
//           then falls back to its built-in rule-based merge), or
//           { configured: true, items: [...] } where each item matches the
//           page's merge-item shape:
//           { text, bucket: 'agent'|'voice'|'tentative', section, evidence:
//             'stated'|'observed', strength: 'strong'|'moderate',
//             type: 'add'|'conflict'|'duplicate'|'tentative',
//             choice: 'incoming'|'reject'|'existing'|'skip'|'hold',
//             match: <existing line text> (conflicts only) }
//
// Privacy: the page PII-scans the digest in the browser before calling this
// endpoint, so raw personal details should never arrive here. The prompt
// below additionally instructs the model to generalize, never repeat.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 2000;

const SYSTEM = `You merge a structured user digest into two behavior files. Be strict.

The two files:
- agent.md — how any AI should WORK with this user: interaction, judgment, boundaries, authority. Public/shareable.
- voice.md — how it should SOUND and private preferences: language texture, tone, private standing preferences.

Every proposed line must EARN its place: it must change how a new AI behaves with this user. Cut anything true of almost any user ("be helpful", "be accurate"). Cut description; keep only behavior-correcting instructions. Write each line as an instruction to a future assistant, in the file's existing voice. Distill: ten digest bullets should become two or three file lines, not ten.

Routing:
- Interaction preferences, Decision patterns, When to ask vs. act, Corrections, Frustrations → bucket "agent"
- Working context, Voice and style → bucket "voice"
- Tentative section → bucket "tentative", type "tentative", choice "hold"

For each digest bullet decide:
- "add" (choice "incoming") — new, behavior-changing, no overlap with existing lines.
- "duplicate" (choice "skip") — an existing line already covers it. Omit these from output entirely.
- "conflict" (choice "existing") — contradicts an existing line; include the existing line's text in "match" so the user can pick.
- "tentative" (choice "hold") — from the Tentative section; held aside, never auto-filed.

Default choice: "incoming" for stated/strong adds, "reject" for moderate/observed adds the user should confirm.
Never invent facts. Never repeat personal details — generalize (e.g. "toddler (1.5)" not names). Keep each line under 25 words.

Return ONLY a JSON array of item objects. No prose, no code fences.`;

function extractJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON array in model output');
  return JSON.parse(text.slice(start, end + 1));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // Not configured yet — the page falls back to its local rule-based merge.
    res.status(200).json({ configured: false });
    return;
  }
  const body = req.body || {};
  const digest = typeof body.digest === 'string' ? body.digest : '';
  const agent = typeof body.agent === 'string' ? body.agent : '';
  const voice = typeof body.voice === 'string' ? body.voice : '';
  if (!digest.trim() || digest.length > 20000) {
    res.status(400).json({ error: 'digest required (max 20k chars)' });
    return;
  }

  const userContent =
    'Current agent.md:\n' + agent.slice(0, 6000) +
    '\n\nCurrent voice.md:\n' + voice.slice(0, 6000) +
    '\n\nDigest to merge:\n' + digest;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: 'model request failed', detail: detail.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const text = (data.content || []).map((b) => (b.text || '')).join('\n');
    const items = extractJson(text);
    if (!Array.isArray(items)) throw new Error('model output was not an array');
    res.status(200).json({ configured: true, items });
  } catch (e) {
    res.status(502).json({ error: 'merge failed', detail: String(e && e.message || e).slice(0, 300) });
  }
};
