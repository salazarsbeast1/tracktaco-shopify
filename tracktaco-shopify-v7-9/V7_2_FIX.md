# V7.2 Search Diagnostics and Timeout Fix

This release keeps the current V7.1 dashboard and pending verification queue. It increases TrackTaco request timeout from 15 to 40 seconds, adds Accept: application/json, and separates log messages for the Shopify shipping-address lookup and TrackTaco request. It does not use TrackTaco credits during free search. It does not automatically publish unverified tracking to Shopify.

## Deployment
Upload the `tracktaco-shopify-v7-2` folder to your existing GitHub repository. In the existing Render web service change Root Directory to `tracktaco-shopify-v7-2` and redeploy with the same environment variables. Do not create new services.

In Shopify, search the same single order on Home and click free TrackTaco search. If it fails, copy the messages beginning `[tracktaco]` from Render's **web service** Logs (not the database), excluding secrets. Do not use your last credit until the free search works.
