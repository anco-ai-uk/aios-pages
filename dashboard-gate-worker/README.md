# Dashboard Gate Worker

**LIVE:** `https://dashboard-gate.dave-777.workers.dev` (deployed 2026-07-22)
Gates: `training.memorialmastery.com` · client location `AnSYSwNy1Ms4BT9fOZ2M` · tag `dashboard-access`
⚠ Do not add a `GET /contacts/{id}` subrequest — GHL serves that route via a
Cloudflare Worker and Worker->Worker fetches die with error 1042. The search
endpoint returns tags and is the one that works from inside a Worker.

Email + tag access gate for a GHL AI Studio (vibe-coded) membership dashboard.

The dashboard page posts an email to this Worker. The Worker looks the contact
up in the client's GHL sub-account, checks for the access tag (default
`dashboard-access`), and returns a signed session token. The page stores the
token and re-verifies it on every load. The GHL token never touches the browser.

## One-time setup

1. **In the client's GHL sub-account** (not the agency view):
   - Settings -> Private Integrations -> Create. Scope needed: **View Contacts**
     (`contacts.readonly`) only. Copy the token.
   - Settings -> Business Profile: copy the **Location ID**.
   - Make sure the tag `dashboard-access` exists and is on every member who
     should get in (a workflow can add it on purchase).

2. **Fill in `wrangler.toml`:** set `GHL_LOCATION_ID` to the client's location ID.

3. **Fill in the dashboard origin** in `src/index.js` (`ALLOWED_ORIGINS`) once
   the vibe-coded dashboard is published.

4. **Deploy** (from this folder):
   ```
   npx wrangler deploy
   npx wrangler secret put GHL_TOKEN        # paste the client PIT
   npx wrangler secret put SESSION_SECRET   # paste any long random string, e.g. `openssl rand -hex 32`
   ```
   The deploy prints the Worker URL, e.g. `https://dashboard-gate.<account>.workers.dev`.

## Wiring the vibe-coded dashboard

Paste this prompt into AI Studio (replace WORKER_URL):

> Add an access gate to this app. On load, blur/hide all dashboard content
> behind a full-screen overlay with our logo, a single email input and an
> "Access dashboard" button. When the user submits, POST JSON
> `{ "email": "<the email>" }` to `WORKER_URL/check`. If the response JSON has
> `allowed: true`, store `response.token` in `localStorage` under
> `gate_token`, remove the overlay and show the dashboard. If `allowed` is
> false, show the response's `error` message under the input. On every page
> load, if `localStorage.gate_token` exists, POST `{ "token": <it> }` to
> `WORKER_URL/verify` first; if `allowed: true`, skip the overlay, otherwise
> clear the stored token and show the overlay. Show a loading spinner on the
> button while requests are in flight. Never call any other API for this.

## Endpoints

- `POST /check`  `{ email }`  -> `{ allowed, token?, expires?, error? }`
- `POST /verify` `{ token }`  -> `{ allowed }`

Denied responses are identical whether the email is unknown or just untagged,
so the gate can't be used to probe who is in the CRM.

Sessions last `SESSION_HOURS` (default 72) and then the user re-enters their
email. Revoking access = removing the tag; they lose access when their current
session expires.
