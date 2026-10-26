# V7.1 – fixes Home-page TrackTaco search GraphQL parsing

In V7 the Home action had `#graphql query...` on a single line. GraphQL treats text after `#` as a comment, causing `Syntax Error: Unexpected <EOF>` when Shopify receives the empty query. V7.1 inserts a newline after `#graphql` in affected Home and verification GraphQL operations. The working free TrackTaco test page is unchanged.

No credit spending occurs on search. To deploy: upload this whole folder into your existing GitHub repository, set Render root directory to `tracktaco-shopify-v7-1`, and deploy. Run Home search for the selected test order before any reveal.

The reveal flow stores a pending review and does not add tracking directly to Shopify until verified. Do not spend a credit until free search responds successfully.
