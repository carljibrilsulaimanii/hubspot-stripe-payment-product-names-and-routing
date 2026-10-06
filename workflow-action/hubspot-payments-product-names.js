// hubspot-payments-product-names.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-08-21 (published 2026-10-06)
// Deploy:  HubSpot workflow custom code action (Node.js 20.x) on the Payment object
//          (HubSpot's own payments). README "Variant: HubSpot Payments". Paste the
//          whole file. Requires Data Hub Professional (formerly Operations Hub).
// What:    Writes the names of a payment's associated line items into a custom
//          `products_purchased` property.
// Why:     The Payments object has no product field, so the payments table can never
//          show what was bought.
// ---------------------------------------------------------------------------
//
// Workflow setup:
//   Object type:  Payment
//   Trigger:      Payment status is any of Succeeded
//   Language:     Node.js 20.x
//   Secret:       HUBSPOT_PAYMENTS_TOKEN  (a service key or private app token;
//                 HUBSPOT_TOKEN also accepted - see getToken below)
//
// No "Property to include in code" inputs are needed - it reads the record id
// from the event and fetches everything else over the API.
//
// Prerequisite: the products_purchased property must already exist on the
// Payments object. Run scripts/create-products-purchased-property.mjs first.

const TARGET_PROPERTY = 'products_purchased';
const BASE = 'https://api.hubapi.com';

// A HubSpot secret's NAME becomes its env var name. HUBSPOT_PAYMENTS_TOKEN holds
// the service key built for this workflow; HUBSPOT_TOKEN is only a fallback.
//
// Service keys use the same pat-na1-... format as private app tokens, but this
// deliberately does not check for that prefix - the format is not guaranteed
// stable. It only rejects values that clearly are not bearer credentials, e.g. a
// webhook URL pasted into the wrong secret.
// Don't add other integrations' secrets as fallbacks. A different valid key
// authenticates fine and then 403s on payments - a misconfiguration that looks
// like a scope bug. Better to fail loudly.
const TOKEN_SECRET_NAMES = ['HUBSPOT_PAYMENTS_TOKEN', 'HUBSPOT_TOKEN'];

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
    // Name only, never the value - this is what makes a 403 diagnosable.
    console.log(`using secret: ${name}`);
    return value;
  }

  throw new Error(
    'No token secret found. Attach the secret holding your HubSpot service key, ' +
      `named one of: ${TOKEN_SECRET_NAMES.join(', ')}.`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(token, path, method = 'GET', body) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${method} ${path} -> ${res.status}`);
      await sleep(400 * 2 ** attempt); // stay well inside the 20s action timeout
      continue;
    }

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      // Most likely a bad token or a missing scope - say so plainly rather than
      // surfacing a raw HubSpot error 400 lines deep in the log.
      throw new Error(
        `${method} ${path} -> ${res.status}. Check the service key is valid and ` +
          'has crm.objects.commercepayments.read, ' +
          'crm.objects.commercepayments.write and crm.objects.line_items.read.'
      );
    }

    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }
  throw lastErr;
}

// Groups by name and takes max quantity, as a guard against duplicate line
// items on one payment (some checkouts write two identical rows seconds apart).
// The tradeoff is that a genuine quantity-2 order records
// as x1, so if lineItemCount and distinctProducts never diverge on real
// payments, switch Math.max to addition and this becomes lossless.
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
  const paymentId = String(event.object.objectId);

  const assoc = await api(
    token,
    `/crm/v4/objects/commerce_payments/${paymentId}/associations/line_items?limit=100`
  );
  const ids = [...new Set((assoc.results || []).map((r) => String(r.toObjectId)))];

  if (ids.length === 0) {
    // Line items are written by the checkout a beat after the payment record.
    // If this fires empty, add a 5-minute Delay before this action.
    console.log(`payment ${paymentId}: no associated line items yet`);
    return callback({
      outputFields: { products: '', lineItemCount: 0, distinctProducts: 0, status: 'no_line_items' },
    });
  }

  const batch = await api(token, '/crm/v3/objects/line_items/batch/read', 'POST', {
    properties: ['name', 'quantity', 'price'],
    inputs: ids.map((id) => ({ id })),
  });

  const items = (batch.results || []).map((li) => ({
    name: (li.properties.name || '').trim(),
    qty: Number(li.properties.quantity || 1),
  }));

  const products = summarize(items);

  await api(token, `/crm/v3/objects/commerce_payments/${paymentId}`, 'PATCH', {
    properties: { [TARGET_PROPERTY]: products },
  });

  const distinctProducts = new Set(items.map((i) => i.name)).size;
  console.log(`payment ${paymentId}: ${items.length} line item(s) -> "${products}"`);

  // lineItemCount vs distinctProducts: a gap means duplicate line items on this
  // checkout. Branch on it in the workflow if you want to be alerted.
  callback({
    outputFields: {
      products,
      lineItemCount: items.length,
      distinctProducts,
      status: 'updated',
    },
  });
};
