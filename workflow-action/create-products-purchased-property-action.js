// create-products-purchased-property-action.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-08-18 (published 2026-10-06)
// Deploy:  ONE-OFF custom code action, pasted temporarily into the product-names
//          workflow on the Payment object (README "Variant: HubSpot Payments", V1).
// What:    Creates the products_purchased property on HubSpot's Payments object,
//          then you replace it with hubspot-payments-product-names.js.
// Why:     No Node or terminal needed - the property is created from inside HubSpot.
// ---------------------------------------------------------------------------
//
// Custom properties cannot be added to Payments via Settings > Properties -
// the Properties API is the only route, hence this detour.
//
// Requires the service key to also have: crm.schemas.commercepayments.write
// Safe to run more than once - it exits early if the property already exists.

const OBJECT = 'commerce_payments';
const PROPERTY = {
  name: 'products_purchased',
  label: 'Products purchased',
  description:
    'Names of the line items associated with this payment. Set automatically by the product-names workflow.',
  type: 'string',
  fieldType: 'textarea',
};

async function hs(token, path, method = 'GET', body) {
  const res = await fetch('https://api.hubapi.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

exports.main = async (event, callback) => {
  const token = process.env.HUBSPOT_PAYMENTS_TOKEN || process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error('No token secret attached to this action');

  // Already there? Nothing to do.
  try {
    const existing = await hs(token, `/crm/v3/properties/${OBJECT}/${PROPERTY.name}`);
    console.log(`Property "${existing.name}" already exists in group "${existing.groupName}".`);
    return callback({ outputFields: {} });
  } catch (err) {
    if (!/-> 404/.test(err.message)) throw err;
  }

  // Property creation requires a group, so resolve one first.
  const { results = [] } = await hs(token, `/crm/v3/properties/${OBJECT}/groups`);
  console.log('Existing groups:', results.map((g) => g.name).join(', ') || '(none)');

  let groupName = (
    results.find((g) => g.name === 'payment_information') ||
    results.find((g) => /payment/i.test(g.name)) ||
    results[0] ||
    {}
  ).name;

  if (!groupName) {
    const created = await hs(token, `/crm/v3/properties/${OBJECT}/groups`, 'POST', {
      name: 'custom_payment_properties',
      label: 'Custom payment properties',
    });
    groupName = created.name;
    console.log(`Created group "${groupName}"`);
  }

  const created = await hs(token, `/crm/v3/properties/${OBJECT}`, 'POST', {
    ...PROPERTY,
    groupName,
  });

  console.log(`Created property "${created.name}" (${created.fieldType}) in group "${created.groupName}"`);
  console.log('Now replace this code with hubspot-payments-product-names.js and re-test.');

  callback({ outputFields: {} });
};
