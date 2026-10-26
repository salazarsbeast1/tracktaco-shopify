# TrackTaco Shopify V4 — streamlined batch review

## What changed
- Existing Shopify order filters (date range, status, search), 100-order pagination and cross-page selection retained.
- Replaced repetitive per-order tracking inputs with a single pasted CSV-style batch import (`Order,Tracking,Carrier`).
- Matches rows by Shopify order name/number and shows unmatched orders before submission.
- One checkbox confirms actual Ship to the Moon shipments and tracking correspondence for the entire batch.
- Existing authenticated Shopify GraphQL fulfillment mutation retained; it only runs if every selected order has a corresponding imported shipment tracking number.
- TrackTaco account/search/reveal testing page retained separately and does not attach unrelated carrier records to Shopify orders.

## Deploy to existing Render service
1. Unzip and upload the `tracktaco-shopify-v4` folder into the root of the existing GitHub repository.
2. In Render, update the existing service's Root Directory to `tracktaco-shopify-v4` and deploy latest commit.
3. Keep existing Render environment variables and Shopify URL. Rotate any previously exposed credentials.
4. Test with one dummy Shopify order and the corresponding actual shipment tracking.

## Caution
The update has not been tested against a live Shopify store. It does not automatically associate TrackTaco inventory tracking numbers with a customer order because TrackTaco searches do not prove shipment ownership.
