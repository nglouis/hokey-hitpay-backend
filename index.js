// ---------------------------------------------------------------------------
// Hokey Home Care — HitPay + WhatsApp backend
// ---------------------------------------------------------------------------
// Why this file has to exist at all:
//  - HitPay requires a secret "Business API Key" to create a payment
//    request. That key must never reach the customer's browser, so the
//    website's JS calls THIS server instead, and this server calls HitPay.
//  - The only trustworthy signal that an order was actually paid is
//    HitPay's server-to-server webhook (verified below with an HMAC
//    signature) — never the customer's browser redirecting back to the
//    site, which anyone could fake by typing a URL.
//  - Sending a WhatsApp message automatically (without the customer's
//    phone/app) requires the WhatsApp Business Cloud API and a permanent
//    access token, which is another secret that has to live on a server.
// ---------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { saveOrder, getOrder, updateOrderStatus } = require('./store');

const {
  HITPAY_API_KEY,
  HITPAY_WEBHOOK_SALT,
  HITPAY_ENV,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TO_NUMBER,
  WHATSAPP_TEMPLATE_NAME,
  PORT,
  ALLOWED_ORIGINS,
  RESEND_API_KEY,
  OWNER_EMAIL
} = process.env;

const HITPAY_API_BASE =
  HITPAY_ENV === 'live' ? 'https://api.hit-pay.com/v1' : 'https://api.sandbox.hit-pay.com/v1';

const app = express();
app.use(
  cors({
    origin: (ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  })
);
app.use(express.json());

// -----------------------------------------------------------------------
// 1) Create a HitPay payment request for the customer's cart total.
//    The frontend redirects the customer to the `url` we return.
// -----------------------------------------------------------------------
app.post('/api/create-payment-request', async (req, res) => {
  try {
    const { reference, amount, currency, customer, items, redirect_url } = req.body;

    if (!reference || !amount || !customer || !customer.email) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }

    // NOTE: for a real store, re-derive `amount` from your own product
    // price list + `items` here instead of trusting the number the browser
    // sent — otherwise a customer could tamper with the request and pay
    // less than the real total. Kept simple here since prices live only
    // in the storefront HTML in this project.

    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/hitpay`;

    const order = saveOrder({
      reference,
      amount,
      currency: currency || 'SGD',
      customer,
      items: items || [],
      status: 'pending',
      createdAt: Date.now()
    });

    const hitpayRes = await fetch(`${HITPAY_API_BASE}/payment-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BUSINESS-API-KEY': HITPAY_API_KEY
      },
      body: JSON.stringify({
        amount: order.amount,
        currency: order.currency,
        email: order.customer.email,
        name: order.customer.name,
        phone: order.customer.phone,
        reference_number: order.reference,
        redirect_url: redirect_url
          ? `${redirect_url}?reference=${encodeURIComponent(order.reference)}`
          : undefined,
        webhook: webhookUrl,
        send_email: true, // HitPay emails the receipt to the customer automatically
        generate_qr: false
      })
    });

    const data = await hitpayRes.json();

    if (!hitpayRes.ok) {
      console.error('HitPay create-payment-request failed:', data);
      return res.status(502).json({ error: 'HitPay rejected the payment request.', details: data });
    }

    updateOrderStatus(order.reference, 'awaiting_payment', {
      hitpayPaymentRequestId: data.id || data.payment_request_id || null,
      hitpayUrl: data.url
    });

    return res.json({ url: data.url });
  } catch (err) {
    console.error('create-payment-request error:', err);
    return res.status(500).json({ error: 'Internal server error creating payment request.' });
  }
});

// -----------------------------------------------------------------------
// 2) HitPay's webhook — this is the ONLY thing that marks an order paid.
//    Verify the HMAC signature against your webhook salt before trusting
//    anything in the payload (see HitPay's webhook-signing docs).
// -----------------------------------------------------------------------
app.post(
  '/api/webhooks/hitpay',
  express.urlencoded({ extended: true }), // HitPay posts webhooks as form-encoded
  async (req, res) => {
    try {
      const params = { ...req.body };
      const receivedHmac = params.hmac;
      delete params.hmac;

      if (!verifyHitPayHmac(params, receivedHmac, HITPAY_WEBHOOK_SALT)) {
        console.warn('HitPay webhook signature mismatch — ignoring payload.');
        return res.status(400).send('Invalid signature');
      }

      const reference = params.reference_number;
      const status = params.status; // e.g. "completed"

      if (!reference) return res.status(400).send('Missing reference_number');

      const order = getOrder(reference);
      if (!order) {
        console.warn(`Webhook for unknown order reference: ${reference}`);
        return res.status(404).send('Unknown order');
      }

      const updated = updateOrderStatus(reference, status === 'completed' ? 'completed' : status, {
        hitpayPaymentId: params.payment_id || null
      });

      if (status === 'completed' && !order.whatsappNotified) {
        await notifyStoreOnWhatsApp(updated);
        updateOrderStatus(reference, updated.status, { whatsappNotified: true });
      }

      if (status === 'completed' && !order.ownerEmailNotified) {
        await notifyOwnerByEmail(updated);
        updateOrderStatus(reference, updated.status, { ownerEmailNotified: true });
      }

      return res.status(200).send('OK');
    } catch (err) {
      console.error('HitPay webhook handling error:', err);
      return res.status(500).send('Internal error');
    }
  }
);

// -----------------------------------------------------------------------
// 3) Order status lookup — used by the storefront's confirmation page
//    after the customer is redirected back from HitPay.
// -----------------------------------------------------------------------
app.get('/api/orders/:reference', (req, res) => {
  const order = getOrder(req.params.reference);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.json({ status: order.status, reference: order.reference });
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

// Reproduces HitPay's documented webhook-signing scheme: concatenate every
// "key"+"value" pair (sorted by key) and HMAC-SHA256 it with your webhook
// salt, then compare to the `hmac` field HitPay sent. Always re-check this
// against HitPay's current docs (Settings > Webhooks) before going live —
// payment-signature schemes are exactly the kind of detail worth
// double-checking against the source rather than trusting from memory.
function verifyHitPayHmac(params, receivedHmac, salt) {
  if (!receivedHmac || !salt) return false;
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map((key) => `${key}${params[key]}`).join('');
  const expected = crypto.createHmac('sha256', salt).update(concatenated).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedHmac));
  } catch {
    return false; // length mismatch etc.
  }
}

// Sends the "order paid" notification to the ONE store WhatsApp number,
// from the ONE business WhatsApp account, via Meta's WhatsApp Cloud API.
// Requirements this depends on (see server/README.md):
//  - A WhatsApp Business Platform (Cloud API) number, already set up
//    through Meta Business Manager.
//  - Either the recipient (WHATSAPP_TO_NUMBER) has messaged that business
//    number in the last 24 hours, OR you send an approved message
//    template (set WHATSAPP_TEMPLATE_NAME) — Meta blocks free-form
//    business-initiated text outside that 24h window.
async function notifyStoreOnWhatsApp(order) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TO_NUMBER) {
    console.warn('WhatsApp not configured — skipping notification for', order.reference);
    return;
  }

  const itemLines = (order.items || [])
    .map((i) => `${i.qty}x ${i.name}${i.color ? ` (${i.color})` : ''}`)
    .join('\n');

  const messageBody =
    `✅ New paid order — ${order.reference}\n\n` +
    `Name: ${order.customer.name}\n` +
    `Phone: ${order.customer.phone}\n` +
    `Email: ${order.customer.email}\n` +
    `Address: ${order.customer.address}\n\n` +
    `Items:\n${itemLines}\n\n` +
    `Total paid: ${order.currency} ${order.amount}`;

  const payload = WHATSAPP_TEMPLATE_NAME
    ? {
        messaging_product: 'whatsapp',
        to: WHATSAPP_TO_NUMBER,
        type: 'template',
        template: {
          name: WHATSAPP_TEMPLATE_NAME,
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: messageBody }]
            }
          ]
        }
      }
    : {
        messaging_product: 'whatsapp',
        to: WHATSAPP_TO_NUMBER,
        type: 'text',
        text: { body: messageBody }
      };

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      console.error('WhatsApp send failed:', data);
    } else {
      console.log(`WhatsApp notification sent for order ${order.reference}`);
    }
  } catch (err) {
    console.error('WhatsApp send error:', err);
  }
}

// Sends a plain "new paid order" email to the store owner via Resend,
// so orders are visible without needing WhatsApp/Meta set up at all.
async function notifyOwnerByEmail(order) {
  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    console.warn('Resend not configured — skipping owner email for', order.reference);
    return;
  }

  const itemLines = (order.items || [])
    .map((i) => `${i.qty}x ${i.name}${i.color ? ` (${i.color})` : ''}`)
    .join('<br>');

  const html =
    `<h2>New paid order — ${order.reference}</h2>` +
    `<p><b>Name:</b> ${order.customer.name}<br>` +
    `<b>Phone:</b> ${order.customer.phone}<br>` +
    `<b>Email:</b> ${order.customer.email}<br>` +
    `<b>Address:</b> ${order.customer.address}</p>` +
    `<p><b>Items:</b><br>${itemLines}</p>` +
    `<p><b>Total paid:</b> ${order.currency} ${order.amount}</p>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Hokey Orders <onboarding@resend.dev>',
        to: OWNER_EMAIL,
        subject: `New order ${order.reference} — ${order.currency} ${order.amount}`,
        html
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('Resend email failed:', data);
    } else {
      console.log(`Owner email sent for order ${order.reference}`);
    }
  } catch (err) {
    console.error('Resend email error:', err);
  }
}

const port = PORT || 4000;
app.listen(port, () => console.log(`Hokey backend listening on port ${port}`));
