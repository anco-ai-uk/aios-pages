/**
 * Anco AIOS — membership dashboard gate Worker
 *
 * A vibe-coded (GHL AI Studio) dashboard posts an email address here.
 * This Worker holds a GHL Private Integration Token (as a secret) for the
 * CLIENT sub-account, looks the contact up by email, and checks whether it
 * carries the access tag. If yes, it returns a signed session token the page
 * stores and re-verifies on every load — so the token and the tag logic never
 * touch the browser.
 *
 * Endpoints:
 *   POST /check   { email }  -> { allowed, token?, expires? }
 *   POST /verify  { token }  -> { allowed }
 *
 * Secrets:  GHL_TOKEN       (wrangler secret put GHL_TOKEN)      — client sub-account PIT, contacts.readonly
 *           SESSION_SECRET  (wrangler secret put SESSION_SECRET) — random string for signing session tokens
 * Vars:     GHL_LOCATION_ID, REQUIRED_TAG, SESSION_HOURS         (wrangler.toml)
 */

const ALLOWED_ORIGINS = [
  "https://training.memorialmastery.com",
  "http://localhost:3000",
];
// AI Studio preview/published domains — tighten once the final URL is known.
const ORIGIN_PATTERNS = [];

const GHL = "https://services.leadconnectorhq.com";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400, cors); }

    const url = new URL(request.url);

    if (url.pathname === "/verify") {
      const ok = await verifyToken((body.token || "").trim(), env);
      return json({ allowed: ok }, 200, cors);
    }

    if (url.pathname === "/check") {
      const email = (body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ allowed: false, error: "That email doesn't look right." }, 422, cors);
      }

      const auth = { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: "2021-07-28" };

      // 1) Find the contact by email in the client location.
      const search = await fetch(
        `${GHL}/contacts/?locationId=${env.GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
        { headers: auth },
      );
      if (!search.ok) return json({ allowed: false, error: "Lookup failed. Try again in a minute." }, 502, cors);
      const found = (await search.json().catch(() => ({})))?.contacts || [];
      const match = found.find((c) => (c.email || "").toLowerCase() === email);

      // Same response whether the contact is missing or just untagged —
      // don't leak who is in the CRM.
      if (!match) return denied(cors);

      // 2) Tags come back on the search result itself. (Do NOT fetch
      // /contacts/{id} from here — GHL serves that route via a Cloudflare
      // Worker, and Worker->Worker fetches are blocked with error 1042.)
      const tags = (match.tags || []).map((t) => String(t).toLowerCase());

      const required = (env.REQUIRED_TAG || "dashboard-access").toLowerCase();
      if (!tags.includes(required)) return denied(cors);

      // 3) Issue a signed, expiring session token.
      const hours = Number(env.SESSION_HOURS || 72);
      const expires = Date.now() + hours * 3600 * 1000;
      const token = await signToken(email, expires, env);
      return json({ allowed: true, token, expires }, 200, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  },
};

function denied(cors) {
  return json({ allowed: false, error: "This email doesn't have access. Check you used the email you signed up with, or get in touch." }, 200, cors);
}

// --- signed session tokens (HMAC-SHA256 of "email|expiry") ---

async function hmac(payload, env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signToken(email, expires, env) {
  const payload = `${email}|${expires}`;
  const sig = await hmac(payload, env);
  return `${btoa(payload).replace(/=+$/, "")}.${sig}`;
}

async function verifyToken(token, env) {
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return false;
  let payload;
  try { payload = atob(b64); } catch { return false; }
  const [, expires] = payload.split("|");
  if (!expires || Date.now() > Number(expires)) return false;
  const expected = await hmac(payload, env);
  return timingSafeEqual(sig, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// --- helpers ---

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || ORIGIN_PATTERNS.some((p) => p.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
