# V5 — city-matched TrackTaco lookup and Shopify tests

Same app, same Render instance and existing Postgres. Upload `tracktaco-shopify-v5` into the existing GitHub repository and point Render Root Directory to `tracktaco-shopify-v5`; deploy latest commit.

**New:** Select an order in the dashboard TrackTaco lookup panel. The app fetches its shipping city and US state directly from Shopify. Search the real TrackTaco API for exact destination city/state (free); review results; explicitly confirm one-credit paid reveal. This lookup does not automatically attach a third-party shipment's tracking number to the order.

**Existing:** Date filters, pagination, multi-order selection, batch tracking import from the actual shipping provider, confirmed Shopify `fulfillmentCreate` mutations. To test a real fulfillment, use one designated test order and tracking that belongs to its actual shipment.

**Security:** Rotate previously exposed TrackTaco, Shopify and database secrets and update Render. Do not commit `.env`.
