# TrackTaco Shopify V3 — Existing App Update

This is a complete React Router Shopify app with PostgreSQL. Upload the contents as a **new root folder** `tracktaco-shopify-v3` in the *existing* GitHub repository, set the existing Render Web Service Root Directory to `tracktaco-shopify-v3`, and redeploy. You do NOT create a new Shopify app or new service. Retain environment variables and Shopify app URL.

## Updated interface
- Order list: 100/page, next-page navigation, selection retained across pages within the current browser page session, 150/order confirmation batch, dates newest/oldest, status and date range filters, order-number search.
- Fulfillment: actual Shopify fulfillmentCreate for verified shipment tracking numbers on explicit manual approval. Shopify is queried again before each fulfillment; customers are not auto-notified. Use a dummy order with tracking belonging to your own shipment for live tests.
- TrackTaco tests: authenticated balance check (free), free carrier/destination search, optional ONE paid reveal with a separate confirmation. Revealed numbers are not automatically assigned to Shopify orders.

## Important
Tracking numbers obtained from TrackTaco's pool are not necessarily associated with a selected Shopify order. A match by city or date is not proof of shipment ownership. The application intentionally does not connect unrelated tracking to customer fulfillment. The Shopify fulfillment form requires tracking from a verified actual shipment.

The code is an implementation starter and has not been live-tested with your store credentials. Use a designated test order first. GitHub ZIP contents should not include any `.env` file or secrets. Keep rotated credentials in Render only.
