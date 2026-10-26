import {useState} from "react";
import {useFetcher, useLoaderData} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {createTrackTacoFulfillment} from "../services/tracktaco.server";

type ShopifyError = {message: string};
type OrderNode = {
  id: string; name: string; createdAt: string; displayFulfillmentStatus: string;
  fulfillmentOrders: {nodes: Array<{id: string; status: string; requestStatus: string}>};
};
type Result = {id: string; name: string; ok: boolean; message: string};

const ORDERS_QUERY = `#graphql
  query ManualTrackTacoOrders {
    orders(first: 50, sortKey: CREATED_AT, reverse: true,
      query: "fulfillment_status:unfulfilled OR fulfillment_status:partial") {
      nodes {
        id name createdAt displayFulfillmentStatus
        fulfillmentOrders(first: 20) { nodes { id status requestStatus } }
      }
    }
  }
`;

const ORDER_CHECK = `#graphql
  query RecheckOrder($id: ID!) {
    order(id: $id) {
      id name displayFulfillmentStatus
      fulfillmentOrders(first: 20) { nodes { id status requestStatus } }
    }
  }
`;

export async function loader({request}: LoaderFunctionArgs) {
  const {admin} = await authenticate.admin(request);
  const response = await admin.graphql(ORDERS_QUERY);
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Response("Could not load Shopify orders", {status: 502});
  return {orders: (payload.data.orders.nodes || []) as OrderNode[]};
}

export async function action({request}: ActionFunctionArgs) {
  const {admin, session} = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "fulfill") return Response.json({error: "Invalid intent"}, {status: 400});
  let ids: unknown;
  try { ids = JSON.parse(String(form.get("orderIds") || "null")); }
  catch { return Response.json({error: "Invalid selection"}, {status: 400}); }
  if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => typeof id !== "string" || !/^gid:\/\/shopify\/Order\/\d+$/.test(id))) {
    return Response.json({error: "Select exactly two different Shopify orders"}, {status: 400});
  }
  const results: Result[] = [];
  for (const id of ids) {
    try {
      const response = await admin.graphql(ORDER_CHECK, {variables: {id}});
      const payload = await response.json();
      if (!response.ok || payload.errors?.length) throw new Error("Shopify order verification failed");
      const order = payload.data?.order as OrderNode | null;
      if (!order) throw new Error("Order no longer exists");
      const eligible = order.fulfillmentOrders.nodes.filter(fo => fo.status === "OPEN" && fo.requestStatus === "UNSUBMITTED");
      if (!eligible.length) throw new Error("No eligible open fulfillment orders");
      // This function explicitly fails closed until verified TrackTaco spec is available.
      await createTrackTacoFulfillment({shop: session.shop, orderId: id, fulfillmentOrderIds: eligible.map(fo => fo.id)});
      // No Shopify fulfillmentCreate here until TrackTaco response contract is verified.
      results.push({id, name: order.name, ok: false, message: "Tracking returned, but Shopify fulfillment is not configured"});
    } catch (error) {
      results.push({id, name: id.split("/").pop() || id, ok: false, message: error instanceof Error ? error.message : "Unknown failure"});
    }
  }
  return Response.json({results});
}

export default function ManualTrackTaco() {
  const {orders} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const busy = fetcher.state !== "idle";
  function toggle(id: string) {
    if (busy) return;
    setSelected(prev => prev.includes(id) ? prev.filter(v => v !== id) : prev.length >= 2 ? prev : [...prev, id]);
    setConfirm(false); setAck(false);
  }
  function submit() {
    if (selected.length !== 2 || !ack || busy) return;
    fetcher.submit({intent: "fulfill", orderIds: JSON.stringify(selected)}, {method: "post"});
    setConfirm(false); setAck(false);
  }
  const results = "results" in (fetcher.data || {}) ? fetcher.data.results as Result[] : undefined;
  const error = "error" in (fetcher.data || {}) ? String(fetcher.data.error) : undefined;
  return (
    <s-page heading="TrackTaco · Manual fulfillment">
      <s-section heading="Unfulfilled orders">
        <s-paragraph>Choose exactly two orders. No order is fulfilled until you explicitly confirm. TrackTaco live requests are disabled pending endpoint verification.</s-paragraph>
        <div style={{marginTop: 16, display: "grid", gap: 12}}>
          {orders.map(order => (
            <label key={order.id} style={{border: "1px solid #ddd", borderRadius: 10, padding: 12, display: "flex", gap: 12, alignItems: "center"}}>
              <input type="checkbox" checked={selected.includes(order.id)} onChange={() => toggle(order.id)} disabled={busy || (!selected.includes(order.id) && selected.length >= 2)} />
              <span><strong>{order.name}</strong> · {order.displayFulfillmentStatus} · {new Date(order.createdAt).toLocaleDateString()}</span>
            </label>
          ))}
          {!orders.length && <p>No eligible orders were returned.</p>}
        </div>
        <div style={{marginTop: 16}}>
          <button type="button" disabled={selected.length !== 2 || busy} onClick={() => setConfirm(true)}>Review 2 selected orders</button>
        </div>
      </s-section>
      {confirm && <s-section heading="Confirm bulk fulfillment">
        <s-paragraph>This will request tracking for these two orders only. Production integration is currently disabled.</s-paragraph>
        <ul>{orders.filter(o => selected.includes(o.id)).map(o => <li key={o.id}>{o.name}</li>)}</ul>
        <label style={{display: "flex", gap: 8, marginBottom: 12}}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>I authorize fulfillment of these two orders.</label>
        <button type="button" disabled={!ack || busy} onClick={submit}>Confirm two-order fulfillment</button>{" "}
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
      </s-section>}
      {(results || error) && <s-section heading="Results">
        {error && <p role="alert">{error}</p>}
        {results?.map(r => <p key={r.id}>{r.ok ? "Success" : "Not fulfilled"}: {r.name} — {r.message}</p>)}
      </s-section>}
    </s-page>
  );
}
