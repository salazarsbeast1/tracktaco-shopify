# V6 test guide

This version retains the Shopify embedded dashboard, 100-order pagination, selection, sorting, and TrackTaco search/reveal.

**It does not automatically assign a destination-matched tracking number to a Shopify customer order.** TrackTaco v2 search/reveal returns carrier shipment inventory metadata, but does not supply a Ship to the Moon shipment/order identifier. Matching city alone cannot verify that a record belongs to the order.

To verify TrackTaco with one credit:
1. Choose the test order in TrackTaco destination lookup.
2. Click free search. Its exact Shopify shipping city and country (and US state) are used automatically.
3. Choose a result; review credit charge and reveal only one.
4. Confirm the carrier, number, reveal outcome and remaining balance.

For the Shopify API test, the existing bulk fulfillment form requires tracking independently verified as belonging to the actual shipment and creates a fulfillment. It must not be used to overwrite the supplier's existing fulfillment. The app does not yet support mapping verified last-mile tracking from the supplier to existing Shopify fulfillment IDs.

Deploy same as existing package: upload the `tracktaco-shopify-v6` folder to GitHub, set Render Root Directory accordingly, deploy. Existing credentials and database apply. Rotate any previously exposed credentials.
