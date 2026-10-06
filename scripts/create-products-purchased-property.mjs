// create-products-purchased-property.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-08-18 (published 2026-10-06)
// Deploy:  Run once from your computer. README "Variant: HubSpot Payments". Node 20+.
// What:    Creates the custom "Products purchased" property on HubSpot's Payments
//          object.
// Why:     The Payments object does NOT allow custom properties through
//          Settings > Properties in the UI - the Properties API is the only route.
// ---------------------------------------------------------------------------
//
// Usage (PowerShell):
//   $env:HUBSPOT_TOKEN = "<service key with crm.schemas.commercepayments.write>"
//   node scripts/create-products-purchased-property.mjs

const BASE = 'https://api.hubapi.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls the HubSpot API with retry on 429 (rate limit) and 5xx.
async function api(token, path, method = 'GET', body) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${method} ${path} -> ${res.status}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }
  throw lastErr;
}

const TOKEN = process.env.HUBSPOT_TOKEN;
const OBJECT = 'commerce_payments';

const PROPERTY = {
  name: 'products_purchased',
  label: 'Products purchased',
  description:
    'Names of the line items associated with this payment. Set automatically by the product-names workflow.',
  type: 'string',
  fieldType: 'textarea',
};

async function resolveGroup() {
  const { results = [] } = await api(TOKEN, `/crm/v3/properties/${OBJECT}/groups`);
  console.log('Existing property groups:', results.map((g) => g.name).join(', ') || '(none)');

  const preferred =
    results.find((g) => g.name === 'payment_information') ||
    results.find((g) => /payment/i.test(g.name)) ||
    results[0];

  if (preferred) return preferred.name;

  console.log('No group found - creating "custom_payment_properties"');
  const created = await api(TOKEN, `/crm/v3/properties/${OBJECT}/groups`, 'POST', {
    name: 'custom_payment_properties',
    label: 'Custom payment properties',
  });
  return created.name;
}

async function main() {
  if (!TOKEN) throw new Error('Set HUBSPOT_TOKEN to your private app access token');

  // Bail out cleanly if it already exists, so this script is safe to re-run.
  try {
    const existing = await api(TOKEN, `/crm/v3/properties/${OBJECT}/${PROPERTY.name}`);
    console.log(`Property "${existing.name}" already exists (group: ${existing.groupName}). Nothing to do.`);
    return;
  } catch (err) {
    if (!/-> 404/.test(err.message)) throw err;
  }

  const groupName = await resolveGroup();
  const created = await api(TOKEN, `/crm/v3/properties/${OBJECT}`, 'POST', {
    ...PROPERTY,
    groupName,
  });

  console.log(`Created "${created.name}" (${created.fieldType}) in group "${created.groupName}"`);
  console.log('Add it to the Payments record sidebar via Customize record, and as a column in the payments table.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
