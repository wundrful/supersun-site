// SUPERSUN — Stripe webhook → order-notification email (Netlify Function)
// Listens for `checkout.session.completed`, verifies the Stripe signature, and
// emails a full order breakdown (word, size, palette as color swatches, store code,
// customer, shipping) to you via Resend. Handles SUPERSUN and Surf Art orders.
//
// Endpoint (after deploy):  /.netlify/functions/stripe-webhook
//
// Required env vars (set in Netlify → Site settings → Environment variables):
//   STRIPE_WEBHOOK_SECRET  — the signing secret from the Stripe webhook endpoint (whsec_…)
//   RESEND_API_KEY         — your Resend API key (already set for palette.mjs)
// Optional:
//   ORDER_NOTIFY_EMAIL     — where notifications go (default: hello@supersun.art)
//   ORDER_FROM_EMAIL       — from header (default: "SUPERSUN <hello@supersun.art>")
//
// Zero dependencies — uses global fetch + Web Crypto for signature verification.

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const resendKey = process.env.RESEND_API_KEY;
  const notifyTo = process.env.ORDER_NOTIFY_EMAIL || "hello@supersun.art";
  const fromAddr = process.env.ORDER_FROM_EMAIL || "SUPERSUN <hello@supersun.art>";

  if (!secret) return new Response("missing_webhook_secret", { status: 500 });

  // Stripe signs the RAW request body — read it verbatim before any parsing.
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");

  const verified = await verifyStripeSignature(rawBody, sig, secret);
  if (!verified) return new Response("invalid_signature", { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch (_) {
    return new Response("bad_json", { status: 400 });
  }

  // Only act on completed, paid checkout sessions. Everything else → 200 (ignore).
  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 });
  }
  const session = (event.data && event.data.object) || {};
  if (session.payment_status && session.payment_status !== "paid") {
    return new Response("not_paid_yet", { status: 200 });
  }

  if (!resendKey) return new Response("missing_resend_key", { status: 500 });

  const { subject, html } = buildEmail(session);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [notifyTo],
        subject,
        html,
        // Reply goes straight to the customer, handy for shipping quotes.
        reply_to: (session.customer_details && session.customer_details.email) || undefined,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error("resend_error", r.status, detail);
      // Non-2xx → Stripe retries with backoff (Resend hiccups are usually transient).
      return new Response("resend_error", { status: 500 });
    }
  } catch (e) {
    console.error("exception", String(e));
    return new Response("exception", { status: 500 });
  }

  return new Response("ok", { status: 200 });
};

// ───────────────────────────────────────────────────────────────────────────────
// Build the notification email from the checkout session.
// ───────────────────────────────────────────────────────────────────────────────
function buildEmail(session) {
  const m = session.metadata || {};
  const product = String(m.product || "supersun").toLowerCase();
  const isSurf = product === "surf-art";

  const cust = session.customer_details || {};
  const ship =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    null;
  const shipName = (ship && ship.name) || cust.name || "";
  const shipAddr = (ship && ship.address) || cust.address || null;

  const amount =
    typeof session.amount_total === "number"
      ? `$${(session.amount_total / 100).toFixed(2)} ${String(session.currency || "usd").toUpperCase()}`
      : "";

  const storeCode = String(m.store_code || "").trim();
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : "";
  const dashUrl = piId ? `https://dashboard.stripe.com/payments/${piId}` : "";

  const sizeLabel = m.size_label || m.size || "";

  // ── Subject + the product-specific detail block ──────────────────────────────
  let subject;
  let detailRows = "";
  let paletteBlock = "";

  if (isSurf) {
    const title = m.title || "Surf Art";
    const artist = m.artist || "Harry";
    subject = `New Surf Art order — ${title} · ${sizeLabel}${storeCode ? ` · code ${storeCode}` : ""}`;
    detailRows =
      row("Piece", esc(title)) +
      row("Artist", esc(artist)) +
      row("Size", esc(sizeLabel));
  } else {
    const word = m.word || "SUPERSUN";
    const paletteName = m.palette_name || "";
    const colors = String(m.palette_colors || "").split(/\s+/).filter(Boolean);
    subject = `New SUPERSUN order — "${word}" · ${sizeLabel}${storeCode ? ` · code ${storeCode}` : ""}`;
    detailRows =
      row("Word", `<strong style="font-size:18px;">${esc(word)}</strong>`) +
      row("Size", esc(sizeLabel)) +
      (paletteName ? row("Palette", esc(paletteName)) : "");
    paletteBlock = colors.length ? paletteSection(colors) : "";
  }

  // ── Store code — the number that drives commission, so make it loud ──────────
  const codeBlock = storeCode
    ? `<div style="margin:22px 0 4px;padding:14px 16px;background:#E2DAC0;border:1px solid rgba(45,46,32,0.25);border-radius:4px;">
         <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a5b48;font-weight:600;">Store code</div>
         <div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#2D2E20;margin-top:2px;">${esc(storeCode)}</div>
       </div>`
    : `<div style="margin:22px 0 4px;padding:14px 16px;background:#EDE7D3;border:1px dashed rgba(45,46,32,0.3);border-radius:4px;font-size:14px;color:#8a8a73;">
         No store code — direct order (no commission attributed).
       </div>`;

  // ── Customer + shipping ──────────────────────────────────────────────────────
  const custRows =
    row("Name", esc(cust.name || shipName || "—")) +
    row("Email", cust.email ? `<a href="mailto:${esc(cust.email)}" style="color:#2D2E20;">${esc(cust.email)}</a>` : "—") +
    (cust.phone ? row("Phone", esc(cust.phone)) : "");

  const shipHtml = shipAddr
    ? `${esc(shipName)}<br>${addrLines(shipAddr)}`
    : "—";

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EDE7D3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDE7D3;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#EDE7D3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2D2E20;">

        <tr><td style="padding:8px 4px 20px;">
          <div style="font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#5a5b48;font-weight:600;">New order</div>
          <div style="font-size:26px;font-weight:700;letter-spacing:1px;margin-top:4px;">SUPERSUN</div>
        </td></tr>

        <tr><td style="background:#F3EEDD;border:1px solid rgba(45,46,32,0.12);border-radius:6px;padding:20px 22px;">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${detailRows}
          </table>

          ${paletteBlock}

          ${codeBlock}

        </td></tr>

        <tr><td style="height:14px;"></td></tr>

        <tr><td style="background:#F3EEDD;border:1px solid rgba(45,46,32,0.12);border-radius:6px;padding:20px 22px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a5b48;font-weight:600;margin-bottom:12px;">Customer</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${custRows}
          </table>
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a5b48;font-weight:600;margin:18px 0 8px;">Ship to</div>
          <div style="font-size:15px;line-height:1.5;">${shipHtml}</div>
        </td></tr>

        <tr><td style="height:14px;"></td></tr>

        <tr><td style="background:#F3EEDD;border:1px solid rgba(45,46,32,0.12);border-radius:6px;padding:20px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row("Total paid", `<strong>${esc(amount)}</strong>`)}
            ${piId ? row("Payment", `<span style="font-family:monospace;font-size:12px;">${esc(piId)}</span>`) : ""}
          </table>
          ${dashUrl ? `<a href="${esc(dashUrl)}" style="display:inline-block;margin-top:16px;font-size:13px;letter-spacing:1px;text-transform:uppercase;font-weight:600;color:#EDE7D3;background:#2D2E20;border-radius:4px;padding:11px 22px;text-decoration:none;">View in Stripe</a>` : ""}
        </td></tr>

        <tr><td style="padding:22px 4px;text-align:center;font-size:11px;color:#8a8a73;letter-spacing:0.5px;">
          Made by hand. Made to order.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// Palette: color swatch chips (with hex labels) + a stacked-band preview strip.
function paletteSection(colors) {
  const safe = colors.filter((c) => /^#?[0-9a-fA-F]{3,8}$/.test(c)).map((c) => (c[0] === "#" ? c : `#${c}`));
  if (!safe.length) return "";

  const chipW = Math.floor(100 / safe.length);
  const chips = safe
    .map(
      (c) => `<td width="${chipW}%" style="padding:0 3px;">
        <div style="height:52px;background:${c};border:1px solid rgba(45,46,32,0.15);border-radius:4px;"></div>
        <div style="font-family:monospace;font-size:10px;text-align:center;color:#5a5b48;padding-top:5px;">${esc(c.toUpperCase())}</div>
      </td>`
    )
    .join("");

  const bands = safe
    .map((c) => `<tr><td style="height:22px;background:${c};line-height:22px;font-size:0;">&nbsp;</td></tr>`)
    .join("");

  return `<div style="margin:20px 0 4px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a5b48;font-weight:600;margin-bottom:10px;">Palette</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${chips}</tr></table>
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a5b48;font-weight:600;margin:16px 0 8px;">Bands (top → bottom)</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(45,46,32,0.15);border-radius:4px;overflow:hidden;">${bands}</table>
  </div>`;
}

function row(label, valueHtml) {
  return `<tr>
    <td style="padding:6px 0;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a73;font-weight:600;width:120px;vertical-align:top;">${esc(label)}</td>
    <td style="padding:6px 0;font-size:15px;color:#2D2E20;vertical-align:top;">${valueHtml}</td>
  </tr>`;
}

function addrLines(a) {
  const parts = [
    a.line1,
    a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(", "),
    a.country,
  ].filter(Boolean);
  return parts.map((p) => esc(p)).join("<br>");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ───────────────────────────────────────────────────────────────────────────────
// Verify Stripe's webhook signature manually (no SDK).
// Header format: "t=<timestamp>,v1=<sig>[,v1=<sig>…]"
// signed_payload = "<timestamp>.<rawBody>", HMAC-SHA256 with the endpoint secret.
// ───────────────────────────────────────────────────────────────────────────────
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  let timestamp = null;
  const provided = [];
  for (const part of sigHeader.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") provided.push(v);
  }
  if (!timestamp || !provided.length) return false;

  // Reject events older than 5 minutes (replay protection).
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return provided.some((p) => safeEqualHex(expected, p));
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
