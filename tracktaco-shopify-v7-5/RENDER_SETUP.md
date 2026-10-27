# Render setup for TrackTaco manual fulfillment (testing)

- Root Directory: `tracktaco-shopify-postgres-ready` if this entire folder is uploaded; adjust to the folder actually used.
- Language: Node, Node >=22.12.
- Build Command: `npm install && npx prisma generate && npm run build`
- Start Command: `npx prisma migrate deploy && npm run start`
- Environment variables: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `TRACKTACO_API_KEY`, `DATABASE_URL`, `NODE_ENV=production`, `SHOPIFY_APP_URL=https://<your-render-host>.onrender.com`, `SCOPES=read_orders,write_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders`.
- In Shopify Dev Dashboard set the App URL to the deployed Render https URL and add correct auth redirect URL(s) for the app, usually `https://<your-render-host>.onrender.com/auth/callback`.
- Note: Shopify app must be installed and authenticated before the embedded UI works.
- The TrackTaco account checker only reads credits. Bulk fulfillment remains intentionally disabled.
- Never upload secrets or `.env` files to GitHub. Rotate exposed credentials.
- The included migrations are intended for a new, empty Postgres database, not an existing populated schema.
