# Hokey Home Care — HitPay + WhatsApp backend

This is the missing piece the storefront's `index.html` now talks to. A
plain HTML/JS file **cannot** safely create HitPay payment requests or send
WhatsApp messages on its own — both need secret keys that must never sit in
a customer's browser. This tiny server holds those secrets instead.

## What it does

1. **`POST /api/create-payment-request`** — the storefront calls this when
   the customer clicks "Pay Securely Now". It creates a HitPay Payment
   Request (via HitPay's API, using your secret key) and returns the hosted
   checkout URL to redirect the customer to.
2. **`POST /api/webhooks/hitpay`** — HitPay calls this automatically, from
   its own servers, the moment a payment succeeds. The signature is
   verified before anything is trusted. This is the *only* thing that marks
   an order "paid" — never the browser redirect.
3. Once step 2 confirms payment, the server sends **one WhatsApp message**
   from your business WhatsApp number to `WHATSAPP_TO_NUMBER` (91163266)
   with the order details, and HitPay itself emails the receipt to the
   customer (`send_email: true`).
4. **`GET /api/orders/:reference`** — the storefront polls this after the
   customer is redirected back, to show the "Payment received" screen only
   once the order is genuinely confirmed.

## 1. Set up HitPay

1. Create a HitPay account at https://www.hitpayapp.com (a Sandbox account
   is free and lets you test end-to-end before going live).
2. In the dashboard: **Settings → Payment Methods** → enable PayNow (and
   any card/e-wallet methods you want).
3. In the dashboard: **Settings → Payment Gateway → API Keys** → copy your
   **Business API Key** into `HITPAY_API_KEY` in `.env`.
4. In the dashboard: **Settings → Webhooks** (or wherever your HitPay
   dashboard shows the webhook signing salt) → copy the **webhook salt**
   into `HITPAY_WEBHOOK_SALT`.
5. Double-check the current webhook payload/signature format in HitPay's
   docs (https://docs.hitpayapp.com) before going live — `verifyHitPayHmac`
   in `index.js` implements their documented scheme, but payment-signature
   details are exactly the kind of thing worth re-confirming against the
   live docs, since a mismatch here means real payments won't be recorded.

## 2. Set up WhatsApp (Meta Cloud API)

Automatically sending a WhatsApp message — with no one tapping "send" —
requires the **WhatsApp Business Platform (Cloud API)**, not a personal
WhatsApp or WhatsApp Business app. This needs a one-time setup in Meta
Business Manager:

1. Create a Meta Business Account and a WhatsApp Business Platform app at
   https://business.facebook.com and https://developers.facebook.com/apps.
2. Add a phone number to it (this becomes the *one account* that sends the
   message — it does **not** have to be 91163266; that number is just the
   *recipient*).
3. Generate a **permanent access token** (System User token) — copy into
   `WHATSAPP_TOKEN`.
4. Copy the **Phone Number ID** shown in the API setup screen into
   `WHATSAPP_PHONE_NUMBER_ID`.
5. Set `WHATSAPP_TO_NUMBER=6591163266` (Singapore country code + number, no
   `+` or spaces).
6. **Important 24-hour rule:** Meta only allows free-form text messages to
   a number that has messaged your business number within the last 24
   hours. For a notification that fires automatically at any time of day,
   you'll want an **approved message template** instead — create one under
   WhatsApp Manager → Message Templates (e.g. an "order_notification"
   template), then set `WHATSAPP_TEMPLATE_NAME` in `.env`. Until that
   template is approved, test by first sending any message from
   91163266's WhatsApp to your business number, which opens the 24h window
   for plain text.

## 3. Configure and run

```bash
cd server
cp .env.example .env
# fill in .env with the values from steps 1 and 2
npm install
npm start
```

The server listens on `PORT` (default 4000). Deploy it somewhere reachable
over HTTPS (Render, Railway, Fly.io, a small VPS, etc.) — HitPay's webhook
needs a public URL to call. Local `http://localhost` will not work for the
webhook step unless you tunnel it (e.g. `ngrok http 4000`) for testing.

## 4. Point the storefront at it

In `index.html`, set:

```js
const BACKEND_BASE_URL = "https://your-deployed-backend.example.com";
```

That's the only change needed on the frontend side — everything else
(the "Pay Securely Now" button, the confirmation screen, the receipt
download) is already wired up to call this backend.

## Notes on the order data store

`store.js` is a single JSON file on disk (`orders.json`) — good enough to
get the whole flow working and testable, not something to run a real store
on long-term (concurrent writes, backups, and multi-server deployments all
need a real database). Swap `readAll`/`writeAll` in `store.js` for calls to
Postgres/SQLite/your DB of choice; nothing else in the project needs to
change.
