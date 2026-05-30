// SUPERSUN — Stripe Checkout (Netlify Function)
// Creates a Stripe Checkout Session for a custom, made-to-order poster.
// Made to order — pickup in store or shipping quoted by email, so checkout charges
// the piece price only (no shipping address collected, no shipping charged here).
// Requires env var STRIPE_SECRET_KEY (set in Netlify, marked secret).
// Zero dependencies — uses the global fetch + Stripe's form-encoded API.

// Server-trusted prices (in cents). The client never sets the price —
// we look it up from the size here so the amount can't be tampered with.
const PRICES = {
  "15x20": 32500,   // $325
  "24x32": 65000,   // $650
  "30x40": 125000,  // $1,250
  "45x60": 175000,  // $1,750
};
const SIZE_LABELS = {
  "15x20": "15 × 20 in",
  "24x32": "24 × 32 in",
  "30x40": "30 × 40 in",
  "45x60": "45 × 60 in",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors() });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: "missing_stripe_key" }, 500);

  let body = {};
  try { body = await req.json(); } catch (_) {}

  const size = String(body.size || "");
  if (!PRICES[size]) return json({ error: "invalid_size" }, 400);
  const amount = PRICES[size];               // trusted price, in cents
  const sizeLabel = SIZE_LABELS[size];

  const word = (String(body.word || "").slice(0, 40).trim()) || "SUPERSUN";
  const paletteName = String(body.paletteName || "").slice(0, 60).trim();
  const colors = Array.isArray(body.colors)
    ? body.colors.filter((c) => typeof c === "string").slice(0, 6).join(" ")
    : "";
  const storeCode = String(body.storeCode || "").slice(0, 40).trim();

  const origin = new URL(req.url).origin;
  const descParts = [`Word: "${word}"`];
  if (paletteName) descParts.push(`Palette: ${paletteName}`);
  if (colors) descParts.push(colors);
  const description = descParts.join(" · ").slice(0, 480);

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/order-confirmed.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${origin}/#commission`);
  params.append("billing_address_collection", "auto");
  params.append("phone_number_collection[enabled]", "true");
  // No shipping address / shipping charge at checkout — fulfillment is pickup in store
  // or shipping quoted separately by email. Surface that on the Stripe page:
  params.append("custom_text[submit][message]",
    "Made to order — ready in 10\u201314 days. Pick up in store, or we'll email you a shipping quote.");
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][price_data][product_data][name]", `SUPERSUN — ${sizeLabel} poster`);
  params.append("line_items[0][price_data][product_data][description]", description);
  params.append("metadata[word]", word);
  params.append("metadata[size]", size);
  params.append("metadata[size_label]", sizeLabel);
  params.append("metadata[palette_name]", paletteName);
  params.append("metadata[palette_colors]", colors);
  if (storeCode) params.append("metadata[store_code]", storeCode);

  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      const detail = (data && data.error && data.error.message) || "unknown";
      return json({ error: "stripe_error", detail }, 502);
    }
    return json({ url: data.url }, 200);
  } catch (e) {
    return json({ error: "exception", detail: String(e).slice(0, 300) }, 500);
  }
};

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
