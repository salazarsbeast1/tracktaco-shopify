# Trackflow V11 — 500-order bulk search and VA handoff

## What changed

- Select up to **500 matching Shopify orders with one button**, or select orders across the existing 100-order pages.
- Free TrackTaco search runs in **five-order requests**, with up to three concurrent search workers and visible progress. One failing group does not prevent other groups from completing.
- Automatically chooses **one unique tracking candidate per order** from free search results. No individual "Review records" buttons or long per-order candidate table.
- Removes the redundant **"TrackTaco destination lookup · real API test"** block from the main dashboard. The independent diagnostics page remains available.
- **Confirm paid reveal & send to VA queue** is the single action after searching. Its button and adjacent message show the maximum estimated TrackTaco credits; there is **no extra browser confirmation popup**.
- Splits paid reveals into **up to 25 candidates per request**, automatically continues until all eligible selected candidates are processed (maximum 500 selected orders), and reports completed/queued/skipped counts.
- Invalid orders, duplicate orders, duplicate candidates, already-tracked orders, previously queued/revealed records, and other failed Shopify preflight checks are skipped independently **before TrackTaco reveal**. Previously processed orders cannot accidentally purchase a second candidate.
- Shopify/TrackTaco failures in one batch do not discard already queued successes; uncertain credit-spend failures are not automatically retried. Consult TrackTaco history before manually retrying.
- VA verification now loads up to 2,000 recent records so a 500-order queue is visible; VA approval/rejection is limited to **100 inspected shipments per submission** to avoid timeouts.
- Version badge reads **V11 · 500-order VA queue**.
- Added pure planner unit tests in `tests/bulk-planner.test.ts`.

## Explicit safety boundary

TrackTaco destination results are **candidates only**, not evidence that the number belongs to an order's actual shipment. This update does not auto-fulfill orders or send tracking to customers. Before Shopify is updated, the VA must verify each shipment using independent carrier/supplier evidence and explicitly approve its tracking; the previous safeguards remain.

## How to deploy

The folder name **`trackflow-shopify-v10` is preserved intentionally** so existing project/repository root paths do not break. Use the edited folder contents to update the existing deployed TrackTaco Shopify app (typically GitHub → Render), redeploy, and hard-refresh the Shopify embedded app. **Uploading the ZIP to ChatGPT does not publish changes.**

For a quick offline planner test:

```sh
node --experimental-strip-types --test tests/bulk-planner.test.ts
```

Before paying for a real batch, test 5 orders, then 25, then 100. Check TrackTaco balance, queue counts, and duplicate handling. The package has been edited and pure logic tests run locally; Shopify/TrackTaco live credentials and production environment were not available for an end-to-end test.
