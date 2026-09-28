// POST /api/merge — server-side digest → merge-proposal intelligence.
//
// Input:  { digest: string, agent: string, voice: string }
// Output: { configured: false } when no ANTHROPIC_API_KEY is set (the page
//           then falls back to its built-in rule-based merge), or
//           { configured: true, items: [...] } where each item matches the
//           page's merge-item shape:
//           { text, section (one of: Context, How to answer, Decisions,
//             When to ask vs. act, Building, Writing, Voice and style),
//             bucket: 'agent'|'voice'|'tentative',
//             evidence: 'stated'|'observed', strength: 'strong'|'moderate',
//             type: 'add'|'conflict'|'duplicate'|'tentative',
//             choice: 'incoming'|'reject'|'existing'|'skip'|'hold',
//             examples: [Do/Don't strings] (attached to their rule, never alone),
//             match: <existing line text> (conflicts only) }
//
// Privacy: the page PII-scans the digest in the browser before calling this
// endpoint, so raw personal details should never arrive here. The prompt
// below additionally instructs the model to generalize, never repeat.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Pinned snapshot for deterministic output; still the $1/$5 efficiency tier.
// Override with ANTHROPIC_MODEL. Prompt caching (below) cuts the static
// system prompt to cache-read rates on repeat calls.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2000;

// Crude per-IP token bucket: 10 merge calls per minute per IP, per serverless
// instance. Instances don't share memory, so this stops accidents and casual
// abuse, not a distributed attack — the real backstop is the monthly spend
// limit in the Anthropic console. Rejected callers get 429; the page treats
// any failed merge call as "online merge unavailable" and matches on-device.
const buckets = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_HITS = 10;
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  if (buckets.size > 2000 && Math.random() < 0.02) {
    for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
  }
  b.count += 1;
  return b.count > MAX_HITS;
}

const SYSTEM = `You merge a structured user digest into two behavior files. Be strict.

The two files:
- agent.md — how any AI should WORK with this user: interaction, judgment, boundaries, authority. Public/shareable.
- voice.md — how it should SOUND and private preferences: language texture, tone, private standing preferences.

Every proposed line must EARN its place: it must change how a new AI behaves with this user. Cut anything true of almost any user ("be helpful", "be accurate"). Cut description; keep only behavior-correcting instructions. Write each line as an instruction to a future assistant, in the file's existing voice. Distill: ten digest bullets should become two or three file lines, not ten.

Routing:
- Working context, Interaction preferences, Decision patterns, When to ask vs. act, Corrections, Frustrations → bucket "agent"
- Voice and style → bucket "voice"
- Tentative section → bucket "tentative", type "tentative", choice "hold"

For each digest bullet decide:
- "add" (choice "incoming") — new, behavior-changing, no overlap with existing lines.
- "duplicate" (choice "skip") — an existing line already covers it. Omit these from output entirely.
- "conflict" (choice "existing") — contradicts an existing line; include the existing line's text in "match" so the user can pick.
- "tentative" (choice "hold") — from the Tentative section; held aside, never auto-filed.

Default choice: "incoming" for stated/strong adds, "reject" for moderate/observed adds the user should confirm.
Never invent facts. Never repeat personal details — generalize (e.g. "toddler (1.5)" not names). Keep each line under 25 words.

PACKAGING — the file is read by an agent, not a person:
- Voice: every line must speak in the file's own voice — direct address ("you") or first-person ("I"), matching the title "How to work with me". Never third-person ("he/his/him"). Rewrite: "He corrects fast" → "I correct fast and expect you to keep up."
- No evidence tags in line text: never emit [Stated]/[Observed] or (strong)/(moderate). Trust lives in the review UI; the file carries only instructions.
- Sections: assign each item exactly one section, in this order: Context, How to answer, Decisions, When to ask vs. act, Building, Writing, Voice and style. Every item gets one. Put related rules adjacent (the interruption policy sits next to scope-confirmation, not three sections apart).
- Examples: when the digest gives a Do/Don't pair, put it in the item's "examples" array so it renders as a sub-bullet under its rule. Never emit an example without its rule.
- Corrections and frustrations must be rewritten as positive directives ("Split long deliverables into sections or files"), never incident labels ("Responses that cut off mid-output"). Dedupe: if two lines say the same thing ("Over-editing his writing" / "Rewrites that erase his voice"), keep the sharper one and drop the other.
- Never drop a section: if the digest has Working context or Voice and style, that content must appear — those are often the strongest lines. Working context → section "Context".
- Resolve tensions: scope conditional rules to their context ("In strategy and analysis, look for one non-obvious extension…"), prefer "concrete" over "vivid", and translate implementation advice into user terms ("Assume I don't read code; ask me about outcomes, not implementation").

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
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'too many merge requests — try again in a minute' });
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
  if (!digest.trim() || digest.length > 8000) {
    res.status(400).json({ error: 'digest required (max 8k chars)' });
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
        temperature: 0.2,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
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
