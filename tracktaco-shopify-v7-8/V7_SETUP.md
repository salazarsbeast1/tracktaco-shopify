# V7 — Bulk verification queue

This version extends V6 with PostgreSQL-backed TrackTaco pending records and an in-app VA Bulk Verification page.

1. Upload the **contents** of `tracktaco-shopify-v7` (or the entire folder) to the same GitHub repository.
2. On your existing Render service, set Root Directory to `tracktaco-shopify-v7` (if uploaded as a folder). Keep existing secrets and database.
3. Build: `npm install && npx prisma generate && npm run build`.
4. Start: `npx prisma migrate deploy && npm run start`.
5. Deploy and open Shopify Admin → Apps → TrackTaco Fulfillment → Home.
6. Search by an order destination for free. Confirm one reveal to spend one TrackTaco credit. When the API returns a successful reveal, the record is saved in the pending queue.
7. Open VA Bulk Verification. Provide shipment evidence for each record and select approved records, then click Verify & Update Shopify once.

## Safety and behavior

- TrackTaco's API supplies destination and carrier metadata but no proof that a number belongs to this particular Shopify order. Do not approve a record without independently establishing shipment ownership.
- Revealing charges credits. Search and queue viewing do not.
- Shopify tracking updates require an existing fulfillment. An unfulfilled test order cannot be updated by `fulfillmentTrackingInfoUpdate`.
- This implementation conservatively refuses to overwrite supplier tracking automatically, and refuses orders with multiple fulfillments.
- Verified entries update existing fulfillments only. Shopify API user errors appear per record. Rejected items remain in the database.
- This package has not been live-tested against your keys/store. Test on one controlled shipment first.
- Previous screenshots exposed secrets; rotate any exposed keys/passwords before deploying.
