/**
 * Anco AIOS — booking relay Worker
 *
 * The public /schedule page (aios.ancoai.com) posts booking details here.
 * This Worker holds a GHL Private Integration Token (as a secret) and creates
 * the booking through GHL's official authenticated API — so the token never
 * touches the browser, and we don't fight GHL's widget anti-bot protection.
 *
 * Secret:  GHL_TOKEN            (wrangler secret put GHL_TOKEN)
 * Vars:    GHL_CALENDAR_ID, GHL_LOCATION_ID   (wrangler.toml)
 */

const ALLOWED_ORIGINS = [
  "https://aios.ancoai.com",
  "http://localhost:4620",
  "http://localhost:4661",
];

const GHL = "https://services.leadconnectorhq.com";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400, cors); }

    const startTime = (body.startTime || "").trim();
    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    const notes = (body.notes || "").trim();
    const timezone = (body.timezone || "Europe/London").trim();

    if (!startTime || !name || !email) {
      return json({ error: "Please add your name, email and a time." }, 422, cors);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "That email doesn't look right." }, 422, cors);
    }

    const CAL = env.GHL_CALENDAR_ID;
    const LOC = env.GHL_LOCATION_ID;
    const auth = { Authorization: `Bearer ${env.GHL_TOKEN}`, "Content-Type": "application/json" };

    const parts = name.split(/\s+/);
    const firstName = parts.shift() || name;
    const lastName = parts.join(" ");

    // 1) Upsert the contact (dedupes by email/phone within the location).
    const upsert = await fetch(`${GHL}/contacts/upsert`, {
      method: "POST",
      headers: { ...auth, Version: "2021-07-28" },
      body: JSON.stringify({
        locationId: LOC, firstName, lastName, name, email,
        ...(phone ? { phone } : {}),
        timezone,
        source: "AIOS booking page",
      }),
    });
    const upsertData = await upsert.json().catch(() => ({}));
    if (!upsert.ok) return json({ error: "We couldn't save your details. Try again or email dave@ancoai.com.", detail: upsertData }, 502, cors);
    const contactId = upsertData?.contact?.id || upsertData?.id;
    if (!contactId) return json({ error: "Booking failed (no contact id).", detail: upsertData }, 502, cors);

    // 2) Create the appointment on the round-robin calendar (auto-assigns a host).
    const appt = await fetch(`${GHL}/calendars/events/appointments`, {
      method: "POST",
      headers: { ...auth, Version: "2021-04-15" },
      body: JSON.stringify({
        calendarId: CAL,
        locationId: LOC,
        contactId,
        startTime,
        title: `AIOS Mapping Session — ${name}`,
        appointmentStatus: "confirmed",
        ignoreDateRange: false,
        toNotify: true,
      }),
    });
    const apptData = await appt.json().catch(() => ({}));
    if (!appt.ok) return json({ error: "That time was just taken or booking failed. Pick another, or email dave@ancoai.com.", detail: apptData }, 502, cors);

    // 3) Best-effort: attach the "anything we should know" note to the contact.
    if (notes) {
      try {
        await fetch(`${GHL}/contacts/${contactId}/notes`, {
          method: "POST",
          headers: { ...auth, Version: "2021-07-28" },
          body: JSON.stringify({ body: `AIOS booking note:\n${notes}` }),
        });
      } catch (_) { /* non-blocking */ }
    }

    return json({ ok: true, appointmentId: apptData?.id || apptData?.appointment?.id || null }, 200, cors);
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
