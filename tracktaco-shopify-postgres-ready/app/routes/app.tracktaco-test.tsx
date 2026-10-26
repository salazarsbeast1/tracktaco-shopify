import {useFetcher, useLoaderData} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

type Account = {credits?: {balance?: number}; history?: Array<{id: string; carrier?: string; tracking_number?: string; credits_charged?: number}>};
async function accountCheck() {
  const token = process.env.TRACKTACO_API_KEY;
  if (!token) throw new Error("TRACKTACO_API_KEY is not configured on the server");
  const response = await fetch("https://v2.tracktaco.com/v2/account?limit=5", {
    headers: {Authorization: `Bearer ${token}`, Accept: "application/json"},
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    throw new Error(`TrackTaco HTTP ${response.status}: ${error?.code || "unknown_error"} — ${error?.message || "No details"} (${error?.request_id || "no request ID"})`);
  }
  return data as Account;
}
export async function loader({request}: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return {configured: Boolean(process.env.TRACKTACO_API_KEY)};
}
export async function action({request}: ActionFunctionArgs) {
  await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "check") return Response.json({ok: false, error: "Invalid action"}, {status: 400});
  try {return Response.json({ok: true, account: await accountCheck()});}
  catch (e) {return Response.json({ok: false, error: e instanceof Error ? e.message : "Connection failed"});}
}
export default function TrackTacoTest() {
  const {configured} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  return <s-page heading="TrackTaco · Connection test">
    <s-section heading="API connectivity">
      <s-paragraph>Read-only account check. Does not reveal tracking numbers, spend credits, or modify Shopify orders.</s-paragraph>
      <s-paragraph>Server API key: {configured ? "Configured" : "Missing"}</s-paragraph>
      <fetcher.Form method="post"><input type="hidden" name="intent" value="check"/><button type="submit" disabled={!configured || fetcher.state !== "idle"}>{fetcher.state !== "idle" ? "Checking…" : "Test TrackTaco connection"}</button></fetcher.Form>
      {result?.ok === true && <div><p role="status">Connected successfully!</p><p>Available credits: {result.account?.credits?.balance ?? "Not returned"}</p></div>}
      {result?.ok === false && <p role="alert">{result.error}</p>}
    </s-section>
  </s-page>;
}
