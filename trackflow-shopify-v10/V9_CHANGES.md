# Trackflow.ai V9 — Unfulfilled Shopify orders

- Free bulk TrackTaco search now permits orders with no Shopify fulfillment.
- Paid reveal and VA queue now permit unfulfilled orders. Credit protection against existing shipment tracking remains active.
- VA approval supports creation of the FIRST Shopify fulfillment for an order with exactly one open, unsubmitted fulfillment order, attaching verified tracking.
- Existing fulfillments without tracking still use the tracking-update path. Orders with multiple existing fulfillments, multiple fulfillment orders, holds or unsupported fulfillment requests require manual handling to avoid incorrect shipments.
- VA must attest each tracking number belongs to the actual shipment. A destination match alone is never shipment proof. Customer notification is disabled for newly created fulfillments.
- Updated header to the newly supplied Trackflow.ai transparent green-gradient logo.
- Deployment: use existing project deployment process, reauthorize Shopify if scopes change, and test with a genuine shipped-but-unfulfilled order before processing a bulk batch.
