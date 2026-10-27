# V7.5 — Bulk search progress and timeout mitigation

- Search up to 100 selected orders in one run, with five orders per server request.
- Each five-order request performs Shopify destination lookups concurrently and one TrackTaco search API call.
- A progress bar displays processed/total orders and keeps successful results as batches complete.
- Per-order destination errors and TrackTaco request failures remain visible without discarding previous results.
- Stop after current batch is available. Leave the Shopify tab open while searching.
- Paid TrackTaco reveal remains a separate explicit credit-spending confirmation. No bulk credits spent during searches.
- VA verification and Shopify update rules are unchanged.

This is intended for testing; it is not a durable background-job queue. For production runs, use a persisted job scheduler with concurrency limits, retries and idempotency.
