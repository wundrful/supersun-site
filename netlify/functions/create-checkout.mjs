// SUPERSUN — Stripe Checkout (Netlify Function)
// Creates a Stripe Checkout Session for either a custom SUPERSUN poster (default)
// or a Surf Art print (body.product === "surf-art").
// Made to order — pickup in store or shipping quoted by email, so checkout charges
// the piece price only (no shipping address collected, no shipping charged here).
// Requires env var STRIPE_SECRET_KEY (set in Netlify, marked secret).
// Zero dependencies — uses the global fetch + Stripe's form-encoded API.

// ───────────────────────────────────────────────────────────────────────────────
// Server-trusted prices (in cents). The client never sets the price —
// we look it up from the size + product line here so the amount can't be tampered with.
// ───────────────────────────────────────────────────────────────────────────────

// SUPERSUN poster prices
const SUPERSUN_PRICES = {
  "15x20": 25000,   // $250
  "24x32": 50000,   // $500
  "30x40": 75000,   // $750
  "45x60": 125000,  // $1,250
};
const SUPERSUN_SIZE_LABELS = {
  "15x20": "15 × 20 in",
  "24x32": "24 × 32 in",
  "30x40": "30 × 40 in",
  "45x60": "45 × 60 in",
};

// Surf Art print prices — keyed per piece since each piece has its own size list.
// Sizes are width × height in inches; values are USD cents.
const SURF_ART_PIECES = {
  "BE": {
    prices: {
      "30x20": 50000,    // $500
      "45x30": 125000,   // $1,250
      "60x40": 375000,   // $3,750
      "75x50": 495000,   // $4,950
      "90x60": 825000,   // $8,250
    },
    labels: {
      "30x20": "30 × 20 in",
      "45x30": "45 × 30 in",
      "60x40": "60 × 40 in",
      "75x50": "75 × 50 in",
      "90x60": "90 × 60 in",
    },
  },
  "HIGH TIDE": {
    prices: {
      "30x19": 50000,    // $500
      "45x28": 125000,   // $1,250
      "60x38": 375000,   // $3,750
      "75x47": 495000,   // $4,950
      "90x56": 825000,   // $8,250
    },
    labels: {
      "30x19": "30 × 19 in",
      "45x28": "45 × 28 in",
      "60x38": "60 × 38 in",
      "75x47": "75 × 47 in",
      "90x56": "90 × 56 in",
    },
  },
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors() });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: "missing_stripe_key" }, 500);

  let body = {};
  try { body = await req.json(); } catch (_) {}

  // Branch on product line. Default is SUPERSUN; Surf Art uses "surf-art".
  const product = String(body.product || "supersun").toLowerCase();

  if (product === "surf-art" || product === "be") {
    return handleSurfArt(body, key, req);
  }
  return handleSupersun(body, key, req);
};

// ───────────────────────────────────────────────────────────────────────────────
// SUPERSUN (custom poster) — original flow
// ───────────────────────────────────────────────────────────────────────────────
async function handleSupersun(body, key, req) {
  const size = String(body.size || "");
  if (!SUPERSUN_PRICES[size]) return json({ error: "invalid_size" }, 400);
  const amount = SUPERSUN_PRICES[size];        // trusted price, in cents
  const sizeLabel = SUPERSUN_SIZE_LABELS[size];

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
  params.append("custom_text[submit][message]",
    "Made to order — ready in 10\u201314 days. Pick up in store, or we'll email you a shipping quote.");
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][price_data][product_data][name]", `SUPERSUN — ${sizeLabel} poster`);
  params.append("line_items[0][price_data][product_data][description]", description);
  params.append("metadata[product]", "supersun");
  params.append("metadata[word]", word);
  params.append("metadata[size]", size);
  params.append("metadata[size_label]", sizeLabel);
  params.append("metadata[palette_name]", paletteName);
  params.append("metadata[palette_colors]", colors);
  if (storeCode) params.append("metadata[store_code]", storeCode);

  // Also stamp the PaymentIntent so it shows up in Stripe's Payments export
  // (the Dashboard's CSV reads PaymentIntent metadata, not Session metadata).
  params.append("payment_intent_data[metadata][product]", "supersun");
  params.append("payment_intent_data[metadata][word]", word);
  params.append("payment_intent_data[metadata][size_label]", sizeLabel);
  if (paletteName) params.append("payment_intent_data[metadata][palette_name]", paletteName);
  if (storeCode) params.append("payment_intent_data[metadata][store_code]", storeCode);

  return submitToStripe(params, key);
}

// ───────────────────────────────────────────────────────────────────────────────
// SURF ART — a series of fine art prints by Harry. Currently one piece: BE.
// Fixed artwork (no palette/word customization), choose size only.
// ───────────────────────────────────────────────────────────────────────────────
async function handleSurfArt(body, key, req) {
  // Title identifies which Surf Art piece is being ordered (each has its own size list)
  const title = (String(body.title || "BE").slice(0, 40).trim().toUpperCase()) || "BE";
  const piece = SURF_ART_PIECES[title];
  if (!piece) return json({ error: "invalid_piece" }, 400);

  const size = String(body.size || "");
  if (!piece.prices[size]) return json({ error: "invalid_size" }, 400);
  const amount = piece.prices[size];           // trusted price, in cents
  const sizeLabel = piece.labels[size];

  const artist = (String(body.artist || "Harry").slice(0, 40).trim()) || "Harry";
  const storeCode = String(body.storeCode || "").slice(0, 40).trim();

  const origin = new URL(req.url).origin;
  const description = `${title} · by ${artist} · Surf Art Series`.slice(0, 480);

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/order-confirmed.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${origin}/surf-art.html`);
  params.append("billing_address_collection", "auto");
  params.append("phone_number_collection[enabled]", "true");
  params.append("custom_text[submit][message]",
    "Made to order — ready in 14\u201321 days. Pick up in store, or we'll email you a shipping quote.");
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(amount));
  params.append("line_items[0][price_data][product_data][name]", `${title} — ${sizeLabel} (Surf Art)`);
  params.append("line_items[0][price_data][product_data][description]", description);
  params.append("metadata[product]", "surf-art");
  params.append("metadata[series]", "surf-art");
  params.append("metadata[title]", title);
  params.append("metadata[artist]", artist);
  params.append("metadata[size]", size);
  params.append("metadata[size_label]", sizeLabel);
  if (storeCode) params.append("metadata[store_code]", storeCode);

  // Stamp the PaymentIntent too so Surf Art orders show up cleanly in Stripe exports.
  params.append("payment_intent_data[metadata][product]", "surf-art");
  params.append("payment_intent_data[metadata][title]", title);
  params.append("payment_intent_data[metadata][artist]", artist);
  params.append("payment_intent_data[metadata][size_label]", sizeLabel);
  if (storeCode) params.append("payment_intent_data[metadata][store_code]", storeCode);

  return submitToStripe(params, key);
}

// ───────────────────────────────────────────────────────────────────────────────
// Shared: actually POST to Stripe and return the session URL.
// ───────────────────────────────────────────────────────────────────────────────
async function submitToStripe(params, key) {
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
