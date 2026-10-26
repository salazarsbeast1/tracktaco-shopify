# TrackTaco Manual Fulfillment — Shopify embedded app starter

This is an **add-on to the official Shopify React Router app template**, not a standalone Shopify app. Scaffold the official app first:

```bash
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

Copy the included `app/routes` and `app/services` files into the generated app, replacing `app/routes/app._index.tsx` if present. Set the following in `shopify.app.toml`:

```toml
[access_scopes]
scopes = "read_orders,write_fulfillments"
```

Run `shopify app dev`, then install your development app. No orders are automatically fulfilled. The dashboard loads up to 50 recent *unfulfilled or partially fulfilled* orders, lets you choose exactly two, asks for a second explicit confirmation, and returns a per-order result. The server rechecks each order before processing.

## TrackTaco integration status

The supplied TrackTaco docs URL `https://v2.tracktaco.com/v2/docs.md` could not be read in this environment (web browsing rejected Markdown). Therefore `app/services/tracktaco.server.ts` intentionally **fails closed**. It does not send any API request and does not create Shopify fulfillments. Do not remove the guard until the documented TrackTaco request/response shapes and semantics are verified. The sample integration hook is the ONLY place where a verified TrackTaco API call should be added.

Once verified, production implementation must:
1. Store TrackTaco tokens **on the server**, ideally per-shop encrypted at rest, never in the browser. Use `tt_test_` on a test store first.
2. Implement the documented TrackTaco endpoint(s), passing `Authorization: Bearer ${token}` or documented `x-api-key` from server-side storage.
3. Persist a durable per-shop/per-fulfillment-order idempotency record **before** making any chargeable TrackTaco request. Use a database transaction with unique `(shop, fulfillmentOrderId)` constraints and record remote request IDs and outcomes. Do not automatically retry ambiguous timeouts or partial responses.
4. Only after a confirmed, valid tracking number is returned, invoke Shopify `fulfillmentCreate` for the corresponding fulfillmentOrder with `trackingInfo` and `notifyCustomer` as desired. Use explicit `lineItemsByFulfillmentOrder` to avoid unintended fulfillment of other items.
5. Reconcile Shopify fulfillment creation failures separately from TrackTaco success, instead of creating a second TrackTaco request. Provide manual repair/reconciliation.
6. Validate partial fulfillment, cancellation, fulfillment holds, split locations, carrier and tracking URLs, staff permissions, Shopify API userErrors and TrackTaco `error` fields.

Do not assume that TrackTaco generates legitimate carrier shipments; understand what its service actually does before marking Shopify orders fulfilled.

## Additional details

- Shopify App template: https://github.com/Shopify/shopify-app-template-react-router
- Shopify GraphQL Admin API: https://shopify.dev/docs/api/admin-graphql/latest
- TrackTaco docs (supplied): https://v2.tracktaco.com/v2/docs.md

## Quick connectivity test (new)

The `app.tracktaco-test.tsx` route is accessible from the embedded app at `/app/tracktaco-test` after copying it into the generated Shopify React Router app. Set `TRACKTACO_API_KEY` in the generated app's local `.env` file (do not commit or share it), then restart `shopify app dev`. The route tests only `GET /v2/account`, requiring no credits.

Alternatively the included `scripts/tracktaco-smoke-test.mjs` works **without Shopify** on Node 20+:

```bash
# macOS/Linux terminal: supply your secret to your own local terminal, not this chat
export TRACKTACO_API_KEY='tt_test_YOUR_KEY'
node scripts/tracktaco-smoke-test.mjs account
node scripts/tracktaco-smoke-test.mjs search TX
# PAID: use a valid tn_id from search; credit may be spent
node scripts/tracktaco-smoke-test.mjs reveal tn_PASTE_ID --spend-one-credit
```

`account` validates credentials without charging credits. `search` is free. `reveal` can spend credits and must only be run intentionally. Note: a sandbox `tt_test_` key may not return the same balance or inventory as a live `tt_live_` key.

**The fulfillment dashboard remains guarded and does not write to Shopify.** A TrackTaco inventory tracking number is not proof that a Shopify customer's order was actually shipped. Never use an unrelated tracking number to claim shipment to a real customer. For a dummy Shopify order you can test Shopify fulfillment using a legitimate tracking number for a shipment you control, once the explicit Shopify fulfillment mutation and protections are implemented.
