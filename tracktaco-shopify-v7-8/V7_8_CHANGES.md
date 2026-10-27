# V7.8 — Unfulfilled order handling

This update stops the VA approval action from classifying an unfulfilled order as a failed Shopify API update. When a verified tracking record has no existing Shopify fulfillment, it remains PENDING in the VA queue with an “Awaiting supplier fulfillment” result. No new TrackTaco reveal or Shopify fulfillment is created. Once the actual shipment is fulfilled by the shipping provider, the VA can retry the saved record without purchasing tracking again. Split fulfillments and existing supplier tracking retain the existing safeguards.

Deploy using the existing Shopify app and Render service. Set Render Root Directory to `tracktaco-shopify-v7-8`. No schema migration required.

This does **not** create a fulfillment for unfulfilled orders based solely on destination-matched tracking, because that is not sufficient evidence the tracking represents the customer's actual shipment.
