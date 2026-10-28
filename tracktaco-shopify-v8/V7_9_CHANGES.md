# V7.9 — Pre-purchase protection

- Bulk free searches skip orders with no Shopify fulfillment, orders that already have tracking, and ambiguous multiple fulfillments. Skips show a reason beside each order.
- Bulk paid reveals re-check each order just before contacting TrackTaco, protecting against changes after the free search.
- Already revealed records in the VA queue are preserved. No database migration is required.
- This version does **not** create fulfillment for a destination-only tracking match. To fulfill an unfulfilled order, first verify a tracking number belongs to its actual shipment and use Shopify's fulfillment-create workflow with correct line items.
- Existing VA verification and updates to eligible fulfillments remain unchanged.
- Not live-tested. Test free search on a small batch before spending credits.
