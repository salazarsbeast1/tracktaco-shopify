import {useEffect, useMemo, useRef, useState} from "react";
import {useFetcher, useLoaderData, useSearchParams} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import prisma from "../db.server";

type Order = {id:string; name:string; createdAt:string; displayFulfillmentStatus:string; shippingAddress?:{city:string|null;provinceCode:string|null;countryCodeV2:string|null}|null;
 fulfillmentOrders:{nodes:Array<{id:string;status:string;requestStatus:string;assignedLocation:{location:{id:string}} | null}>}};
type OrderRow = {id:string; tracking:string; carrier:string};
type Result = {id:string; name:string; ok:boolean; message:string};
const GET_ORDERS = `#graphql
query BulkOrders($after:String,$reverse:Boolean!,$query:String){orders(first:100,after:$after,sortKey:CREATED_AT,reverse:$reverse,query:$query){
 edges{cursor node{id name createdAt displayFulfillmentStatus shippingAddress{city provinceCode countryCodeV2}}}
 pageInfo{hasNextPage endCursor}
}}`;
const VERIFY = `#graphql
query VerifyBulkOrder($id:ID!){order(id:$id){id name displayFulfillmentStatus
 fulfillmentOrders(first:40){nodes{id status requestStatus assignedLocation{location{id}}}}
}}`;
const CREATE = `#graphql
mutation CreateVerifiedFulfillment($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){fulfillment{id status trackingInfo{number company}} userErrors{message field}}}`;
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
 const {admin,session}=await authenticate.admin(request);
 const form=await request.formData();
 const intent=String(form.get("intent")||"");
 if(intent==="tracktaco_bulk_search"){
  try{
   const key=process.env.TRACKTACO_API_KEY;
   if(!key) throw new Error("TrackTaco API key is not configured");
   const ids=JSON.parse(String(form.get("orderIds")||"[]"));
   if(!Array.isArray(ids)||ids.length<1||ids.length>5||new Set(ids).size!==ids.length||ids.some((id:unknown)=>typeof id!=="string"||!/^gid:\/\/shopify\/Order\/\d+$/.test(id)))throw new Error("Select 1–5 different orders per free search request");
   const orderQuery=`#graphql
query BulkLookup($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2} fulfillments(first:20){id trackingInfo{number}}}}`;
   // Bound each request to five orders: the browser orchestrates up to 100 orders
   // in independent requests, so a slow destination never blocks the entire run.
   if(ids.length>5)throw new Error("Maximum five orders per search request; the dashboard handles larger selections automatically");
   const orderResults=await Promise.all(ids.map(async(id:string)=>{
    try{
     const res=await admin.graphql(orderQuery,{variables:{id}});
     const body=await res.json();
     if(!res.ok||body.errors?.length)throw new Error("Shopify order lookup failed");
     const order=body.data?.order;
     const addr=order?.shippingAddress;
     if(!order||!addr?.city||!addr?.countryCodeV2)throw new Error("Shipping destination missing");
     const fulfillments=order.fulfillments||[];
     if(fulfillments.some((f:any)=>(f.trackingInfo||[]).some((t:any)=>Boolean(t.number))))throw new Error("Skipped before TrackTaco purchase: this Shopify order already has shipment tracking.");
     if(fulfillments.length>1)throw new Error("Multiple existing fulfillments require manual shipment selection.");
     const filter:any={dest:{city:addr.city.toUpperCase(),country:addr.countryCodeV2}};
     if(addr.countryCodeV2==="US"&&addr.provinceCode)filter.dest.state=addr.provinceCode.toUpperCase();
     return {orderId:id,orderName:order.name,city:addr.city,state:addr.provinceCode,country:addr.countryCodeV2,filter};
    }catch(e){return {orderId:id,orderName:id,city:"",state:"",country:"",error:e instanceof Error?e.message:"Shopify lookup failed"};}
   }));
   const allResults:any[]=orderResults.filter((v:any)=>v.error).map((v:any)=>({...v,hits:[]}));
   const prepared=orderResults.filter((v:any)=>!v.error) as Array<{orderId:string;orderName:string;city:string;state:string|null;country:string;filter:any}>;
   if(prepared.length){
    const started=Date.now();
    console.info("[tracktaco] Short batch request started",{orders:prepared.length});
    try{
     const upstream=await fetch("https://v2.tracktaco.com/v2/tns/search",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({searches:prepared.map(p=>({filter:p.filter,page_size:10}))}),signal:AbortSignal.timeout(26000)});
     const raw=await upstream.text();
     let body:any;
     try{body=JSON.parse(raw);}catch{throw new Error(`TrackTaco returned unreadable data (HTTP ${upstream.status})`);}
     if(!upstream.ok)throw new Error(`TrackTaco HTTP ${upstream.status}: ${body?.error?.message||"Search failed"}`);
     if(!Array.isArray(body?.searches)||body.searches.length!==prepared.length)throw new Error("TrackTaco returned incomplete batch results");
     allResults.push(...prepared.map((p,j)=>({orderId:p.orderId,orderName:p.orderName,city:p.city,state:p.state,country:p.country,hits:body.searches[j]?.results||[],error:body.searches[j]?.error?.message||null})));
     console.info("[tracktaco] Short batch completed",{orders:prepared.length,ms:Date.now()-started});
    }catch(e){
     const message=e instanceof Error?e.message:"TrackTaco search failed";
     console.error("[tracktaco] Short batch failed",{ms:Date.now()-started,message});
     allResults.push(...prepared.map(p=>({...p,hits:[],error:message})));
    }
   }
   return Response.json({bulkSearch:{results:allResults}});
  }catch(e){console.error("[tracktaco] Batch free search failed",e);return Response.json({bulkSearch:{error:e instanceof Error?e.message:"Batch search failed"}});}
 }
 if(intent==="tracktaco_bulk_reveal"){
  try{
   if(form.get("confirmSpend")!=="yes")throw new Error("Explicit credit approval required");
   const key=process.env.TRACKTACO_API_KEY;
   if(!key)throw new Error("TrackTaco key not configured");
   const assignments=JSON.parse(String(form.get("assignments")||"[]"));
   if(!Array.isArray(assignments)||!assignments.length||assignments.length>50)throw new Error("Choose 1–50 candidate records");
   if(new Set(assignments.map((a:any)=>a.orderId)).size!==assignments.length || new Set(assignments.map((a:any)=>a.tnId)).size!==assignments.length)throw new Error("Duplicate order or tracking candidate detected");
   if(assignments.some((a:any)=>!/^gid:\/\/shopify\/Order\/\d+$/.test(a.orderId||"")||!/^tn_[a-zA-Z0-9_-]{4,200}$/.test(a.tnId||"")))throw new Error("Invalid bulk reveal selection");
   const accepted:any[]=[];const failed:any[]=[];
   // Re-fetch destination from Shopify: never trust addresses passed by browser.
   const orderQuery=`#graphql
query VerifyRevealOrder($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2} fulfillments(first:20){id trackingInfo{number}}}}`;
   for(const a of assignments){
    const res=await admin.graphql(orderQuery,{variables:{id:a.orderId}});
    const payload=await res.json();const order=payload.data?.order;
    if(!res.ok||payload.errors?.length||!order?.shippingAddress?.city||!order.shippingAddress.countryCodeV2){failed.push({orderId:a.orderId,error:"Unable to read Shopify destination"});continue;}
    const addr=order.shippingAddress;
    const fulfillments=order.fulfillments||[];
    if(fulfillments.some((f:any)=>(f.trackingInfo||[]).some((t:any)=>Boolean(t.number)))){failed.push({orderId:a.orderId,error:"Credit protected: Shopify already has shipment tracking. No reveal purchased."});continue;}
    if(fulfillments.length>1){failed.push({orderId:a.orderId,error:"Credit protected: multiple fulfillments need manual selection. No reveal purchased."});continue;}
    // Don't re-purchase previously staged records.
    const existing=await prisma.pendingTracking.findUnique({where:{shop_orderId_tnId:{shop:session.shop,orderId:a.orderId,tnId:a.tnId}}});
    if(existing){failed.push({orderId:a.orderId,error:"Record already revealed for this order"});continue;}
    accepted.push({a,order,addr});
   }
   if(!accepted.length)return Response.json({bulkReveal:{staged:[],failed,creditsRequested:0}});
   const response=await fetch("https://v2.tracktaco.com/v2/tns/reveal",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({tn_ids:accepted.map(x=>x.a.tnId)}),signal:AbortSignal.timeout(55000)});
   const raw=await response.text();let body:any;
   try{body=JSON.parse(raw);}catch{throw new Error(`TrackTaco reveal response unreadable (HTTP ${response.status}); check TrackTaco history before retrying to avoid double charges`);}
   if(!response.ok)throw new Error(`TrackTaco reveal HTTP ${response.status}: ${body?.error?.message||"Request failed"}`);
   if(!Array.isArray(body?.results))throw new Error("TrackTaco reveal returned no result array; check account history before retrying");
   const byId=new Map(body.results.map((v:any)=>([v.tn_id,v])));
   const staged:any[]=[];
   const same=(a:unknown,b:unknown)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
   for(let i=0;i<accepted.length;i++){
    const {a,order,addr}=accepted[i];const entry:any=byId.get(a.tnId)||body.results[i];
    if(!entry?.tracking_number||!entry?.carrier){failed.push({orderId:a.orderId,error:entry?.error?.message||"No tracking revealed"});continue;}
    if(!same(entry.dest?.city,addr.city)||!same(entry.dest?.country,addr.countryCodeV2)||(addr.countryCodeV2==="US"&&!same(entry.dest?.state,addr.provinceCode))){failed.push({orderId:a.orderId,error:"Revealed record destination differs from Shopify; not queued"});continue;}
    try{
     await prisma.pendingTracking.upsert({where:{shop_orderId_tnId:{shop:session.shop,orderId:a.orderId,tnId:a.tnId}},update:{trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),status:"PENDING",lastError:null},create:{shop:session.shop,orderId:a.orderId,orderName:order.name,tnId:a.tnId,trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),destinationCity:addr.city,destinationState:addr.provinceCode,destinationCountry:addr.countryCodeV2}});
     staged.push({orderName:order.name,carrier:entry.carrier});
    }catch(e){failed.push({orderId:a.orderId,error:"Reveal succeeded but queue save failed; do not retry purchase. Contact support."});}
   }
   return Response.json({bulkReveal:{staged,failed,creditsRemaining:body.credits_remaining}});
  }catch(e){console.error("[tracktaco] Bulk reveal error",e);return Response.json({bulkReveal:{error:e instanceof Error?e.message:"Reveal failed; inspect history before retry"}});}
 }
 if(intent==="tracktaco_search"||intent==="tracktaco_reveal"){
  try {
   const key=process.env.TRACKTACO_API_KEY;
   if(!key)throw new Error("TRACKTACO_API_KEY missing");
   const orderId=String(form.get("orderId")||"");
   if(!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId))throw new Error("Invalid order");
   const orderLookupStarted=Date.now();
   console.info("[tracktaco] Shopify shipping destination lookup started",{orderId});
   const check=await admin.graphql(`#graphql
query GetTrackTacoDestination($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2}}}`,{variables:{id:orderId}});
   console.info("[tracktaco] Shopify destination lookup completed",{orderId,ms:Date.now()-orderLookupStarted,httpStatus:check.status});
   const checkPayload=await check.json();
   if(!check.ok||checkPayload.errors?.length)throw new Error("Shopify order lookup failed");
   const order=checkPayload.data?.order;
   if(!order)throw new Error("Order not found");
   const dest=order.shippingAddress;
   if(!dest?.countryCodeV2||!dest.city)throw new Error("Order requires a shipping city and country");
   const api=async(path:string,body:object)=>{
    const started=Date.now();
    console.info("[tracktaco] API request started",{path,orderId,destination:dest.city,region:dest.provinceCode,country:dest.countryCodeV2});
    let res:Response;
    try {
     res=await fetch(`https://v2.tracktaco.com${path}`,{method:"POST",headers:{Authorization:`Bearer ${key}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
    } catch(e) {
     console.error("[tracktaco] API request transport error",{path,orderId,ms:Date.now()-started,error:e instanceof Error?e.name:"Unknown"});
     if(e instanceof Error&&(e.name==="TimeoutError"||e.name==="AbortError"))throw new Error(`TrackTaco API request timed out after ${Math.round((Date.now()-started)/1000)} seconds. No reveal was attempted during free search.`);
     throw e;
    }
    console.info("[tracktaco] API response received",{path,orderId,ms:Date.now()-started,httpStatus:res.status});
    // Read the raw upstream body first so truncated responses become actionable errors.
    const raw=await res.text();
    let json:any=null;
    try { json=raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`TrackTaco returned non-JSON (HTTP ${res.status}; content type ${res.headers.get("content-type") || "unknown"}). No credits confirmed spent. Request ID: ${res.headers.get("x-request-id") || "unavailable"}.`); }
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
    const filter:any={dest:{country:dest.countryCodeV2,city:dest.city.trim().toUpperCase()}};
    if(dest.countryCodeV2==="US"&&dest.provinceCode)filter.dest.state=dest.provinceCode.toUpperCase();
    if(carrier!=="any")filter.carrier=[carrier];
    const search=await api("/v2/tns/search",{searches:[{filter,page_size:25}]});
    console.info("[tracktaco] Free search completed",{orderId,count:search?.searches?.[0]?.results?.length??0});
    if (!Array.isArray(search?.searches) || !search.searches[0]) throw new Error("TrackTaco search returned an unexpected response structure. No credits were spent.");
    const first=search.searches[0];
    return Response.json({tracktaco:{intent,orderId,orderName:order.name,city:dest.city,state:dest.provinceCode,country:dest.countryCodeV2,hits:first.results||[],error:first.error?.message||null}});
   }
   if(form.get("confirmSpend")!=="yes")throw new Error("Credit-spend confirmation required");
   const tnId=String(form.get("tnId")||"");
   if(!/^tn_[a-zA-Z0-9_-]{4,200}$/.test(tnId))throw new Error("Invalid TrackTaco record");
   const revealed=await api("/v2/tns/reveal",{tn_ids:[tnId]});
   const entry=revealed?.results?.[0];
   let staged=false;
   // A destination match creates a review candidate, never proof of shipment ownership.
   if(entry?.outcome==="revealed" && entry.tracking_number && entry.carrier){
     const found=entry.dest;
     const same=(a:unknown,b:unknown)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
     if(!same(found?.city,dest.city)||!same(found?.country,dest.countryCodeV2)||
       (dest.countryCodeV2==="US"&&!same(found?.state,dest.provinceCode))){
       throw new Error("TrackTaco revealed a record with a different destination. No Shopify tracking was changed. Check TrackTaco account history before trying another reveal.");
     }
     await prisma.pendingTracking.upsert({where:{shop_orderId_tnId:{shop:session.shop,orderId,tnId}},
       update:{trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),status:"PENDING",lastError:null},
       create:{shop:session.shop,orderId,orderName:order.name,tnId,trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),destinationCity:dest.city,destinationState:dest.provinceCode,destinationCountry:dest.countryCodeV2}});
     staged=true;
   }
   return Response.json({tracktaco:{intent,orderId,orderName:order.name,city:dest.city,state:dest.provinceCode,country:dest.countryCodeV2,revealed:entry||null,staged,credits_remaining:revealed?.credits_remaining}});
  }catch(e){console.error("[tracktaco] Order lookup/search failed",{intent,error:e instanceof Error?e.message:"Unknown failure"});return Response.json({tracktaco:{intent,error:e instanceof Error?e.message:"Unknown failure"}});}
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
 const batchFetcher=useFetcher<typeof action>();
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
 const resultData=fetcher.data as {results?:Result[];error?:string;tracktaco?:any;bulkSearch?:{results?:any[];error?:string};bulkReveal?:{staged?:any[];failed?:any[];error?:string;creditsRemaining?:number}}|undefined;
 const [batchResults,setBatchResults]=useState<any[]>([]);
 const queueRef=useRef<string[][]>([]);
 const activeRef=useRef(false);
 const [progress,setProgress]=useState({done:0,total:0,active:false});
 const [batchFailures,setBatchFailures]=useState<string[]>([]);
 const launchBulk=()=>{
  const ids=picked.map(([id])=>id).slice(0,100);
  const groups:string[][]=[];
  for(let i=0;i<ids.length;i+=5)groups.push(ids.slice(i,i+5));
  queueRef.current=groups.slice(1);
  activeRef.current=true;
  setBatchResults([]);
  setBatchFailures([]);
  setProgress({done:0,total:ids.length,active:true});
  batchFetcher.submit({intent:"tracktaco_bulk_search",orderIds:JSON.stringify(groups[0])},{method:"post"});
 };
 useEffect(()=>{
  const result=(batchFetcher.data as {bulkSearch?:{results?:any[];error?:string}}|undefined)?.bulkSearch;
  if(!result||!activeRef.current)return;
  const rows=result.results||[];
  setBatchResults(old=>[...old,...rows]);
  if(result.error)setBatchFailures(old=>[...old,result.error!]);
  const processed=rows.length || 5;
  setProgress(old=>({done:Math.min(old.total,old.done+processed),total:old.total,active:queueRef.current.length>0}));
  const next=queueRef.current.shift();
  if(next)batchFetcher.submit({intent:"tracktaco_bulk_search",orderIds:JSON.stringify(next)},{method:"post"});
  else activeRef.current=false;
 },[batchFetcher.data]);
 const [ttOrderId,setTtOrderId]=useState("");
 const [ttCarrier,setTtCarrier]=useState("any");
 const [ttSelected,setTtSelected]=useState<any>(null);
 const [ttHits,setTtHits]=useState<any[]>([]);
 const [ttOrderDest,setTtOrderDest]=useState("");
 const [ttReveal,setTtReveal]=useState<any>(null);

 useEffect(()=>{const t=resultData?.tracktaco;if(!t)return;
  if(t.intent==="tracktaco_search"&&!t.error){setTtHits(t.hits||[]);setTtSelected(null);setTtReveal(null);setTtOrderDest(`${t.orderName} · ${t.city}, ${t.state||t.country}`);}
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
 <s-section heading="Bulk TrackTaco destination search">
  <p>Select up to 100 Shopify orders. The app searches five at a time, automatically continues, and keeps completed results if a later request fails. Free search does not use credits or publish tracking. Leave this tab open while it runs.</p>
  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
   <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={!count||count>100||progress.active||batchFetcher.state!=="idle"||busy} onClick={launchBulk}>Search TrackTaco for {count} selected order(s) — free</button>
   {progress.active&&<button style={button} onClick={()=>{queueRef.current=[];setProgress(old=>({...old,active:false}));}}>Stop after current five</button>}
  </div>
  {count>100&&<p>Select at most 100 orders per search run; previous selections are retained.</p>}
  {progress.total>0&&<div role="status" aria-live="polite" style={{marginTop:12}}>
   <div><strong>{progress.active?"Searching destinations…":"Search run finished"}</strong> {progress.done} of {progress.total} orders processed ({Math.round(100*progress.done/progress.total)}%)</div>
   <progress value={progress.done} max={progress.total} style={{width:"100%",height:18,marginTop:7}} />
   <div style={{fontSize:12,color:"#667085"}}>Completed results appear below as each batch finishes. Some destinations may have no records.</div>
  </div>}
  {batchFailures.map((message,i)=><p key={i} role="alert" style={{color:"#b42318"}}>Batch error: {message}</p>)}
  {!!batchResults.length&&<div style={{marginTop:14,padding:14,border:"1px solid #dde3e9",borderRadius:10}}>
   <strong>Bulk tracking candidates</strong>
   <p>Unfulfilled orders are eligible for lookup and VA review. Orders with existing supplier tracking are skipped before credits are spent. Destination matching alone is not proof that tracking belongs to an order.</p>
   <p>{batchResults.filter(r=>r.hits?.length).length} orders with candidates · Estimated maximum {batchResults.filter(r=>r.hits?.length).reduce((n,r)=>n+Number(r.hits[0]?.reveal_cost_credits??1),0)} credits (actual cost determined by TrackTaco).</p>
   <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={busy||progress.active||!batchResults.some(r=>r.hits?.length)} onClick={()=>{
    const assignments=batchResults.filter(r=>r.hits?.length).map(r=>({orderId:r.orderId,tnId:r.hits[0].tn_id}));
    const credits=batchResults.filter(r=>r.hits?.length).reduce((n,r)=>n+Number(r.hits[0]?.reveal_cost_credits??1),0);
    if(window.confirm(`Reveal ${assignments.length} tracking records? TrackTaco may charge approximately ${credits} credits. Revealed numbers go to your private VA queue, not Shopify.`)) fetcher.submit({intent:"tracktaco_bulk_reveal",assignments:JSON.stringify(assignments),confirmSpend:"yes"},{method:"post"});
   }}>Confirm batch reveal & send to VA queue</button>
   <p style={{fontSize:12}}>Preflight checks run again before credit spending. Any skipped order costs no reveal credits. Review shipment identity before paying.</p>
  </div>}
  {resultData?.bulkReveal?.error&&<p role="alert" style={{color:"#b42318"}}>{resultData.bulkReveal.error}</p>}
  {resultData?.bulkReveal?.staged&&<div role="status"><p>{resultData.bulkReveal.staged.length} records saved for VA review. Credits remaining: {resultData.bulkReveal.creditsRemaining??"check TrackTaco"}. <a href="/app/verification">Open VA Bulk Verification</a></p>{resultData.bulkReveal.failed?.map((v,i)=><p key={i} style={{color:"#b42318"}}>{v.orderId}: {v.error}</p>)}</div>}
  {!!batchResults.length&&<table style={{width:"100%",marginTop:12}}><thead><tr><th>Order</th><th>Destination</th><th>Results</th><th>Next step</th></tr></thead><tbody>{batchResults.map(r=><tr key={r.orderId}><td>{r.orderName}</td><td>{r.city}, {r.state||r.country}</td><td>{r.error||`${r.hits.length} available`}</td><td><button style={button} disabled={!r.hits.length} onClick={()=>{setTtOrderId(r.orderId);setTtOrderDest(`${r.orderName} · ${r.city}, ${r.state||r.country}`);setTtHits(r.hits);setTtSelected(null);setTtReveal(null);}}>Review records</button></td></tr>)}</tbody></table>}
 </s-section>
 <s-section heading="TrackTaco destination lookup · real API test">
 <p>Select an order to search its shipping city and country automatically. For US destinations, the state is also included. Search is free; revealing one record costs credits. Search results do not establish shipment ownership.</p>
 <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:12}}>
  <select aria-label="Order for TrackTaco search" style={button} value={ttOrderId} onChange={e=>{setTtOrderId(e.target.value);setTtHits([]);setTtSelected(null);setTtReveal(null)}}>
   <option value="">Select a loaded order…</option>
   {orders.map(o=><option key={o.id} value={o.id}>{o.name} — {o.shippingAddress?.city||"No city"}, {o.shippingAddress?.provinceCode||"?"}</option>)}
  </select>
  <select style={button} value={ttCarrier} onChange={e=>setTtCarrier(e.target.value)}><option value="any">All carriers</option><option value="ups">UPS</option><option value="fedex">FedEx</option><option value="dhl">DHL</option></select>
  <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={!ttOrderId||busy} onClick={()=>fetcher.submit({intent:"tracktaco_search",orderId:ttOrderId,carrier:ttCarrier},{method:"post"})}>Search TrackTaco for selected order (free)</button>
 </div>
 {ttOrderDest&&<p><strong>Last search:</strong> {ttOrderDest}</p>}
 {resultData?.tracktaco?.error&&<p role="alert" style={{color:"#a12222"}}>{resultData.tracktaco.error}</p>}
 {!!ttHits.length&&<div style={{maxHeight:300,overflow:"auto",border:"1px solid #ddd",borderRadius:8}}>{ttHits.map(h=><label key={h.tn_id} style={{display:"flex",gap:12,padding:10,borderBottom:"1px solid #eee",alignItems:"center"}}><input type="radio" checked={ttSelected?.tn_id===h.tn_id} onChange={()=>setTtSelected(h)}/><strong>{h.carrier?.toUpperCase()}</strong><span>{h.dest?.city}, {h.dest?.state} · {h.status} · {h.est_delivery_date||"Date unknown"}</span><span style={{marginLeft:"auto"}}>{h.reveal_cost_credits??1} credit</span></label>)}</div>}
 {resultData?.tracktaco?.intent==="tracktaco_search"&&!resultData.tracktaco.error&&!ttHits.length&&<p>No destination matches returned.</p>}
 {ttSelected&&<div style={{marginTop:12,padding:14,background:"#f3f5f9",borderRadius:10}}><p>Reveal this record? TrackTaco may charge {ttSelected.reveal_cost_credits??1} credit. This only retrieves existing tracking data; a matching destination does not prove this tracking belongs to your order.</p><button disabled={busy} style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} onClick={()=>fetcher.submit({intent:"tracktaco_reveal",orderId:ttOrderId,tnId:ttSelected.tn_id,confirmSpend:"yes"},{method:"post"})}>Confirm paid reveal</button></div>}
 {ttReveal&&<p role="status"><strong>TrackTaco reveal:</strong> {ttReveal.revealed?.outcome} · {ttReveal.revealed?.carrier} · {ttReveal.revealed?.tracking_number||ttReveal.revealed?.error?.message||"No number"}. Credits left: {ttReveal.credits_remaining??"unavailable"}. {ttReveal.staged?" Saved to VA verification queue; not published to Shopify.":" Not published to Shopify."} <a href="/app/verification">Open VA review</a></p>}
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
  <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={!agree||!count||!valid||count>LIMIT||busy} onClick={()=>fetcher.submit({intent:"fulfill",confirmed:"yes",shipmentVerified:"yes",rows:JSON.stringify(readyRows.map(({id,tracking,carrier})=>({id,tracking,carrier})))},{method:"post"})}>{busy?"Processing…":`Confirm and fulfill ${count} orders`}</button>{" "}
  <button style={button} disabled={busy} onClick={()=>setReview(false)}>Cancel</button>
  <p style={{fontSize:12,color:"#657080"}}>TrackTaco searches and paid reveals are available on the separate API tests page. A TrackTaco record isn't automatically matched to an order merely because the destination and date are similar.</p>
 </s-section>}
 {(resultData?.error||resultData?.results)&&<s-section heading="Fulfillment results">
  {resultData?.error&&<p role="alert">{resultData.error}</p>}
  {resultData?.results?.map(r=><p key={r.id} style={{color:r.ok?"#086c42":"#a12222"}}>{r.ok?"✓ Fulfilled":"✕ Failed"} {r.name}: {r.message}</p>)}
 </s-section>}
 </s-page>;
}
