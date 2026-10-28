import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/verification">VA Bulk Verification</s-link>
        <s-link href="/app/tracktaco-test">Test TrackTaco connection</s-link>
      </s-app-nav>
      <style>{`
        .trackflow-shell { background:#080d0b; min-height:100vh; padding:20px 18px 38px; color:#e7f7ef; font-family:Inter,system-ui,sans-serif; }
        .trackflow-brand { display:flex; align-items:center; gap:16px; padding:13px 19px; background:linear-gradient(105deg,#0d1512 0%,#0a241b 62%,#10593b 100%); border:1px solid #1a523d; border-radius:14px; margin-bottom:16px; box-shadow:0 14px 36px #0005; }
        .trackflow-logo-wrap { background:white; border-radius:9px; padding:8px 13px; flex-shrink:0; }
        .trackflow-logo { width:210px; max-width:38vw; display:block; height:auto; }
        .trackflow-meta { color:#b3d7c4; font-size:13px; }
        .trackflow-meta strong { color:#f5fff9; display:block; font-size:16px; margin-bottom:3px; }
        .trackflow-shell button:not([disabled]) { cursor:pointer; }
        .trackflow-shell button:not([disabled]):hover { filter:brightness(1.12); }
        .trackflow-shell button { transition:filter .15s ease,background .15s ease; }
        .trackflow-shell button[style*="background: rgb(20, 85, 162)"],
        .trackflow-shell button[style*="background: rgb(17, 106, 68)"],
        .trackflow-shell button[style*="background: rgb(0, 128, 96)"],
        .trackflow-shell button[style*="background: rgb(19, 106, 66)"] { background:linear-gradient(120deg,#086342,#14c87e)!important; border-color:#0f9f69!important; color:white!important; }
        .trackflow-shell table { border-radius:8px; overflow:hidden; }
        .trackflow-shell input[type=checkbox] { accent-color:#19ba78; }
        @media(max-width:650px){.trackflow-brand{flex-wrap:wrap}.trackflow-logo{width:180px}.trackflow-shell{padding:12px 8px 22px}}
      `}</style>
      <div className="trackflow-shell">
        <header className="trackflow-brand">
          <div className="trackflow-logo-wrap"><img className="trackflow-logo" src="/images/trackflow-logo.png" alt="Trackflow.ai" /></div>
          <div className="trackflow-meta"><strong>Tracking Operations</strong>TrackTaco integration · VA verification · Shopify</div>
        </header>
        <Outlet />
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
