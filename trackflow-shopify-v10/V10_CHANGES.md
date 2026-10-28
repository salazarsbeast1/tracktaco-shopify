# Trackflow V10 — verifiable deployment

- V9 already changed TrackTaco search and reveal to accept unfulfilled orders.
- V9 also added Shopify `fulfillmentCreate` for VA-approved records that have one eligible fulfillment order.
- V10 adds a visible `V10 · Unfulfilled orders enabled` label in the Shopify dashboard header, so you can tell whether your running deployment updated.
- VA fulfillment order line-item eligibility query now checks up to 100 items (previously 2).
- Rejects creation if tracking number is empty.
- Preserves the new Trackflow.ai green gradient logo.

## Deployment
Uploading a ZIP in chat does not deploy changes to Shopify. Replace your project source in GitHub / deployment service, rebuild and redeploy, and hard-refresh the embedded Shopify app. Confirm the V10 label appears in the header.

## Safety
Only click VA approval if you have independently verified tracking belongs to the customer's actually dispatched shipment. A city/destination match alone is not sufficient.
