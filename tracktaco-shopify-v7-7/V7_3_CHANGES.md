# V7.3 changes

- Bulk free-search for up to 30 selected orders using the exact shipping city/state/country read from Shopify. One TrackTaco API request contains multiple searches.
- Searches display results per order; reviewing one makes records available in the existing paid-reveal section. No credits spent automatically.
- VA verification no longer requires typed tracking numbers or reference text. Each record must be inspected and checked individually, followed by a single batch acknowledgement and Verify & Update Shopify action.
- Shopify tracking mutation still requires an existing fulfillment, won't overwrite pre-existing tracking, and VA confirmation must represent genuine verification against the corresponding shipment.
- This has not been deployed or live tested. Begin with a few test orders and free search.
