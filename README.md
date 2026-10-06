<!--
  README.md -- Product names on payment records, and routing buyers by product
  Author:  Jibril Sulaiman
  Date:    2026-10-06
  What:    Click-by-click guide for writing what was bought onto every payment record
           in HubSpot (Stripe-synced payments, or HubSpot's own Payments object), then
           routing each buyer into the right product workflow from one master router.
  Why:     HubSpot payment records carry no product field, and Stripe's payment
           description is blank for some payments and free text for the rest, so
           nothing can be reliably reported, nurtured or routed
           by product.
-->

# Product names on payment records, and routing buyers by product

Two connected pieces for selling through Stripe while running follow-up in HubSpot:

1. **Product names.** A workflow custom code action looks up what each payment was
   for (the line items on its Stripe Checkout Session) and writes the product names
   onto the payment record in HubSpot.
2. **Routing.** One master workflow reads those product names and sends each buyer to
   the right product workflow: ticket buyers to one, a course buyer to another, a
   deposit to a third, updating the record and the contact on the way.

Both work on the custom object that **HubSpot's Stripe Data Sync** fills with Stripe
payments. A variant covers HubSpot's own **Payments** object (HubSpot Commerce), which
is where this was first built.

This design mirrors a payment router first built in GoHighLevel. The GoHighLevel
version will be its own repo.

## Why it exists

**HubSpot doesn't know what was bought.**

- **Stripe-synced payments:** HubSpot's Stripe Data Sync copies each PaymentIntent
  into a custom object. A PaymentIntent has no line items. Its `description` is
  whatever the checkout set: an invoice number, a product name with its price, or, for
  some Stripe-hosted checkouts, nothing at all. Data Sync copies the blank faithfully,
  so those payment records say how much, but not what for.
- **HubSpot Payments:** the object has no product property at all, and HubSpot
  doesn't let you add a custom property to it in **Settings → Properties**. The
  product lives only on associated line items, which the payments table can't show.

Without a product on the payment, you can't report revenue by product, start the
right nurture, or tell a ticket buyer from a course buyer in a workflow.

The product names exist in exactly one place: the **line items on the Stripe Checkout
Session** (or, for HubSpot Payments, the associated line items). Neither comes with the
payment. Webhooks don't carry line items either, so an API call per payment can't be
avoided. A workflow custom code action makes that call and writes the answer back.

Once the product is on the record, one **master router** can branch on it instead of
every product workflow re-checking every payment.

## How it works

```text
 Stripe payment ──► HubSpot Stripe Data Sync ──► payment record (description sometimes blank)
                                                    │
                     Workflow A: Product names      │  description is unknown
                     delay 1 min → custom code ─────┤  GET checkout session by payment_intent,
                                                    │  expand line items
                                                    ▼
                              product_name = "VIP Ticket; Order Bump"
                                                    │
                     Workflow B: Master router      │  status is succeeded
                     delay 2 min → branch on product name
                       ├─ Tickets w/ bump ─► edit record ─► go to "Ticket purchase" workflow
                       ├─ Tickets ─────────► edit record ─► go to "Ticket purchase" workflow
                       ├─ Course ──────────► go to "Course purchase" workflow
                       ├─ Deposit ─► branch on source ─► stamp origin, update contact ─► go to "Deposit" workflow
                       ├─ Toolkits ────────► go to "Toolkit purchase" workflow
                       └─ None met ─► end
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/`](workflow-action/) | The two product-names actions: Stripe-synced payments, and HubSpot Payments | Pasted into Workflow A (Step 4, or the variant) |
| [`scripts/`](scripts/) | Creates the `products_purchased` property on HubSpot Payments | Run once (variant only) |
| [`test/`](test/) | Offline tests with Stripe and HubSpot faked | `npm test` |

## Table of contents

- [1. Requirements](#1-requirements)
- [2. Product names on Stripe payments](#2-product-names-on-stripe-payments)
  - [Step 1: Find the payments object and add Product Name](#step-1-find-the-payments-object-and-add-product-name)
  - [Step 2: A restricted Stripe key](#step-2-a-restricted-stripe-key)
  - [Step 3: A HubSpot service key and two secrets](#step-3-a-hubspot-service-key-and-two-secrets)
  - [Step 4: Workflow A, product names](#step-4-workflow-a-product-names)
  - [Step 5: Fill in past payments](#step-5-fill-in-past-payments)
- [3. Variant: HubSpot Payments](#3-variant-hubspot-payments)
- [4. Routing buyers by product](#4-routing-buyers-by-product)
  - [Step 6: One workflow per product](#step-6-one-workflow-per-product)
  - [Step 7: Workflow B, the master router](#step-7-workflow-b-the-master-router)
  - [Step 8: Test the route](#step-8-test-the-route)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Security](#security)
- [Related repos: Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce)

## 1. Requirements

| Need | Why |
|---|---|
| HubSpot with workflow custom code (Operations Hub / Data Hub Professional or above at the time of writing) | Workflow A |
| HubSpot's Stripe Data Sync, syncing payments into a custom object | The records Workflow A enriches (skip for the HubSpot Payments variant) |
| Stripe access that can create restricted keys | Step 2 |
| Node.js 20 or later | Only for the variant's property script and the tests |

## 2. Product names on Stripe payments

### Step 1: Find the payments object and add Product Name

About 5 minutes.

**1a.** Find the custom object Stripe Data Sync writes payments into (for example
"Stripe Payment Transactions"). Its sync settings (**Stripe Payment Transaction
sync**: **Configure · Limit · Organize · Review**) show the direction, Stripe →
HubSpot, one way, and **Record matching**, typically **Do no matching** (wording may
differ). Copy its type id (`2-12345678`) from the URL of its
records page, and paste it as `OBJECT_TYPE` at the top of
[`workflow-action/stripe-payment-product-names.js`](workflow-action/stripe-payment-product-names.js).

**1b.** Check two synced properties exist, and note their internal names:

| Synced property | Holds | The code's input name |
|---|---|---|
| **Stripe Payment Transaction ID** | The PaymentIntent id, `pi_...` | `stripe_payment_transaction_id` |
| **Description** (`description`) | Stripe's description; blank for some checkouts | `description` |

**1c.** Add one property in **Settings → Properties**, on that object:
**Product Name**, internal name `product_name`, **Single-line text**.

✅ **Check:** the object has Stripe Payment Transaction ID, Description and Product
Name, and `OBJECT_TYPE` is set.

### Step 2: A restricted Stripe key

About 3 minutes.

**2a.** In Stripe (live mode), **Developers → API keys → Restricted keys → Create
restricted key**.

**2b.** At *"How will you be using this key?"* choose **Powering an integration you
built**, **Continue**, then **Choose your own →**.

**2c.** Set **Checkout Sessions** to **Read**. Leave everything else at **None**.
Create it and copy the `rk_live_...` key.

> ⚠️ **Live key only.** A test key signs in fine, then finds no session for any live
> payment, which would quietly leave every product blank. The action refuses keys
> that don't start with `rk_live_` or `sk_live_`.

✅ **Check:** an `rk_live_` key with one permission, Checkout Sessions: Read.

### Step 3: A HubSpot service key and two secrets

About 5 minutes.

**3a.** In HubSpot's **Service Keys** page, click **Create service key**. On **Create Service
Key**, enter a **Name** (*"It must be unique to this account."*), then under **Scopes**
click **Add new scope** for each scope below, and click **Create**. Name it for this job (for example `Update Purchase w/ Product
Info`) and add `crm.objects.custom.read` and `crm.objects.custom.write`. The key's page
then lists its **Scopes**, with **Rotate**, **View Logs** and **Edit**.

> ⚠️ **Give this action its own key.** In production the first version fell back to
> another integration's secret when its own wasn't attached. That key was valid, so it
> signed in and then failed with a 403 that looked like a missing scope. The code now
> only accepts its own secret names and logs which one it used.

**3b.** Create two secrets (from the custom code action's **Secrets** dropdown in Step
4, or in your secrets settings), named exactly:

| Secret | Value |
|---|---|
| `HUBSPOT_PAYMENTS_TOKEN` | The service key from 3a |
| `STRIPE_READ_KEY` | The restricted key from Step 2 |

✅ **Check:** both secrets exist with those names.

### Step 4: Workflow A, product names

About 10 minutes.

**4a.** **Automation → Workflows → Create workflow → From scratch**. Object type: your
Stripe payments object. Name it, for example, `Update Purchase w/ Product Info -
Stripe Payments Object`.

**4b. Trigger.** Set it to enroll records that meet custom conditions, with the
condition **Description is unknown**. Turn on **Re-enroll**. A payment whose Stripe
description is already set doesn't need the lookup.

> The trigger panel offers **Manually triggered** alongside **Records meet custom
> conditions**; keep both, so you can also enroll past payments by hand (Step 5).

**4c. Delay.** Add **Delay** → **1 minute**, so the synced record is complete before the
lookup.

**4d. Custom code.** Click **+**, choose **Custom code**.
1. **Language:** Node.js 20.x
2. **Secrets:** `HUBSPOT_PAYMENTS_TOKEN` and `STRIPE_READ_KEY`
3. **Property to include in code:**

   | Input name (left box) | Value (right box) |
   |---|---|
   | `stripe_payment_transaction_id` | **Stripe Payment Transaction ID** (enrolled record) |
   | `description` | **Description** (enrolled record) |

4. Delete the sample code and paste in **all** of
   [`workflow-action/stripe-payment-product-names.js`](workflow-action/stripe-payment-product-names.js).
5. **Data outputs:**

   | Output | Type |
   |---|---|
   | `products` | String |
   | `lineItemCount` | Number |
   | `distinctProducts` | Number |
   | `status` | String |

   An output only shows up when it's defined in **both** the code and this form; until
   then **Test action** lists it as *"Not defined in code"*.

**4e. Test action.** At the bottom of the custom code panel, open **Test action**, pick a
recent payment made through a Stripe Checkout or Payment Link, and click **Test**.

> ⚠️ **A test edits the real record.** HubSpot says so: *"Changes will be applied to your
> payment."* That's harmless here (it writes the product name the workflow would write
> anyway), but test on a payment you don't mind changing.

Success: **Status** *Success*, `status: updated` and `products` listing what was
bought. **Logs** show `using secret: HUBSPOT_PAYMENTS_TOKEN` and
`record ... : N line item(s) -> "..."`, plus memory and runtime.

| `status` | Meaning |
|---|---|
| `updated` | `product_name` and `description` written |
| `updated_name_only` | Stripe already had a description; only `product_name` written. A real Stripe description is never overwritten. |
| `no_session` | No Checkout Session: an invoice or subscription payment. Stripe already describes those, so nothing is missing. |
| `no_products` | A session with no named line items |
| `no_pi_id` | The record has no PaymentIntent id |

> ⚠️ **Duplicate line items collapse to one.** Some checkouts write two identical line
> items seconds apart. The code groups by name and keeps the largest quantity, so
> "Toolkit; Toolkit" never happens. The tradeoff: a genuine order of two separate rows
> of the same product reads as x1. If `lineItemCount` and `distinctProducts` never
> differ in your run history, switch `Math.max` to addition in `summarize`.

**4f.** Turn the workflow on.

✅ **Check:** a new payment gets a **Product Name** about a minute after it syncs.

### Step 5: Fill in past payments

About 5 minutes. The workflow only sees payments from when it went live. For older
ones, use the workflow's **Enroll** button (top right) and enroll records whose
Description is unknown. The same action fills them in.

✅ **Check:** filter the payments table by Product Name **is unknown** and Status
**succeeded**: what's left should be invoices and subscriptions.

## 3. Variant: HubSpot Payments

If you take payments through HubSpot Commerce instead (the **Payment** object), the
product names come from the payment's associated line items, not from Stripe.

**V1. Create the property.** HubSpot doesn't allow custom properties on Payments in
the UI. Two ways, both needing `crm.schemas.commercepayments.write` on the key:

*From inside HubSpot (no terminal; how it was first done).* Build the workflow in V2,
but paste **all** of
[`workflow-action/create-products-purchased-property-action.js`](workflow-action/create-products-purchased-property-action.js)
into the custom code action first, and run **Test action** once. The logs read
*"Created property "products_purchased" (textarea) in group "..."* and *"Now replace
this code with hubspot-payments-product-names.js and re-test."* Then do exactly that.

*From your computer:*

```powershell
$env:HUBSPOT_TOKEN = "<service key>"
node scripts/create-products-purchased-property.mjs
```

Runs [`scripts/create-products-purchased-property.mjs`](scripts/create-products-purchased-property.mjs).

It creates **Products purchased** (`products_purchased`, multi-line text) in a payment
property group and is safe to re-run (*"already exists ... Nothing to do."*). Then add
it as a column in the payments table and to the record via **Customize record**.

**V2. The workflow.** Object type **Payment**. Trigger: **Status is any of Succeeded**.
Add a **Delay** (1 minute), then a **Custom code** action, Node.js 20.x, secret
`HUBSPOT_PAYMENTS_TOKEN` (scopes `crm.objects.commercepayments.read`,
`crm.objects.commercepayments.write`, `crm.objects.line_items.read`). It needs no
inputs. Paste **all** of
[`workflow-action/hubspot-payments-product-names.js`](workflow-action/hubspot-payments-product-names.js),
with the same four outputs as Step 4d.

> ⚠️ **Line items arrive a beat after the payment.** That's what the delay is for. If
> runs still return `no_line_items`, lengthen it.

> ⚠️ **Republish after changing the code.** In production a fixed action kept failing
> with *"The custom code threw an error..."* in the action logs because the workflow
> was still running the old published version.

> ⚠️ **What it doesn't tell you.** Line items keep the list price while the payment
> holds what was actually charged (after any discount). Products purchased says what
> was bought, not what it sold for.

✅ **Check:** a new payment shows **Products purchased**.

## 4. Routing buyers by product

### Step 6: One workflow per product

About 10 minutes per product.

**6a.** For each product line (tickets, a course, a deposit, toolkits...), build the
workflow that does that product's follow-up. A production example:

1. **Trigger:** **Manually triggered only**, with **Re-enroll on** so a repeat buyer
   runs again.
2. **Delay:** 1 minute.
3. **Branch** on the product field for the plan bought (for example **Pay In Full**,
   **Payment Plan**, **Member Payment**, then **None met**).
4. **Send email** on each path, to *associated contacts labeled* "The associated
   contact": the confirmation for that plan.

**6b.** Create them on the **same object type as the router** (the Stripe payments
object, or Payment). The router's **Go to workflow** action only lists workflows of
the same type (*"Only showing workflows of the same type."*).

**6c.** Give them no automatic enrollment trigger (manual only), so the router is the
only way in. A product workflow with its own trigger would run twice.

✅ **Check:** one workflow per product, same object type, manual enrollment.

### Step 7: Workflow B, the master router

About 30 minutes.

**7a.** Create a workflow on the same object, for example `1. Master Payment Routing`.

**7b. Trigger.** Only enroll records that meet: **Status is any of Succeeded** (on
Stripe payments, `Status` is `succeeded`). On Stripe payments, also requiring **Product
Name is known** is a safe addition: the router then can't start before Workflow A has
written the product.

**7c. Delay.** **Delay → 2 minutes**. Workflow A waits 1 minute and then writes the
product; the router must start after that.

**7d. The product branch.** Add **Branch**, branch on **conditions**. Branches are
checked **in order, and the first match wins**. Add one branch per product line, each
on the product field (**Product Name** on Stripe payments, **Products purchased** on
Payments):

| Branch (in this order) | Condition | Then |
|---|---|---|
| Tickets w/ bump | contains any of your ticket names **and** contains your order-bump name | Edit record → Go to workflow: ticket purchase |
| Tickets | contains any of your ticket names | Edit record → Go to workflow: ticket purchase |
| Course | contains a keyword, for example `accelerator` | Go to workflow: course purchase |
| Coaching | contains `circle` | Go to workflow: coaching payment |
| Deposit / enrollment | contains any of your deposit and plan names | Branch on source (7e) |
| Toolkits / upsells | contains any of your kit and upsell names | Go to workflow: toolkit purchase |
| None met | — | End |

> ⚠️ **Put the most specific branch first.** "Tickets" matches every order that
> "Tickets w/ bump" matches, so bump orders only reach their branch if it comes first.
> In the first production build the bump branch sat after Tickets, so it could never be
> reached.

> ⚠️ **Full names or keywords.** Listing exact product names (*"contains any of"*)
> never matches the wrong product, but a renamed or new product silently falls to
> **None met**. A keyword (`accelerator`) survives renames but can catch a product you
> didn't mean. Use exact names for products that share words (tiers of a ticket), and
> keywords for one-of-a-kind products. Check the **None met** count after every launch.

**Optional: a Product Category dropdown.** Instead of matching product names in every
branch, add a **Product Category** dropdown on the payments object (one option per
product line) and branch on it. Fill it for past payments with a CSV import into the
payments object (**Update records**), matching on **Record ID** and mapping your
category column to **Product Category** (wording may differ).

**7e. Split one product by where the payment came from (optional).** For a deposit
taken through two channels, add a second **Branch** under it on a source field (for
example **Source ID** *is equal to any of* the id of each payment link or form). In each
path:
1. **Edit record**: set a property such as **Deposit Origin** to the channel.
2. **Edit record**: set **Lead Status** on the associated contact (the edit action can
   target *associated contacts*, filtered by association label).
3. **Go to workflow**: the deposit workflow.

**7f. The edits before a handoff.** On the ticket paths, an **Edit record** step can
stamp the payment (for example a status or category) before **Go to workflow**, so the
product workflow and reports can rely on it.

**7g. The handoff.** **Go to workflow** → **Enroll in** → the product workflow. It
*"will bypass any enrollment triggers set"*, and *"if the enrolled payment is on a
suppression segment for the selected workflow, it won't be enrolled."*

**7h.** Review and turn on.

✅ **Check:** every branch ends in a Go to workflow or an End, and the branches are in
specific-to-general order.

### Step 8: Test the route

About 5 minutes per product.

**8a.** Buy one of each product line (or enroll a recent real payment of each through
the router's **Enroll** button).

**8b.** Open the router's **Enrollment history**, pick the run, and read **Logs of one
run**. A routed payment reads, in order: *Triggered from: Records match criteria* →
*The delay has started* → *Completed delay* → *Continuing on the "<branch>" branch* →
*Started run in other workflow* → *Completed workflow*.

**8c.** Open the product workflow's **Enrollment history**: the run's first log line
reads *"Run started by another workflow: 1. Master Payment Routing"*, followed by its own
delay, branch and *"Email sent to contact"*.

✅ **Check:** each product lands in its own workflow, and an unknown product ends on
**None met**.

## Troubleshooting

| You got | Cause | Fix |
|---|---|---|
| `No Stripe key found. Add a secret named STRIPE_READ_KEY ...` | Secret missing or named differently | Step 3b |
| `... is not a live Stripe key` | Test key | Step 2 |
| `PATCH /crm/v3/objects/... -> 403. Check the credential and its scopes.` | Service key lacks custom-object read/write | Step 3a |
| `No token secret found ...` | Secret not ticked on the action | Step 4d |
| Every payment `no_session` | Payments made outside Checkout (invoices, subscriptions, dashboard charges) | Expected; nothing to fix |
| `Property "products_purchased" does not exist` (variant) | Property not created | V1 |
| `... associations/line_items ... -> 403` (variant) | Key lacks commerce payments / line items scopes | V2 |
| Router sends bump orders to Tickets | Branch order | Step 7d |
| A new product never routes | Not in any branch's list | Step 7d; check None met |
| Router runs before the product is written | Delay too short, or trigger not requiring Product Name | Steps 7b-7c |
| A product workflow runs twice | It has its own enrollment trigger | Step 6c |

## Limits

- **Checkout-based payments only.** Invoices, subscriptions and dashboard charges have
  no Checkout Session, so Workflow A can't name them (Stripe already describes them).
- **One API call per payment**, inside the 20-second custom code limit; the code
  retries 429s and 5xx with backoff.
- **Product names are text.** Routing on "contains" depends on stable product names in
  Stripe. Renaming a product in Stripe changes what new payments say.
- **No alerting is built in.** Watch the router's **None met** count, or add your own
  alert for payments that end there.

## Security

- **Restricted Stripe key, one permission** (Checkout Sessions: Read).
- **Service key per job**, with only the scopes in Step 3a; never reuse another
  integration's secret as a fallback.
- **No secrets in code.** The actions read them from HubSpot secrets and log only the
  secret's name, never its value. Anyone who can edit a custom code action can use its
  secrets, so limit who can edit these workflows.

## Related repos: Stripe beyond HubSpot Commerce

This repo is one of a set of guides for taking Stripe payments without HubSpot
Commerce, and for getting the Stripe data that HubSpot's native Stripe
integration leaves out into HubSpot. Each one stands alone.

| Repo | What it adds |
|---|---|
| [hubspot-order-form-stripe-checkout-link-integration](https://github.com/carljibrilsulaimanii/hubspot-order-form-stripe-checkout-link-integration) | UTM attribution end to end: keeps UTMs across pages when HubSpot form redirects drop them, passes them through a HubSpot order form to a Stripe Payment Link and back to the checkout success page, and writes them onto the payment record |
| [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) | Any Stripe event into a HubSpot workflow through the "Webhook event is received" trigger, no middleware |
| [hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google) | Stripe purchases sent server-side from HubSpot workflows to Meta and Google |
| [hubspot-stripe-zero-dollar-checkout-sync](https://github.com/carljibrilsulaimanii/hubspot-stripe-zero-dollar-checkout-sync) | Free and 100%-off Stripe Checkout orders, which create no payment, written into a HubSpot custom object, plus a backfill |
| **hubspot-stripe-payment-product-names-and-routing** (this repo) | Which product each Stripe payment was for, written onto the payment record, and a master workflow that routes buyers by product |
| [stripe-test-mode-to-hubspot-payment-mirror](https://github.com/carljibrilsulaimanii/stripe-test-mode-to-hubspot-payment-mirror) | Stripe test-mode payments in the same HubSpot object as live ones, so payment workflows can be tested without real charges |

---

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
