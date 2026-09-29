// POST /api/compare — answer the user's prompt twice: once as a generic AI,
// once following the user's portable settings lines. Returns which lines
// shaped the fitted answer so the page can show its work.
//
// Abuse controls (defense in depth with the page's one-try-at-a-time UI):
// per-IP 10 calls/minute and 60 calls/hour; prompt capped at 300 chars;
// lines capped at 80 items / 300 chars each. Haiku keeps each call to a
// fraction of a cent. The monthly spend limit in the Anthropic console is
// the real backstop. Rejected callers get 429; the page re-enables the
// button so the user can retry.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1200;

const minuteBuckets = new Map();
const hourBuckets = new Map();
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function hit(bucket, ip, windowMs, max) {
  const now = Date.now();
  let b = bucket.get(ip);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    bucket.set(ip, b);
  }
  b.count += 1;
  if (bucket.size > 2000 && Math.random() < 0.02) {
    for (const [k, v] of bucket) if (now - v.start > windowMs) bucket.delete(k);
  }
  return b.count > max;
}
function rateLimited(ip) {
  return hit(minuteBuckets, ip, 60 * 1000, 10) || hit(hourBuckets, ip, 60 * 60 * 1000, 60);
}

const SYSTEM = `You answer one user question twice, then say which instruction lines shaped the second answer.

"plain": answer as a generic helpful AI with no knowledge of this user \u2014 the way you would answer a stranger.

"fitted": answer the same question for this specific person, guided by their instruction lines below. Do not perform the lines or announce them \u2014 just let them shape the answer the way they would shape a thoughtful friend's reply. Natural and specific beats polished and generic.

Rules:
- Each answer is 2 to 4 short sentences. Plain text only \u2014 no markdown, no headers, no bullet lists unless the question itself asks for a list.
- The plain answer must not use anything from the instruction lines.
- The fitted answer should feel written for this person, not like a demonstration of the lines. Subtle wins over dramatic.
- "shaped_by": the 1-based numbers of the instruction lines that most shaped the fitted answer, up to 6. Omit any line that barely mattered.

Return ONLY JSON of the form {"plain":"...","fitted":"...","shaped_by":[1,2]}. No other text.`;
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'too many tries — come back in a bit' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(200).json({ configured: false });
    return;
  }
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!prompt || prompt.length > 300) {
    res.status(400).json({ error: 'prompt required (max 300 chars)' });
    return;
  }
  const lines = rawLines
    .filter(function (l) { return l && typeof l.text === 'string' && l.text.trim(); })
    .slice(0, 80)
    .map(function (l) {
      return {
        bucket: l.bucket === 'voice' ? 'voice' : 'agent',
        text: l.text.trim().slice(0, 300),
      };
    });
  if (!lines.length) {
    res.status(400).json({ error: 'settings lines required' });
    return;
  }
  const numbered = lines
    .map(function (l, i) { return (i + 1) + '. [' + l.bucket + '] ' + l.text; })
    .join('\n');

  const userContent =
    'Instruction lines:\n' + numbered + '\n\nUser question: ' + prompt;

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
        temperature: 0.5,
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(function () { return ''; });
      throw new Error('anthropic ' + r.status + ' ' + t.slice(0, 200));
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('');
    const out = extractJson(text);
    if (typeof out.plain !== 'string' || typeof out.fitted !== 'string') {
      throw new Error('model output missing answers');
    }
    const shaped = Array.isArray(out.shaped_by)
      ? out.shaped_by
          .map(Number)
          .filter(function (n) { return n >= 1 && n <= lines.length; })
          .slice(0, 6)
      : [];
    res.status(200).json({
      plain: out.plain.slice(0, 2000),
      fitted: out.fitted.slice(0, 2000),
      shaped_by: shaped,
    });
  } catch (err) {
    console.error('compare failed:', err && err.message);
    res.status(502).json({ error: 'the AI is unreachable right now' });
  }
};
