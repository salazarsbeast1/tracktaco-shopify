# TrackTaco Shopify V7.6 — VA verification redesign

This is a drop-in replacement for V7.5 using the same GitHub repo, Shopify app, Render web service, and PostgreSQL database.

## New on VA Bulk Verification

- Shopify-style, denser table with status pills and clearer columns.
- Remove individual record from VA queue using each row's **Remove** button.
- **Remove selected** archives selected pending/failed records after confirmation. Removal does **not** delete Shopify orders or change any tracking already published in Shopify.
- **Select all visible** and **Clear** selection.
- **Mark all visible reviewed** checks the shipment-reviewed controls for the visible pending/failed records; use only after actual shipment verification.
- **Verify selected & Update Shopify** submits up to 100 selected, reviewed records in one batch after the user affirms actual shipment association.
- Existing `PUBLISHED` rows remain viewable and can be archived individually.
- Existing status filter and Shopify tracking protections are preserved.

## Deployment

1. Unzip the archive.
2. Upload the folder `tracktaco-shopify-v7-6` to your existing GitHub repository.
3. In Render, change Root Directory to `tracktaco-shopify-v7-6`.
4. Redeploy using the same environment variables. No schema migration is needed for this UI change.
5. Open Shopify > TrackTaco Fulfillment > VA Bulk Verification.

## Limitations

- The **Mark all visible reviewed** control is a convenience, not independent evidence that a shipment matches tracking. The operator remains responsible for examining each selected shipment.
- Shopify updates still require exactly one existing fulfillment per order and never silently replace existing supplier tracking.
- The app is not automatically live-tested against your stores by producing this ZIP.
