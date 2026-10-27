# V7.7 — Automatic clearing of published orders from VA queue

- Default **Needs review** view contains PENDING and FAILED tracking only.
- Once Shopify confirms tracking successfully, its record becomes PUBLISHED and automatically leaves the active VA queue on revalidation.
- Added **History (published + removed)** view for completed or archived items.
- Failed Shopify updates remain in Needs review for resolution.
- No Shopify orders or tracking records are deleted; previously published tracking remains unchanged.
- Verified source-level change only; live Shopify deployment still required.
