// stripe-payment-product-names.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-08-28 (published 2026-10-06)
// Deploy:  HubSpot workflow custom code action (Node.js 20.x) on the custom object
//          that HubSpot's Stripe Data Sync fills with payments (README Steps 1-4).
//          Paste the whole file.
// What:    Looks up the Stripe Checkout Session behind each payment, reads its line
//          items, and writes the product names onto the payment record
//          (`product_name`, and `description` when Stripe left it blank).
// Why:     Stripe payment descriptions are often blank and the synced record has no
//          product field, so nothing in HubSpot says what was bought - and nothing
//          can be routed or reported by product.
// ---------------------------------------------------------------------------

// The custom object HubSpot's Stripe Data Sync fills with Stripe payments (README Step 1).
const OBJECT_TYPE = '2-12345678';
const BASE = 'https://api.hubapi.com';

// Written to always; `description` is only filled when Stripe left it blank, so
// a real Stripe description is never clobbered.
const NAME_PROPERTY = 'product_name';
const DESCRIPTION_PROPERTY = 'description';

// A HubSpot secret's NAME becomes its env var name. The service key needs
// crm.objects.custom.read and crm.objects.custom.write for this object (README Step 3).
const TOKEN_SECRET_NAMES = ['HUBSPOT_PAYMENTS_TOKEN', 'HUBSPOT_TOKEN'];

// Live-mode credential. A test key authenticates fine and then 404s on every
// live session, which reads as "no products found" rather than a bad secret -
// so reject it up front instead.
const STRIPE_SECRET_NAME = 'STRIPE_READ_KEY';

function getToken() {
  for (const name of TOKEN_SECRET_NAMES) {
    const value = (process.env[name] || '').trim();
    if (!value) continue;

    // Never log or echo the value itself - action logs are widely readable.
    if (/^https?:\/\//i.test(value) || /\s/.test(value)) {
      throw new Error(
        `Secret "${name}" looks like a URL or contains whitespace, so it is not ` +
          'a bearer credential. Attach the secret holding your HubSpot service key ' +
          'or private app token instead.'
      );
    }
    console.log(`using secret: ${name}`);
    return value;
  }

  throw new Error(
    'No token secret found. Attach the secret holding your HubSpot service key, ' +
      `named one of: ${TOKEN_SECRET_NAMES.join(', ')}.`
  );
}

function getStripeKey() {
  const value = (process.env[STRIPE_SECRET_NAME] || '').trim();

  if (!value) {
    throw new Error(
      `No Stripe key found. Add a secret named ${STRIPE_SECRET_NAME} holding a ` +
        'live restricted key with Checkout Sessions: read.'
    );
  }
  // Restricted keys are rk_, full secret keys sk_ - both are valid here.
  if (!/^(sk|rk)_live_/.test(value)) {
    throw new Error(
      `${STRIPE_SECRET_NAME} is not a live Stripe key. A test key returns 404 on ` +
        'live sessions, which would silently blank every description.'
    );
  }
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${label} -> ${res.status}`);
      await sleep(400 * 2 ** attempt); // stay well inside the 20s action timeout
      continue;
    }

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${label} -> ${res.status}. Check the credential and its scopes.`);
    }
    if (!res.ok) throw new Error(`${label} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }
  throw lastErr;
}

const api = (token, path, method = 'GET', body) =>
  request(
    BASE + path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    },
    `${method} ${path}`
  );

// Line items live only on the Checkout Session, and only when expanded -
// webhooks never carry them, which is why this call cannot be avoided.
const checkoutSession = (key, piId) =>
  request(
    'https://api.stripe.com/v1/checkout/sessions'
      + `?payment_intent=${encodeURIComponent(piId)}&limit=1&expand[]=data.line_items`,
    { headers: { Authorization: `Bearer ${key}` } },
    `GET /v1/checkout/sessions?payment_intent=${piId}`
  );

// Groups by name and takes max quantity, guarding against the duplicate line
// items some checkouts produce (two identical rows seconds apart). The tradeoff: a
// genuine quantity-2 order records as x1, so if lineItemCount and
// distinctProducts never diverge, switch Math.max to addition for losslessness.
function summarize(items, maxLength = 1000) {
  const byName = new Map();
  for (const item of items) {
    if (!item.name) continue;
    byName.set(item.name, Math.max(byName.get(item.name) || 0, item.qty));
  }
  const value = [...byName.entries()]
    .map(([name, qty]) => (qty > 1 ? `${name} x${qty}` : name))
    .join('; ');
  return value.length > maxLength ? value.slice(0, maxLength - 3) + '...' : value;
}

exports.main = async (event, callback) => {
  const token = getToken();
  const stripeKey = getStripeKey();

  const recordId = String(event.object.objectId);
  const piId = (event.inputFields['stripe_payment_transaction_id'] || '').trim();
  const existingDescription = (event.inputFields['description'] || '').trim();

  if (!piId) {
    console.log(`record ${recordId}: no Stripe Payment Transaction ID`);
    return callback({
      outputFields: { products: '', lineItemCount: 0, distinctProducts: 0, status: 'no_pi_id' },
    });
  }

  const session = await checkoutSession(stripeKey, piId);
  const first = (session.data || [])[0];

  if (!first) {
    // Invoice and subscription payments have no Checkout Session. Stripe already
    // describes those ("Invoice 1A2B3C4D-0001"), so nothing is missing.
    console.log(`record ${recordId}: ${piId} has no checkout session`);
    return callback({
      outputFields: { products: '', lineItemCount: 0, distinctProducts: 0, status: 'no_session' },
    });
  }

  const items = ((first.line_items && first.line_items.data) || []).map((li) => ({
    name: (li.description || '').trim(),
    qty: Number(li.quantity || 1),
  }));

  const products = summarize(items);

  if (!products) {
    console.log(`record ${recordId}: session ${first.id} had no named line items`);
    return callback({
      outputFields: { products: '', lineItemCount: items.length, distinctProducts: 0, status: 'no_products' },
    });
  }

  const properties = { [NAME_PROPERTY]: products };
  if (!existingDescription) properties[DESCRIPTION_PROPERTY] = products;

  await api(token, `/crm/v3/objects/${OBJECT_TYPE}/${recordId}`, 'PATCH', { properties });

  const distinctProducts = new Set(items.map((i) => i.name)).size;
  console.log(`record ${recordId}: ${items.length} line item(s) -> "${products}"`);

  callback({
    outputFields: {
      products,
      lineItemCount: items.length,
      distinctProducts,
      status: existingDescription ? 'updated_name_only' : 'updated',
    },
  });
};
