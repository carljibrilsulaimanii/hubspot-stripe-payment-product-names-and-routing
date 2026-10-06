// actions.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-10-06
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs both workflow actions in a sandbox with a fake fetch, so the
//          product-name logic and every early exit can be checked without a Stripe
//          or HubSpot account.
// Why:     The routing branches read the value these actions write; a change in its
//          format breaks routing silently.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (f) => readFileSync(new URL(`../workflow-action/${f}`, import.meta.url), 'utf8');
const STRIPE_SRC = load('stripe-payment-product-names.js');
const PAYMENTS_SRC = load('hubspot-payments-product-names.js');

async function run(source, { event, respond, env }) {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const body = respond(String(url), method) ?? {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const ctx = {
    exports: {},
    fetch: fakeFetch,
    process: { env },
    console: { log() {}, error() {} },
    setTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const result = await new Promise((resolve, reject) => {
    ctx.exports.main(event, resolve).catch(reject);
  });
  return { out: JSON.parse(JSON.stringify(result.outputFields)), calls: JSON.parse(JSON.stringify(calls)) };
}

// ---------------------------------------------------------------- Stripe payments object

const STRIPE_ENV = { HUBSPOT_PAYMENTS_TOKEN: 'pat-test', STRIPE_READ_KEY: 'rk_live_test' };

function stripeEvent(inputs) {
  return { object: { objectId: 101 }, inputFields: { stripe_payment_transaction_id: 'pi_123', description: '', ...inputs } };
}

function sessionWith(lineItems) {
  return (url) =>
    url.startsWith('https://api.stripe.com/')
      ? { data: lineItems === null ? [] : [{ id: 'cs_live_1', line_items: { data: lineItems } }] }
      : {};
}

test('stripe: names are written to product_name and to a blank description', async () => {
  const { out, calls } = await run(STRIPE_SRC, {
    env: STRIPE_ENV,
    event: stripeEvent({}),
    respond: sessionWith([
      { description: 'Starter Toolkit', quantity: 1 },
      { description: 'Order Bump', quantity: 1 },
    ]),
  });
  assert.equal(out.status, 'updated');
  assert.equal(out.products, 'Starter Toolkit; Order Bump');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/crm/v3/objects/2-12345678/101'));
  assert.deepEqual(patch.body.properties, { product_name: 'Starter Toolkit; Order Bump', description: 'Starter Toolkit; Order Bump' });
});

test('stripe: a real Stripe description is never overwritten', async () => {
  const { out, calls } = await run(STRIPE_SRC, {
    env: STRIPE_ENV,
    event: stripeEvent({ description: 'Set by Stripe' }),
    respond: sessionWith([{ description: 'Starter Toolkit', quantity: 1 }]),
  });
  assert.equal(out.status, 'updated_name_only');
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body.properties, { product_name: 'Starter Toolkit' });
});

test('stripe: duplicate line items collapse to one, a real quantity is kept', async () => {
  const { out } = await run(STRIPE_SRC, {
    env: STRIPE_ENV,
    event: stripeEvent({}),
    respond: sessionWith([
      { description: 'Starter Toolkit', quantity: 1 },
      { description: 'Starter Toolkit', quantity: 1 },
      { description: 'VIP Ticket', quantity: 2 },
    ]),
  });
  assert.equal(out.products, 'Starter Toolkit; VIP Ticket x2');
  assert.equal(out.lineItemCount, 3);
  assert.equal(out.distinctProducts, 2);
});

test('stripe: the lookup is by PaymentIntent with line items expanded', async () => {
  const { calls } = await run(STRIPE_SRC, {
    env: STRIPE_ENV,
    event: stripeEvent({}),
    respond: sessionWith([{ description: 'Starter Toolkit', quantity: 1 }]),
  });
  const get = calls.find((c) => c.url.startsWith('https://api.stripe.com/'));
  assert.ok(get.url.includes('payment_intent=pi_123'));
  assert.ok(get.url.includes('expand[]=data.line_items'));
});

test('stripe: invoices and subscriptions (no Checkout Session) write nothing', async () => {
  const { out, calls } = await run(STRIPE_SRC, { env: STRIPE_ENV, event: stripeEvent({}), respond: sessionWith(null) });
  assert.equal(out.status, 'no_session');
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('stripe: no PaymentIntent id writes nothing and never calls Stripe', async () => {
  const { out, calls } = await run(STRIPE_SRC, { env: STRIPE_ENV, event: stripeEvent({ stripe_payment_transaction_id: '' }), respond: () => ({}) });
  assert.equal(out.status, 'no_pi_id');
  assert.equal(calls.length, 0);
});

test('stripe: a test key is refused before any call', async () => {
  await assert.rejects(
    run(STRIPE_SRC, { env: { ...STRIPE_ENV, STRIPE_READ_KEY: 'rk_test_x' }, event: stripeEvent({}), respond: () => ({}) }),
    /not a live Stripe key/
  );
});

// ---------------------------------------------------------------- HubSpot Payments object

test('payments: line item names are written to products_purchased', async () => {
  const { out, calls } = await run(PAYMENTS_SRC, {
    env: { HUBSPOT_PAYMENTS_TOKEN: 'pat-test' },
    event: { object: { objectId: 555 } },
    respond: (url, method) => {
      if (url.includes('/associations/line_items')) return { results: [{ toObjectId: 1 }, { toObjectId: 2 }] };
      if (url.endsWith('/line_items/batch/read'))
        return { results: [{ properties: { name: 'Starter Toolkit', quantity: '1' } }, { properties: { name: 'Starter Toolkit', quantity: '1' } }] };
      return {};
    },
  });
  assert.equal(out.status, 'updated');
  assert.equal(out.products, 'Starter Toolkit');
  assert.equal(out.lineItemCount, 2);
  assert.equal(out.distinctProducts, 1);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/crm/v3/objects/commerce_payments/555'));
  assert.deepEqual(patch.body.properties, { products_purchased: 'Starter Toolkit' });
});

test('payments: no line items yet returns no_line_items and writes nothing', async () => {
  const { out, calls } = await run(PAYMENTS_SRC, {
    env: { HUBSPOT_PAYMENTS_TOKEN: 'pat-test' },
    event: { object: { objectId: 555 } },
    respond: () => ({ results: [] }),
  });
  assert.equal(out.status, 'no_line_items');
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});
