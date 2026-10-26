import {useEffect, useMemo, useState} from "react";
import {useFetcher, useLoaderData, useSearchParams} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

type Order = {id:string; name:string; createdAt:string; displayFulfillmentStatus:string;
 fulfillmentOrders:{nodes:Array<{id:string;status:string;requestStatus:string;assignedLocation:{location:{id:string}} | null}>}};
type OrderRow = {id:string; tracking:string; carrier:string};
type Result = {id:string; name:string; ok:boolean; message:string};
const GET_ORDERS = `#graphql
query BulkOrders($after:String,$reverse:Boolean!,$query:String){orders(first:100,after:$after,sortKey:CREATED_AT,reverse:$reverse,query:$query){
 edges{cursor node{id name createdAt displayFulfillmentStatus}}
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
 if(form.get("intent")!=="fulfill")return Response.json({error:"Invalid request"},{status:400});
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
 const resultData=fetcher.data as {results?:Result[];error?:string}|undefined;
 const missing=picked.some(([,v])=>!v.tracking.trim());
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
 {review&&<s-section heading={`Review ${count} selected orders`}>
  <p><strong>Only use tracking numbers for shipments actually sent to these customers.</strong> TrackTaco's available tracking inventory is not proof of shipment ownership. The app does not select or purchase tracking numbers automatically.</p>
  <p>Enter the actual tracking number and carrier for each order. Customers will not receive automatic notifications from this test workflow.</p>
  <div style={{maxHeight:420,overflowY:"auto",display:"grid",gap:8,marginTop:16}}>
   {picked.map(([id,v])=><div key={id} style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",padding:10,background:"#f6f7f8",borderRadius:9}}>
    <strong style={{minWidth:95}}>{v.name}</strong>
    <input aria-label={`Tracking for ${v.name}`} placeholder="Verified tracking number" value={v.tracking} onChange={e=>setSelected(p=>({...p,[id]:{...p[id],tracking:e.target.value}}))} style={{...button,flex:1,minWidth:170}}/>
    <select aria-label={`Carrier for ${v.name}`} value={v.carrier} onChange={e=>setSelected(p=>({...p,[id]:{...p[id],carrier:e.target.value}}))} style={button}>{["UPS","FedEx","DHL","USPS","Other"].map(c=><option key={c}>{c}</option>)}</select>
   </div>)}
  </div>
  {count>LIMIT&&<p role="alert">Select up to {LIMIT} orders per submission, then submit the next batch.</p>}
  <label style={{display:"flex",gap:10,alignItems:"flex-start",margin:"18px 0"}}><input type="checkbox" checked={agree} onChange={e=>setAgree(e.target.checked)}/><span>I confirm every tracking number belongs to an actual shipment for its corresponding order. Fulfill only these selected orders.</span></label>
  <button style={{...button,background:"#136a42",color:"white"}} disabled={!agree||!count||missing||count>LIMIT||busy} onClick={()=>fetcher.submit({intent:"fulfill",confirmed:"yes",shipmentVerified:"yes",rows:JSON.stringify(picked.map(([id,v])=>({id,tracking:v.tracking,carrier:v.carrier})))},{method:"post"})}>{busy?"Processing…":`Confirm Shopify fulfillment (${count})`}</button>{" "}
  <button style={button} disabled={busy} onClick={()=>setReview(false)}>Cancel</button>
 </s-section>}
 {(resultData?.error||resultData?.results)&&<s-section heading="Fulfillment results">
  {resultData?.error&&<p role="alert">{resultData.error}</p>}
  {resultData?.results?.map(r=><p key={r.id} style={{color:r.ok?"#086c42":"#a12222"}}>{r.ok?"✓ Fulfilled":"✕ Failed"} {r.name}: {r.message}</p>)}
 </s-section>}
 </s-page>;
}
