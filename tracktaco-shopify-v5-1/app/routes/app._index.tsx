import {useEffect, useMemo, useState} from "react";
import {useFetcher, useLoaderData, useSearchParams} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

type Order = {id:string; name:string; createdAt:string; displayFulfillmentStatus:string; shippingAddress?:{city:string|null;provinceCode:string|null;countryCodeV2:string|null}|null;
 fulfillmentOrders:{nodes:Array<{id:string;status:string;requestStatus:string;assignedLocation:{location:{id:string}} | null}>}};
type OrderRow = {id:string; tracking:string; carrier:string};
type Result = {id:string; name:string; ok:boolean; message:string};
const GET_ORDERS = `#graphql
query BulkOrders($after:String,$reverse:Boolean!,$query:String){orders(first:100,after:$after,sortKey:CREATED_AT,reverse:$reverse,query:$query){
 edges{cursor node{id name createdAt displayFulfillmentStatus shippingAddress{city provinceCode countryCodeV2}}}
 pageInfo{hasNextPage endCursor}
}}`;
const VERIFY = `#graphql query VerifyBulkOrder($id:ID!){order(id:$id){id name displayFulfillmentStatus
 fulfillmentOrders(first:40){nodes{id status requestStatus assignedLocation{location{id}}}}
}}`;
const CREATE = `#graphql mutation CreateVerifiedFulfillment($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){fulfillment{id status trackingInfo{number company}} userErrors{message field}}}`;
const LIMIT = 150;
export async function loader({request}:LoaderFunctionArgs){
 const {admin}=await authenticate.admin(request);
 const url=new URL(request.url); const sort=url.searchParams.get("sort")==="old"?"old":"new";
 const after=url.searchParams.get("after")||null;
 const status=["unfulfilled","partial","all"].includes(url.searchParams.get("status")||"") ? url.searchParams.get("status")! : "unfulfilled";
 const from=(url.searchParams.get("from")||"").slice(0,10);
 const to=(url.searchParams.get("to")||"").slice(0,10);
 const search=(url.searchParams.get("search")||"").trim().slice(0,60);
 const terms:string[]=[];
 if(status==="unfulfilled")terms.push("(fulfillment_status:unfulfilled OR fulfillment_status:partial)");
 else if(status==="partial")terms.push("fulfillment_status:partial");
 if(/^\d{4}-\d{2}-\d{2}$/.test(from))terms.push(`created_at:>=${from}`);
 if(/^\d{4}-\d{2}-\d{2}$/.test(to))terms.push(`created_at:<=${to}`);
 if(search) terms.push(`name:${search.replace(/[^a-zA-Z0-9#-]/g,"")}`);
 const response=await admin.graphql(GET_ORDERS,{variables:{after,reverse:sort==="new",query:terms.join(" AND ")||null}});
 const data=await response.json();
 if(!response.ok||data.errors?.length) throw new Response("Could not load orders",{status:502});
 return {orders:(data.data.orders.edges||[]).map((e:any)=>e.node) as Order[],
  nextCursor:data.data.orders.pageInfo.hasNextPage ? data.data.orders.pageInfo.endCursor as string : null, sort,status,from,to,search};
}
export async function action({request}:ActionFunctionArgs){
 const {admin}=await authenticate.admin(request);
 const form=await request.formData();
 const intent=String(form.get("intent")||"");
 if(intent==="tracktaco_search"||intent==="tracktaco_reveal"){
  try {
   const key=process.env.TRACKTACO_API_KEY;
   if(!key)throw new Error("TRACKTACO_API_KEY missing");
   const orderId=String(form.get("orderId")||"");
   if(!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId))throw new Error("Invalid order");
   const check=await admin.graphql(`#graphql query($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2}}}`,{variables:{id:orderId}});
   const checkPayload=await check.json();
   if(!check.ok||checkPayload.errors?.length)throw new Error("Shopify order lookup failed");
   const order=checkPayload.data?.order;
   if(!order)throw new Error("Order not found");
   const dest=order.shippingAddress;
   if(dest?.countryCodeV2!=="US"||!dest.city||!dest.provinceCode)throw new Error("Requires a US order with a shipping city and state");
   const api=async(path:string,body:object)=>{
    const res=await fetch(`https://v2.tracktaco.com${path}`,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    // Read the raw upstream body first so truncated responses become actionable errors.
    const raw=await res.text();
    let json:any=null;
    try { json=raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`TrackTaco returned invalid JSON (HTTP ${res.status}). Retry the search; if it persists, check Render logs. Request ID: ${res.headers.get("x-request-id") || "unavailable"}.`); }
    if(!res.ok){
     const requestId=json?.error?.request_id || res.headers.get("x-request-id") || "unavailable";
     throw new Error(`TrackTaco HTTP ${res.status}: ${json?.error?.message || "Request failed"}. Request ID: ${requestId}`);
    }
    if(!json || typeof json!=="object") throw new Error(`TrackTaco sent an empty API response (HTTP ${res.status}).`);
    return json;
   };
   if(intent==="tracktaco_search"){
    const carrier=String(form.get("carrier")||"any");
    if(!["any","ups","fedex","dhl"].includes(carrier))throw new Error("Invalid carrier");
    const filter:any={dest:{country:"US",state:dest.provinceCode.toUpperCase(),city:dest.city.toUpperCase()}};
    if(carrier!=="any")filter.carrier=[carrier];
    const search=await api("/v2/tns/search",{searches:[{filter,page_size:25}]});
    if (!Array.isArray(search?.searches) || !search.searches[0]) throw new Error("TrackTaco search returned an unexpected response structure. No credits were spent.");
    const first=search.searches[0];
    return Response.json({tracktaco:{intent,orderId,orderName:order.name,city:dest.city,state:dest.provinceCode,hits:first.results||[],error:first.error?.message||null}});
   }
   if(form.get("confirmSpend")!=="yes")throw new Error("Credit-spend confirmation required");
   const tnId=String(form.get("tnId")||"");
   if(!/^tn_[a-zA-Z0-9_-]{4,200}$/.test(tnId))throw new Error("Invalid TrackTaco record");
   const revealed=await api("/v2/tns/reveal",{tn_ids:[tnId]});
   return Response.json({tracktaco:{intent,orderId,orderName:order.name,city:dest.city,state:dest.provinceCode,revealed:revealed?.results?.[0]||null,credits_remaining:revealed?.credits_remaining}});
  }catch(e){return Response.json({tracktaco:{intent,error:e instanceof Error?e.message:"Unknown failure"}});}
 }
 if(intent!=="fulfill")return Response.json({error:"Invalid request"},{status:400});
 if(form.get("confirmed")!=="yes"||form.get("shipmentVerified")!=="yes")return Response.json({error:"Explicit confirmation and shipment verification are required"},{status:400});
 let rows:OrderRow[];
 try{rows=JSON.parse(String(form.get("rows")||"[]"));}catch{return Response.json({error:"Invalid order data"},{status:400});}
 if(!Array.isArray(rows)||!rows.length||rows.length>LIMIT||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!/^gid:\/\/shopify\/Order\/\d+$/.test(r.id||"")||!r.tracking?.trim()||!(["FedEx","UPS","DHL","USPS","Other"].includes(r.carrier)))){
  return Response.json({error:`Select 1-${LIMIT} unique orders with a real tracking number and carrier for each`},{status:400});
 }
 const results:Result[]=[];
 for(const row of rows){
  try{
   const response=await admin.graphql(VERIFY,{variables:{id:row.id}});const payload=await response.json();
   if(!response.ok||payload.errors?.length)throw new Error("Unable to verify current order status");
   const order=payload.data?.order as Order|undefined;if(!order)throw new Error("Order unavailable");
   const eligible=order.fulfillmentOrders.nodes.filter(fo=>fo.status==="OPEN"&&fo.requestStatus==="UNSUBMITTED");
   if(!eligible.length)throw new Error("Already fulfilled or no merchant-managed fulfillments available");
   // Shopify requires fulfillment orders within a single location in one fulfillment.
   const groups=new Map<string,typeof eligible>();
   for(const fo of eligible){const location=fo.assignedLocation?.location?.id || fo.id;groups.set(location,[...(groups.get(location)||[]),fo]);}
   let completed=0;
   for(const group of groups.values()){
    const mutation=await admin.graphql(CREATE,{variables:{fulfillment:{
     lineItemsByFulfillmentOrder:group.map(fo=>({fulfillmentOrderId:fo.id})),
     trackingInfo:{number:row.tracking.trim(),company:row.carrier==="Other"?undefined:row.carrier},
     notifyCustomer:false
    }}});
    const result=await mutation.json();
    if(!mutation.ok||result.errors?.length)throw new Error(result.errors?.[0]?.message||"Shopify rejected request");
    const errors=result.data?.fulfillmentCreate?.userErrors || [];
    if(errors.length)throw new Error(errors.map((e:any)=>e.message).join("; "));
    if(!result.data?.fulfillmentCreate?.fulfillment?.id)throw new Error("Shopify did not confirm a fulfillment");
    completed++;
   }
   results.push({id:row.id,name:order.name,ok:true,message:`Created ${completed} Shopify fulfillment(s) with tracking ${row.tracking}`});
  }catch(e){results.push({id:row.id,name:row.id.split("/").pop()||row.id,ok:false,message:e instanceof Error?e.message:"Unknown error"});}
 }
 return Response.json({results});
}
const button:React.CSSProperties={border:"1px solid #b8bdc5",borderRadius:8,padding:"9px 14px",background:"white",cursor:"pointer",fontWeight:600};
export default function BulkDashboard(){
 const {orders,nextCursor,sort,status,from,to,search}=useLoaderData<typeof loader>();
 const [params,setParams]=useSearchParams();
 const fetcher=useFetcher<typeof action>();
 const [selected,setSelected]=useState<Record<string,{name:string;tracking:string;carrier:string}>>({});
 const [review,setReview]=useState(false),[agree,setAgree]=useState(false);
 const [filter,setFilter]=useState("");
 const [bulkText,setBulkText]=useState("");
 const [searchDraft,setSearchDraft]=useState(search);
 const busy=fetcher.state!=="idle";
 const filtered=useMemo(()=>orders.filter(o=>o.name.toLowerCase().includes(filter.toLowerCase())),[orders,filter]);
 const picked=Object.entries(selected);
 const count=picked.length;
 const all=filtered.length>0&&filtered.every(o=>!!selected[o.id]);
 const change=(o:Order)=>setSelected(prev=>{const next={...prev};if(next[o.id])delete next[o.id];else next[o.id]={name:o.name,tracking:"",carrier:"UPS"};return next;});
 const updateFilters=(key:string,value:string)=>{const p=new URLSearchParams(params);p.set(key,value);p.delete("after");setParams(p);setReview(false)};
 const switchSort=(value:string)=>updateFilters("sort",value);
 const next=()=>{if(nextCursor){const p=new URLSearchParams(params);p.set("after",nextCursor);setParams(p);}setReview(false)};
 const previous=()=>{const p=new URLSearchParams(params);p.delete("after");setParams(p);setReview(false)};
 const resultData=fetcher.data as {results?:Result[];error?:string;tracktaco?:any}|undefined;
 const [ttOrderId,setTtOrderId]=useState("");
 const [ttCarrier,setTtCarrier]=useState("any");
 const [ttSelected,setTtSelected]=useState<any>(null);
 const [ttHits,setTtHits]=useState<any[]>([]);
 const [ttOrderDest,setTtOrderDest]=useState("");
 const [ttReveal,setTtReveal]=useState<any>(null);
 useEffect(()=>{const t=resultData?.tracktaco;if(!t)return;
  if(t.intent==="tracktaco_search"&&!t.error){setTtHits(t.hits||[]);setTtSelected(null);setTtReveal(null);setTtOrderDest(`${t.orderName} · ${t.city}, ${t.state}`);}
  if(t.intent==="tracktaco_reveal"&&!t.error){setTtReveal(t);}
 },[resultData]);
 const parsed=useMemo(()=>{
  const map=new Map<string,{tracking:string;carrier:string}>();
  const errors:string[]=[];
  for(const [index,line] of bulkText.split(/\r?\n/).entries()){
   if(!line.trim())continue;
   const cols=line.trim().split(/[,\t]/).map(c=>c.trim().replace(/^"|"$/g,""));
   if(index===0 && /^(order|order.number|name)$/i.test(cols[0]))continue;
   if(cols.length<3){errors.push(`Line ${index+1}: expected order number, tracking number, carrier`);continue;}
   const name=cols[0].startsWith("#")?cols[0]:`#${cols[0]}`;
   const carrier={ups:"UPS",fedex:"FedEx",dhl:"DHL",usps:"USPS",other:"Other"}[cols[2].toLowerCase()];
   if(!carrier||!cols[1]){errors.push(`Line ${index+1}: invalid tracking or carrier`);continue;}
   if(map.has(name))errors.push(`Duplicate order ${name}`);
   map.set(name,{tracking:cols[1],carrier});
  }
  return {map,errors};
 },[bulkText]);
 const readyRows=picked.map(([id,v])=>({id,...(parsed.map.get(v.name)||{tracking:"",carrier:""}),name:v.name}));
 const missing=readyRows.filter(v=>!v.tracking||!v.carrier);
 const valid=missing.length===0&&parsed.errors.length===0;
 return <s-page heading="TrackTaco · Bulk Fulfillment">
 <s-section heading="Order dashboard">
  <p style={{color:"#53606d"}}>Manual mode · No automatic fulfillment · Shopify marks an order fulfilled only after you confirm its actual shipment tracking.</p>
  <div style={{display:"flex",flexWrap:"wrap",gap:12,margin:"16px 0",alignItems:"center"}}>
   <div style={{padding:"14px 20px",background:"#ecf6ff",borderRadius:12}}><strong style={{fontSize:24}}>{count}</strong><div>Selected across pages</div></div>
   <div style={{padding:"14px 20px",background:"#f5f6f8",borderRadius:12}}><strong style={{fontSize:24}}>{orders.length}</strong><div>Loaded this page</div></div>
   <label>Sort by date <select value={sort} onChange={e=>switchSort(e.target.value)} style={{...button,marginLeft:8}}><option value="new">Newest first</option><option value="old">Oldest first</option></select></label>
   <label>Status <select value={status} onChange={e=>updateFilters("status",e.target.value)} style={{...button,marginLeft:8}}><option value="unfulfilled">Unfulfilled + partial</option><option value="partial">Partially fulfilled</option><option value="all">All statuses</option></select></label>
   <label>From <input type="date" value={from} onChange={e=>updateFilters("from",e.target.value)} style={button}/></label>
   <label>Through <input type="date" value={to} onChange={e=>updateFilters("to",e.target.value)} style={button}/></label>
   <form onSubmit={e=>{e.preventDefault();updateFilters("search",searchDraft)}} style={{display:"flex",gap:5}}><input placeholder="Find order number" value={searchDraft} onChange={e=>setSearchDraft(e.target.value)} style={{...button,minWidth:150}} /><button style={button} type="submit">Search</button></form>
   <input placeholder="Filter loaded page" value={filter} onChange={e=>setFilter(e.target.value)} style={{...button,minWidth:180}} />
  </div>
  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
   <button style={button} onClick={()=>setSelected(prev=>{const next={...prev};for(const o of filtered){if(!all)next[o.id]=next[o.id]||{name:o.name,tracking:"",carrier:"UPS"};else delete next[o.id];}return next;})}>{all?"Deselect visible":"Select all visible"}</button>
   <button style={button} onClick={()=>setSelected({})} disabled={!count}>Clear selection</button>
   <button style={button} onClick={()=>{setParams({sort:"new",status:"unfulfilled"});setSearchDraft("");setFilter("")}}>Reset filters</button>
   <button style={{...button,background:count?"#1d5fd1":"#dfe3e8",color:count?"white":"#444"}} disabled={!count||busy} onClick={()=>{setReview(true);setAgree(false);}}>Review {count} orders</button>
  </div>
  <div style={{border:"1px solid #dce1e8",borderRadius:12,overflow:"hidden"}}>
   {filtered.map(o=><label key={o.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 15px",borderBottom:"1px solid #e6e8ec",background:selected[o.id]?"#f0f7ff":"white"}}>
     <input type="checkbox" checked={!!selected[o.id]} onChange={()=>change(o)} disabled={busy}/>
     <strong style={{minWidth:95}}>{o.name}</strong><span style={{flex:1}}>{new Date(o.createdAt).toLocaleDateString()}</span>
     <span style={{fontSize:12,color:"#586879"}}>{o.displayFulfillmentStatus.replaceAll("_"," ")}</span>
   </label>)}
   {!filtered.length&&<p style={{padding:16}}>No matching unfulfilled orders on this page.</p>}
  </div>
  <div style={{display:"flex",gap:8,marginTop:14,alignItems:"center"}}>
   <button style={button} onClick={previous} disabled={!params.get("after")||busy}>Back to first page</button>
   <button style={button} onClick={next} disabled={!nextCursor||busy}>Next 100 orders →</button>
   <span style={{fontSize:12,color:"#667085"}}>Selections are kept when navigating pages. Select across pages. Maximum {LIMIT} per fulfillment submission; additional batches are supported.</span>
  </div>
 </s-section>
 <s-section heading="TrackTaco US destination lookup · real API test">
 <p>Choose one order to automatically search its actual US shipping city and state. Austin orders search Austin, TX; Dallas orders search Dallas, TX. Searches are free. Revealing a record consumes credits and does not itself fulfill an order.</p>
 <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:12}}>
  <select aria-label="Order for TrackTaco search" style={button} value={ttOrderId} onChange={e=>{setTtOrderId(e.target.value);setTtHits([]);setTtSelected(null);setTtReveal(null)}}>
   <option value="">Select a loaded US order…</option>
   {orders.map(o=><option key={o.id} value={o.id}>{o.name} — {o.shippingAddress?.city||"No city"}, {o.shippingAddress?.provinceCode||"?"}</option>)}
  </select>
  <select style={button} value={ttCarrier} onChange={e=>setTtCarrier(e.target.value)}><option value="any">All carriers</option><option value="ups">UPS</option><option value="fedex">FedEx</option><option value="dhl">DHL</option></select>
  <button style={{...button,background:"#1455a2",color:"white"}} disabled={!ttOrderId||busy} onClick={()=>fetcher.submit({intent:"tracktaco_search",orderId:ttOrderId,carrier:ttCarrier},{method:"post"})}>Find matching destination records (free)</button>
 </div>
 {ttOrderDest&&<p><strong>Last search:</strong> {ttOrderDest}</p>}
 {resultData?.tracktaco?.error&&<p role="alert" style={{color:"#a12222"}}>{resultData.tracktaco.error}</p>}
 {!!ttHits.length&&<div style={{maxHeight:300,overflow:"auto",border:"1px solid #ddd",borderRadius:8}}>{ttHits.map(h=><label key={h.tn_id} style={{display:"flex",gap:12,padding:10,borderBottom:"1px solid #eee",alignItems:"center"}}><input type="radio" checked={ttSelected?.tn_id===h.tn_id} onChange={()=>setTtSelected(h)}/><strong>{h.carrier?.toUpperCase()}</strong><span>{h.dest?.city}, {h.dest?.state} · {h.status} · {h.est_delivery_date||"Date unknown"}</span><span style={{marginLeft:"auto"}}>{h.reveal_cost_credits??1} credit</span></label>)}</div>}
 {resultData?.tracktaco?.intent==="tracktaco_search"&&!resultData.tracktaco.error&&!ttHits.length&&<p>No destination matches returned.</p>}
 {ttSelected&&<div style={{marginTop:12,padding:14,background:"#f3f5f9",borderRadius:10}}><p>Reveal this record? TrackTaco may charge {ttSelected.reveal_cost_credits??1} credit. This only retrieves existing tracking data; a matching destination does not prove this tracking belongs to your order.</p><button disabled={busy} style={{...button,background:"#116a44",color:"white"}} onClick={()=>fetcher.submit({intent:"tracktaco_reveal",orderId:ttOrderId,tnId:ttSelected.tn_id,confirmSpend:"yes"},{method:"post"})}>Confirm paid reveal</button></div>}
 {ttReveal&&<p role="status"><strong>TrackTaco reveal:</strong> {ttReveal.revealed?.outcome} · {ttReveal.revealed?.carrier} · {ttReveal.revealed?.tracking_number||ttReveal.revealed?.error?.message||"No number"}. Credits left: {ttReveal.credits_remaining??"unavailable"}. This record has not been assigned to a Shopify order.</p>}
 </s-section>
 {review&&<s-section heading={`Review ${count} selected orders`}>
  <p>All selected orders can be confirmed in one batch. No individual tracking fields are required. For Shopify fulfillment, import the real carrier tracking data corresponding to each shipped order from Ship to the Moon (or your actual carrier).</p>
  <p><strong>Batch import format:</strong> one row per order: <code>order number, tracking number, carrier</code>. You may paste rows copied from a CSV spreadsheet. Example: <code>#1234,1ZEXAMPLE,UPS</code> (example is not a real tracking number).</p>
  <textarea aria-label="Shipment tracking CSV" placeholder={'Order,Tracking,Carrier\n#1234,TRACKING_FROM_ACTUAL_SHIPMENT,UPS'} value={bulkText} onChange={e=>setBulkText(e.target.value)} rows={6} style={{...button,width:"100%",boxSizing:"border-box",fontFamily:"monospace"}}/>
  <p><strong>{readyRows.length-missing.length} of {count}</strong> selected orders have matching tracking rows. {missing.length>0?`${missing.length} still need matched shipment tracking.`:"All orders matched."}</p>
  {parsed.errors.length>0&&<p role="alert" style={{color:"#a12222"}}>{parsed.errors.slice(0,5).join(" | ")}</p>}
  {missing.length>0&&<p style={{fontSize:13,color:"#7c5314"}}>Missing: {missing.slice(0,12).map(r=>r.name).join(", ")}{missing.length>12?"…":""}</p>}
  <div style={{maxHeight:160,overflowY:"auto",border:"1px solid #ddd",borderRadius:9,padding:10}}>{readyRows.map(r=><div key={r.id} style={{display:"flex",gap:8,justifyContent:"space-between",padding:4}}><strong>{r.name}</strong><span>{r.tracking?`${r.carrier} · ${r.tracking}`:"No matching shipment tracking"}</span></div>)}</div>
  {count>LIMIT&&<p role="alert">Select at most {LIMIT} orders per submission.</p>}
  <label style={{display:"flex",gap:10,alignItems:"flex-start",margin:"18px 0"}}><input type="checkbox" checked={agree} onChange={e=>setAgree(e.target.checked)}/><span>I confirm the selected orders have already shipped through Ship to the Moon and that each imported tracking number belongs to the corresponding customer's actual shipment. I understand Shopify will mark these orders fulfilled.</span></label>
  <button style={{...button,background:"#136a42",color:"white"}} disabled={!agree||!count||!valid||count>LIMIT||busy} onClick={()=>fetcher.submit({intent:"fulfill",confirmed:"yes",shipmentVerified:"yes",rows:JSON.stringify(readyRows.map(({id,tracking,carrier})=>({id,tracking,carrier})))},{method:"post"})}>{busy?"Processing…":`Confirm and fulfill ${count} orders`}</button>{" "}
  <button style={button} disabled={busy} onClick={()=>setReview(false)}>Cancel</button>
  <p style={{fontSize:12,color:"#657080"}}>TrackTaco searches and paid reveals are available on the separate API tests page. A TrackTaco record isn't automatically matched to an order merely because the destination and date are similar.</p>
 </s-section>}
 {(resultData?.error||resultData?.results)&&<s-section heading="Fulfillment results">
  {resultData?.error&&<p role="alert">{resultData.error}</p>}
  {resultData?.results?.map(r=><p key={r.id} style={{color:r.ok?"#086c42":"#a12222"}}>{r.ok?"✓ Fulfilled":"✕ Failed"} {r.name}: {r.message}</p>)}
 </s-section>}
 </s-page>;
}
