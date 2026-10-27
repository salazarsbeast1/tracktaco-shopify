# V7.4 bulk retrieval

- Select up to 50 Shopify orders and run free destination searches in batches of ten TrackTaco searches.
- For each order with available records, the first candidate is preselected (not guaranteed to be its actual shipment).
- An explicit credit confirmation reveals candidate records in a bulk TrackTaco API request (maximum 50) and saves valid destination-matched results to the private VA queue.
- The VA reviews actual-shipment correspondence and submits verified rows with one batch button. Shopify updates only existing eligible fulfillments.
- Does not automatically publish unverified tracking or override existing supplier tracking.
- Check TrackTaco credit balance and test 1 order before larger reveal batches. Errors after reveal can be charge-ambiguous; inspect TrackTaco history before retrying.
- This package has not been tested against real Shopify/TrackTaco accounts.
