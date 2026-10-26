# TrackTaco Fulfillment – Shopify embedded app (testing build)

This combines Shopify’s official React Router template with the supplied TrackTaco test kit. It is **not yet a production fulfillment integration**.

### Working features in the code
- Shopify embedded authentication foundation (requires actual app credentials and deployment)
- Lists recent unfulfilled orders and permits selection of exactly two with confirmation
- Read-only TrackTaco connection test (`/app/tracktaco-test`) via `GET /v2/account`, including balance
- Live TrackTaco reveal and Shopify fulfillment are deliberately **disabled**; no orders will be fulfilled by this build

### IMPORTANT before deploying to Render
- This project uses **SQLite** for Shopify sessions by default. Render's free service has an **ephemeral filesystem**; sessions will be lost on restart/sleep. Use a persistent database (e.g. Postgres with updated Prisma provider/migrations) for any dependable use, especially before live orders.
- The Shopify app must have a valid production HTTPS URL. Replace `https://example.com` in your Shopify Dev Dashboard with the actual hosted URL, and set any required redirect URIs.
- Supply credentials ONLY as private Render environment variables; do not place secrets in GitHub.
- The Shopify Dev Dashboard app **client ID and secret** are distinct from the TrackTaco key.
- The initial Render deploy and Shopify OAuth flow still need to be tested; a ZIP alone is not a deployed app.

### Render test configuration (after env vars and Shopify URLs are configured)
- Language: Node, Node.js >= 22.12
- Root Directory: blank **when uploading this ZIP's contents directly at the repository root**
- Build command: `npm install && npx prisma generate && npm run build`
- Start command: `npx prisma migrate deploy && npm run start`
- Environment variables (server-side; values must be set in Render UI):
  - `SHOPIFY_API_KEY` = Client ID in Shopify Dev Dashboard
  - `SHOPIFY_API_SECRET` = Client secret in Shopify Dev Dashboard
  - `SHOPIFY_APP_URL` = `https://YOUR-RENDER-HOST.onrender.com`
  - `SCOPES` = `read_orders,write_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders`
  - `TRACKTACO_API_KEY` = your `tt_test_...` key (or live key when you explicitly choose)
  - `NODE_ENV` = `production`
- Only enter these values in Render's **Environment** section, never in code or repository files.

### How to upload the merged package
Extract the ZIP on your Mac. Open the resulting `tracktaco-shopify-complete` folder, select **all files and folders inside** (not the enclosing folder), and drag the contents into the GitHub **Add file → Upload files** screen. After upload, `package.json` and `app/` must appear **at the top level** of the repository (next to `.gitignore`). If you see an enclosing `tracktaco-shopify-complete` directory instead, Render's root path must be adjusted accordingly.

For a GitHub repository already containing an earlier `tracktaco-shopify/` folder, that folder is an obsolete partial starter; the new top-level files take precedence. Remove the old folder later to avoid confusion.

### Key safety limitation
TrackTaco's documented `search`/`reveal` endpoints find and disclose carrier tracking numbers from TrackTaco inventory, not shipping labels or a fulfillment service. An arbitrary tracking number must not be attached to an unrelated real customer order. The unfinished fulfillment route intentionally fails closed.
