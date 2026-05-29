// SUPERSUN — AI palette generator (Netlify Function)
// Turns any word / place / mood / memory into 6 ordered hex colors via Claude.
// Requires the environment variable ANTHROPIC_API_KEY (set in Netlify, never in code).
// Zero npm dependencies — uses the global fetch built into the Netlify runtime.

const MODEL = "claude-haiku-4-5"; // fast + inexpensive; ideal for real-time palette calls

const SYSTEM = `You are the colorist for SUPERSUN, a brand of hand-made vintage screen-print sun posters. Each poster is a single large sun made of six horizontal color bands, on warm cream paper, in a 1960s–70s California screen-print style.

Given an input — a word, place, mood, memory, color, or short phrase — return a palette of EXACTLY 6 colors that captures it, ordered from the TOP band of the sun (lightest / sky / air) down to the BOTTOM band (deepest / horizon / ground). The six bands together should read like a sun rising or setting over the feeling of the input.

Rules:
- Exactly 6 colors, formatted "#RRGGBB" in uppercase hex.
- Ordered light → deep (top of the sun to the bottom).
- Cohesive and intentional — capture the SPECIFIC input, not a generic gradient. A literal color word ("pink") should yield that color family. A place or memory should evoke its real light and tones.
- Screen-print friendly: saturated but not neon, with depth. Avoid muddy grays or near-black unless the input truly calls for it.

Respond with ONLY minified JSON, no markdown, no commentary:
{"name":"<2-4 word palette name>","colors":["#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB"]}`;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors() });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let prompt = "";
  try { ({ prompt } = await req.json()); } catch (_) {}
  prompt = (prompt || "").toString().slice(0, 200).trim();
  if (!prompt) return json({ error: "empty prompt" }, 400);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "missing_api_key" }, 500);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        system: SYSTEM,
        messages: [{ role: "user", content: `Input: ${prompt}` }],
      }),
    });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return json({ error: "upstream", status: r.status, detail }, 502);
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parsePalette(text);
    if (!parsed) return json({ error: "parse_failed", raw: text.slice(0, 300) }, 502);
    return json(parsed, 200);
  } catch (e) {
    return json({ error: "exception", detail: String(e).slice(0, 300) }, 500);
  }
};

function parsePalette(text) {
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  let obj;
  try { obj = JSON.parse(t); } catch (_) { return null; }
  if (!Array.isArray(obj.colors)) return null;
  const colors = obj.colors.map(normHex).filter(Boolean);
  if (colors.length < 6) return null;
  return { name: (obj.name || "").toString().slice(0, 48), colors: colors.slice(0, 6) };
}

function normHex(c) {
  if (typeof c !== "string") return null;
  let h = c.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors() },
  });
}
