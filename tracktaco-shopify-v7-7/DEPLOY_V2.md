# V2 bulk dashboard deployment

1. Upload **the contents** of this folder (not the enclosing folder) to the existing GitHub root, or upload it as a new folder and update Render Root Directory accordingly.
2. Render Build Command: `npm install && npx prisma generate && npm run build`; Start: `npx prisma migrate deploy && npm run start`.
3. Environment: `SHOPIFY_APP_URL`, `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `TRACKTACO_API_KEY`, `SCOPES`, `NODE_ENV`.
4. Confirm Shopify app permissions include `write_merchant_managed_fulfillment_orders`.
5. Test **only on a test order** with tracking belonging to a real shipment you control. No automatic TrackTaco inventory-to-order matching; the TrackTaco connection test remains separate. Shopify API can actually mark orders fulfilled, so do not test on live customer orders.
6. Orders paginate in 100-record pages with selection persisting across navigation; limit 150 per fulfillment submission to reduce timeouts. This is not an unlimited single HTTP batch; you can repeat batches.

**Caution**: Partial failures are possible if one Shopify fulfillment succeeds and another fails. Check per-order results. Further hardening (job queue, durable idempotency, permissions/locations) is needed for production-scale bulk fulfillment.
