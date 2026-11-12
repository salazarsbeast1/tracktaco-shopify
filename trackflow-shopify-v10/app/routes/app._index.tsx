import {useEffect, useMemo, useRef, useState} from "react";
import {useFetcher, useLoaderData, useSearchParams} from "react-router";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {chunkItems,planBulkCandidates} from "../bulk-planner";
import type {TrackingAssignment} from "../bulk-planner";

type Order = {id:string; name:string; createdAt:string; displayFulfillmentStatus:string; shippingAddress?:{city:string|null;provinceCode:string|null;countryCodeV2:string|null}|null;
 fulfillmentOrders:{nodes:Array<{id:string;status:string;requestStatus:string;assignedLocation:{location:{id:string}} | null}>}};
type OrderRow = {id:string; tracking:string; carrier:string};
type Result = {id:string; name:string; ok:boolean; message:string};
const GET_ORDERS = `#graphql
query BulkOrders($after:String,$reverse:Boolean!,$query:String){orders(first:100,after:$after,sortKey:CREATED_AT,reverse:$reverse,query:$query){
 edges{cursor node{id name createdAt displayFulfillmentStatus shippingAddress{city provinceCode countryCodeV2}}}
 pageInfo{hasNextPage endCursor}
}}`;
const SELECT_ORDERS = `#graphql
query SelectOrders($after:String,$reverse:Boolean!,$query:String){orders(first:250,after:$after,sortKey:CREATED_AT,reverse:$reverse,query:$query){
 edges{node{id name}}
 pageInfo{hasNextPage endCursor}
}}`;
const VERIFY = `#graphql
query VerifyBulkOrder($id:ID!){order(id:$id){id name displayFulfillmentStatus
 fulfillmentOrders(first:40){nodes{id status requestStatus assignedLocation{location{id}}}}
}}`;
const CREATE = `#graphql
mutation CreateVerifiedFulfillment($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){fulfillment{id status trackingInfo{number company}} userErrors{message field}}}`;
const LIMIT = 150; // Separate manual CSV fulfillment limit.
const MAX_TRACKING_SELECTION = 500;
const SEARCH_CHUNK_SIZE = 5;
const REVEAL_CHUNK_SIZE = 25;
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
 if(intent==="select_bulk_orders"){
  try{
   const status=["unfulfilled","partial","all"].includes(String(form.get("status")||""))?String(form.get("status")):"unfulfilled";
   const from=String(form.get("from")||"").slice(0,10);
   const to=String(form.get("to")||"").slice(0,10);
   const search=String(form.get("search")||"").trim().slice(0,60);
   const reverse=String(form.get("sort"))!=="old";
   const terms:string[]=[];
   if(status==="unfulfilled")terms.push("(fulfillment_status:unfulfilled OR fulfillment_status:partial)");
   else if(status==="partial")terms.push("fulfillment_status:partial");
   if(/^\d{4}-\d{2}-\d{2}$/.test(from))terms.push(`created_at:>=${from}`);
   if(/^\d{4}-\d{2}-\d{2}$/.test(to))terms.push(`created_at:<=${to}`);
   if(search)terms.push(`name:${search.replace(/[^a-zA-Z0-9#-]/g,"")}`);
   const rows:Array<{id:string;name:string}>=[];
   let cursor:string|null=null;
   for(let page=0;page<3&&rows.length<MAX_TRACKING_SELECTION;page++){
    const response=await admin.graphql(SELECT_ORDERS,{variables:{after:cursor,reverse,query:terms.join(" AND ")||null}});
    const body=await response.json();
    if(!response.ok||body.errors?.length||!body.data?.orders)throw new Error("Shopify could not load the requested orders");
    rows.push(...(body.data.orders.edges||[]).map((e:any)=>({id:e.node.id,name:e.node.name})));
    if(!body.data.orders.pageInfo.hasNextPage||!body.data.orders.pageInfo.endCursor)break;
    cursor=body.data.orders.pageInfo.endCursor;
   }
   return Response.json({selection:{orders:rows.slice(0,MAX_TRACKING_SELECTION)}});
  }catch(e){return Response.json({selection:{error:e instanceof Error?e.message:"Unable to select matching orders"}});}
 }
 if(intent==="tracktaco_bulk_search"){
  try{
   const key=process.env.TRACKTACO_API_KEY;
   if(!key) throw new Error("TrackTaco API key is not configured");
   const ids=JSON.parse(String(form.get("orderIds")||"[]"));
   if(!Array.isArray(ids)||ids.length<1||ids.length>5||new Set(ids).size!==ids.length||ids.some((id:unknown)=>typeof id!=="string"||!/^gid:\/\/shopify\/Order\/\d+$/.test(id)))throw new Error("Select 1–5 different orders per free search request");
   const orderQuery=`#graphql
query BulkLookup($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2} fulfillments(first:20){id trackingInfo{number}}}}`;
   // Bound each request to five orders: the browser orchestrates up to 500 orders
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
   if(!Array.isArray(assignments)||!assignments.length||assignments.length>REVEAL_CHUNK_SIZE)throw new Error(`Send 1–${REVEAL_CHUNK_SIZE} records per reveal request; the dashboard processes up to 500 automatically`);
   const accepted:Array<{a:{orderId:string;tnId:string};order:any;addr:any}>=[];
   const failed:Array<{orderId:string;error:string}>=[];
   const seenOrders=new Set<string>();
   const seenCandidates=new Set<string>();
   const orderQuery=`#graphql
query VerifyRevealOrder($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2} fulfillments(first:20){id trackingInfo{number}}}}`;
   // Deduplicate and preflight each order independently. One bad record never blocks the batch.
   for(const raw of assignments){
    const orderId=typeof raw?.orderId==="string"?raw.orderId:"";
    const tnId=typeof raw?.tnId==="string"?raw.tnId:"";
    if(!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)||!/^tn_[a-zA-Z0-9_-]{4,200}$/.test(tnId)){
     failed.push({orderId:orderId||"invalid",error:"Skipped invalid order or tracking candidate"});continue;
    }
    if(seenOrders.has(orderId)||seenCandidates.has(tnId)){
     failed.push({orderId,error:"Skipped duplicate order or tracking candidate. No reveal requested."});continue;
    }
    seenOrders.add(orderId);seenCandidates.add(tnId);
    try{
     const res=await admin.graphql(orderQuery,{variables:{id:orderId}});
     const payload=await res.json();const order=payload.data?.order;
     if(!res.ok||payload.errors?.length||!order?.shippingAddress?.city||!order.shippingAddress.countryCodeV2)throw new Error("Unable to read Shopify shipping destination");
     const addr=order.shippingAddress;
     const fulfillments=order.fulfillments||[];
     if(fulfillments.some((f:any)=>(f.trackingInfo||[]).some((t:any)=>Boolean(t.number))))throw new Error("Shopify already has shipment tracking. No reveal purchased.");
     if(fulfillments.length>1)throw new Error("Multiple fulfillments need manual review. No reveal purchased.");
     // An existing pending/published record means this order does not need another paid lookup.
     const previousOrder=await prisma.pendingTracking.findFirst({where:{shop:session.shop,orderId,status:{in:["PENDING","FAILED","PUBLISHED"]}},select:{id:true}});
     if(previousOrder)throw new Error("Already queued or processed for VA review. No reveal purchased.");
     const previousCandidate=await prisma.pendingTracking.findFirst({where:{shop:session.shop,tnId},select:{id:true}});
     if(previousCandidate)throw new Error("Tracking candidate was previously revealed. No new purchase requested.");
     accepted.push({a:{orderId,tnId},order,addr});
    }catch(e){failed.push({orderId,error:e instanceof Error?e.message:"Shopify preflight failed; no reveal requested"});}
   }
   if(!accepted.length)return Response.json({bulkReveal:{staged:[],failed,creditsRequested:0}});
   // One TrackTaco reveal request for the eligible unique records only. Never automatically
   // retry on an uncertain network response, since a retry might purchase the same credits twice.
   const response=await fetch("https://v2.tracktaco.com/v2/tns/reveal",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({tn_ids:accepted.map(x=>x.a.tnId)}),signal:AbortSignal.timeout(55000)});
   const raw=await response.text();let body:any;
   try{body=JSON.parse(raw);}catch{throw new Error(`TrackTaco reveal response unreadable (HTTP ${response.status}). Check TrackTaco history before retrying to avoid double charges.`);}
   if(!response.ok)throw new Error(`TrackTaco reveal HTTP ${response.status}: ${body?.error?.message||"Request failed"}. Check charge history before retrying.`);
   if(!Array.isArray(body?.results))throw new Error("TrackTaco returned no result array. Check purchase history before retrying.");
   const byId=new Map<string,any>(body.results.filter((r:any)=>typeof r?.tn_id==="string").map((r:any)=>[r.tn_id,r]));
   const staged:Array<{orderId:string;orderName:string;carrier:string}>=[];
   const same=(a:unknown,b:unknown)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
   for(let i=0;i<accepted.length;i++){
    const {a,order,addr}=accepted[i];
    // Trust an explicit tn_id. Positional fallback is safe only when the API supplies NO IDs at all.
    const noResultIds=byId.size===0;
    const entry:any=byId.get(a.tnId)||(noResultIds&&body.results.length===accepted.length?body.results[i]:null);
    if(!entry?.tracking_number||!entry?.carrier){failed.push({orderId:a.orderId,error:entry?.error?.message||"No tracking revealed; check purchase history before retrying"});continue;}
    if(!same(entry.dest?.city,addr.city)||!same(entry.dest?.country,addr.countryCodeV2)||(addr.countryCodeV2==="US"&&!same(entry.dest?.state,addr.provinceCode))){failed.push({orderId:a.orderId,error:"Revealed destination differs from Shopify. Not queued; check credit history."});continue;}
    try{
     const inAnotherOrder=await prisma.pendingTracking.findFirst({where:{shop:session.shop,trackingNumber:entry.tracking_number,orderId:{not:a.orderId}},select:{id:true}});
     if(inAnotherOrder){failed.push({orderId:a.orderId,error:"Tracking number already used on another order. Not queued."});continue;}
     await prisma.pendingTracking.upsert({where:{shop_orderId_tnId:{shop:session.shop,orderId:a.orderId,tnId:a.tnId}},update:{trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),status:"PENDING",lastError:null},create:{shop:session.shop,orderId:a.orderId,orderName:order.name,tnId:a.tnId,trackingNumber:entry.tracking_number,carrier:entry.carrier.toUpperCase(),destinationCity:addr.city,destinationState:addr.provinceCode,destinationCountry:addr.countryCodeV2}});
     staged.push({orderId:a.orderId,orderName:order.name,carrier:entry.carrier});
    }catch(e){failed.push({orderId:a.orderId,error:"Reveal succeeded but VA queue save failed. Do not purchase again; contact support."});}
   }
   return Response.json({bulkReveal:{staged,failed,creditsRequested:accepted.length,creditsRemaining:body.credits_remaining}});
  }catch(e){console.error("[tracktaco] Bulk reveal error",e);return Response.json({bulkReveal:{error:e instanceof Error?e.message:"Reveal failed; inspect history before retrying"}});}
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
 const fetcher=useFetcher<typeof action>(); // Separate manual CSV fulfillment
 const searchFetcherA=useFetcher<typeof action>();
 const searchFetcherB=useFetcher<typeof action>();
 const searchFetcherC=useFetcher<typeof action>();
 const revealFetcher=useFetcher<typeof action>();
 const selectionFetcher=useFetcher<typeof action>();
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
 const [batchResults,setBatchResults]=useState<any[]>([]);
 const searchQueueRef=useRef<string[][]>([]);
 const searchActiveRef=useRef(false);
 const searchPendingRef=useRef([0,0,0]);
 const searchStopRef=useRef(false);
 const [progress,setProgress]=useState({done:0,total:0,active:false,stopped:false});
 const [batchFailures,setBatchFailures]=useState<string[]>([]);
 const revealQueueRef=useRef<TrackingAssignment[][]>([]);
 const revealChunkRef=useRef<TrackingAssignment[]>([]);
 const revealActiveRef=useRef(false);
 const [revealProgress,setRevealProgress]=useState({done:0,total:0,staged:0,skipped:0,active:false,creditsRemaining:null as number|null});
 const [revealIssues,setRevealIssues]=useState<string[]>([]);
 const [revealAttempted,setRevealAttempted]=useState(false);
 const [revealStopped,setRevealStopped]=useState(false);
 const processing=busy||progress.active||revealProgress.active||selectionFetcher.state!=="idle";
 const clearSearchPreview=()=>{setBatchResults([]);setBatchFailures([]);setProgress({done:0,total:0,active:false,stopped:false});setRevealAttempted(false);setRevealIssues([]);setRevealStopped(false);setRevealProgress({done:0,total:0,staged:0,skipped:0,active:false,creditsRemaining:null});};
 const change=(o:Order)=>{clearSearchPreview();setSelected(prev=>{const next={...prev};if(next[o.id])delete next[o.id];else if(Object.keys(next).length<MAX_TRACKING_SELECTION)next[o.id]={name:o.name,tracking:"",carrier:"UPS"};return next;});};
 const updateFilters=(key:string,value:string)=>{const p=new URLSearchParams(params);p.set(key,value);p.delete("after");setParams(p);setReview(false)};
 const switchSort=(value:string)=>updateFilters("sort",value);
 const next=()=>{if(nextCursor){const p=new URLSearchParams(params);p.set("after",nextCursor);setParams(p);}setReview(false)};
 const previous=()=>{const p=new URLSearchParams(params);p.delete("after");setParams(p);setReview(false)};
 const resultData=fetcher.data as {results?:Result[];error?:string}|undefined;
 useEffect(()=>{
  const data=(selectionFetcher.data as {selection?:{orders?:Array<{id:string;name:string}>;error?:string}}|undefined)?.selection;
  if(!data?.orders)return;
  setSelected(Object.fromEntries(data.orders.slice(0,MAX_TRACKING_SELECTION).map(o=>[o.id,{name:o.name,tracking:"",carrier:"UPS"}])));
  setReview(false);
  clearSearchPreview();
 },[selectionFetcher.data]);
 const searchWorkers=[searchFetcherA,searchFetcherB,searchFetcherC] as const;
 const startSearchWorker=(slot:0|1|2)=>{
  if(searchStopRef.current)return;
  const chunk=searchQueueRef.current.shift();
  if(!chunk)return;
  searchPendingRef.current[slot]=chunk.length;
  searchWorkers[slot].submit({intent:"tracktaco_bulk_search",orderIds:JSON.stringify(chunk)},{method:"post"});
 };
 const launchBulk=()=>{
  const ids=picked.map(([id])=>id).slice(0,MAX_TRACKING_SELECTION);
  if(!ids.length||progress.active||revealProgress.active)return;
  const groups=chunkItems(ids,SEARCH_CHUNK_SIZE);
  searchQueueRef.current=groups;
  searchPendingRef.current=[0,0,0];
  searchStopRef.current=false;
  searchActiveRef.current=true;
  setBatchResults([]);setBatchFailures([]);setRevealIssues([]);setRevealAttempted(false);setRevealStopped(false);
  setRevealProgress({done:0,total:0,staged:0,skipped:0,active:false,creditsRemaining:null});
  setProgress({done:0,total:ids.length,active:true,stopped:false});
  startSearchWorker(0);startSearchWorker(1);startSearchWorker(2);
 };
 const receiveSearch=(slot:0|1|2,result:{results?:any[];error?:string})=>{
  if(!searchActiveRef.current||!searchPendingRef.current[slot])return;
  const size=searchPendingRef.current[slot];
  searchPendingRef.current[slot]=0;
  if(Array.isArray(result.results))setBatchResults(old=>[...old,...result.results!]);
  if(result.error)setBatchFailures(old=>[...old,`Search group: ${result.error}`]);
  setProgress(old=>({...old,done:Math.min(old.total,old.done+size)}));
  startSearchWorker(slot);
  if(searchPendingRef.current.every(n=>n===0)&&searchQueueRef.current.length===0){
   searchActiveRef.current=false;
   setProgress(old=>({...old,active:false,stopped:searchStopRef.current}));
  }
 };
 useEffect(()=>{const response=(searchFetcherA.data as {bulkSearch?:{results?:any[];error?:string}}|undefined)?.bulkSearch;if(response)receiveSearch(0,response);},[searchFetcherA.data]);
 useEffect(()=>{const response=(searchFetcherB.data as {bulkSearch?:{results?:any[];error?:string}}|undefined)?.bulkSearch;if(response)receiveSearch(1,response);},[searchFetcherB.data]);
 useEffect(()=>{const response=(searchFetcherC.data as {bulkSearch?:{results?:any[];error?:string}}|undefined)?.bulkSearch;if(response)receiveSearch(2,response);},[searchFetcherC.data]);
 // Search results select at most one unique candidate for each order. No Shopify writes.
 const planned=useMemo(()=>planBulkCandidates(batchResults),[batchResults]);
 const submitRevealChunk=(chunk:TrackingAssignment[])=>{
  revealChunkRef.current=chunk;
  revealFetcher.submit({intent:"tracktaco_bulk_reveal",assignments:JSON.stringify(chunk.map(({orderId,tnId})=>({orderId,tnId}))),confirmSpend:"yes"},{method:"post"});
 };
 const launchReveal=()=>{
  if(!planned.assignments.length||progress.active||revealProgress.active||revealAttempted)return;
  const groups=chunkItems(planned.assignments,REVEAL_CHUNK_SIZE);
  setRevealAttempted(true);setRevealIssues([]);setRevealStopped(false);
  setRevealProgress({done:0,total:planned.assignments.length,staged:0,skipped:0,active:true,creditsRemaining:null});
  revealQueueRef.current=groups.slice(1);
  revealActiveRef.current=true;
  submitRevealChunk(groups[0]);
 };
 useEffect(()=>{
  const result=(revealFetcher.data as {bulkReveal?:{staged?:any[];failed?:Array<{orderId:string;error:string}>;error?:string;creditsRemaining?:number}}|undefined)?.bulkReveal;
  if(!result||!revealActiveRef.current)return;
  const current=revealChunkRef.current;
  const staged=result.staged?.length||0;
  const skipped=result.error?current.length:(result.failed?.length||0);
  if(result.error)setRevealIssues(old=>[...old,`A group of ${current.length} orders could not complete: ${result.error}`]);
  else if(result.failed?.length)setRevealIssues(old=>[...old,...result.failed!.map(v=>`${v.orderId.split("/").pop()}: ${v.error}`)]);
  const nextChunk=revealQueueRef.current.shift();
  setRevealProgress(old=>({done:Math.min(old.total,old.done+current.length),total:old.total,staged:old.staged+staged,skipped:old.skipped+skipped,active:!!nextChunk,creditsRemaining:typeof result.creditsRemaining==="number"?result.creditsRemaining:old.creditsRemaining}));
  if(nextChunk)submitRevealChunk(nextChunk);
  else revealActiveRef.current=false;
 },[revealFetcher.data]);
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
   <button style={button} disabled={processing} onClick={()=>{clearSearchPreview();setSelected(prev=>{const next={...prev};for(const o of filtered){if(!all){if(next[o.id]||Object.keys(next).length<MAX_TRACKING_SELECTION)next[o.id]=next[o.id]||{name:o.name,tracking:"",carrier:"UPS"};}else delete next[o.id];}return next;});}}>{all?"Deselect visible":"Select all visible"}</button>
   <button style={button} onClick={()=>{setSelected({});clearSearchPreview();}} disabled={!count||processing}>Clear selection</button>
   <button style={{...button,borderColor:"#077e53",color:"#077e53"}} disabled={processing} onClick={()=>selectionFetcher.submit({intent:"select_bulk_orders",sort,status,from,to,search},{method:"post"})}>{selectionFetcher.state!=="idle"?"Selecting matching orders…":"Select up to 500 matching orders"}</button>
   <button style={button} disabled={processing} onClick={()=>{setParams({sort:"new",status:"unfulfilled"});setSearchDraft("");setFilter("")}}>Reset filters</button>
   <button style={{...button,background:count?"#1d5fd1":"#dfe3e8",color:count?"white":"#444"}} disabled={!count||processing} onClick={()=>{setReview(true);setAgree(false);}}>Manual CSV fulfillment ({count})</button>
  </div>
  {(selectionFetcher.data as {selection?:{error?:string}}|undefined)?.selection?.error&&<p role="alert" style={{color:"#b42318"}}>{(selectionFetcher.data as {selection:{error:string}}).selection.error}</p>}
  <div style={{border:"1px solid #dce1e8",borderRadius:12,overflow:"hidden"}}>
   {filtered.map(o=><label key={o.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 15px",borderBottom:"1px solid #e6e8ec",background:selected[o.id]?"#f0f7ff":"white"}}>
     <input type="checkbox" checked={!!selected[o.id]} onChange={()=>change(o)} disabled={processing||(!selected[o.id]&&count>=MAX_TRACKING_SELECTION)}/>
     <strong style={{minWidth:95}}>{o.name}</strong><span style={{flex:1}}>{new Date(o.createdAt).toLocaleDateString()}</span>
     <span style={{fontSize:12,color:"#586879"}}>{o.displayFulfillmentStatus.replaceAll("_"," ")}</span>
   </label>)}
   {!filtered.length&&<p style={{padding:16}}>No matching unfulfilled orders on this page.</p>}
  </div>
  <div style={{display:"flex",gap:8,marginTop:14,alignItems:"center"}}>
   <button style={button} onClick={previous} disabled={!params.get("after")||processing}>Back to first page</button>
   <button style={button} onClick={next} disabled={!nextCursor||processing}>Next 100 orders →</button>
   <span style={{fontSize:12,color:"#667085"}}>Selections stay checked across pages. Select up to {MAX_TRACKING_SELECTION} orders for bulk TrackTaco lookup. Manual CSV fulfillment separately supports {LIMIT} per submission.</span>
  </div>
 </s-section>
 <s-section heading="Bulk TrackTaco search → VA verification">
  <p>Select up to <strong>500 Shopify orders</strong> across pages. The app automatically searches in small groups (up to three groups at once), finds one unique tracking candidate per eligible order, and prepares a single batch for the VA queue. Free searches do not spend credits or fulfill orders.</p>
  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
   <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={!count||count>MAX_TRACKING_SELECTION||progress.active||revealProgress.active||searchWorkers.some(w=>w.state!=="idle")||revealFetcher.state!=="idle"||busy} onClick={launchBulk}>Search TrackTaco for {count} selected order(s) — free</button>
   {progress.active&&<button style={button} onClick={()=>{searchStopRef.current=true;searchQueueRef.current=[];}}>Stop after current groups</button>}
  </div>
  {count>=MAX_TRACKING_SELECTION&&<p style={{fontSize:12,color:"#667085"}}>500-order selection limit reached. Clear or deselect orders to start another batch.</p>}
  {progress.total>0&&<div role="status" aria-live="polite" style={{marginTop:12}}>
   <div><strong>{progress.active?"Searching orders…":progress.stopped?"Search stopped":"Search finished"}</strong> · {progress.done} of {progress.total} orders processed ({Math.round(100*progress.done/progress.total)}%)</div>
   <progress value={progress.done} max={progress.total} style={{width:"100%",height:18,marginTop:7}} />
   <div style={{fontSize:12,color:"#667085"}}>Completed groups are saved on this page. Keep this tab open until the search is finished.</div>
  </div>}
  {!!batchFailures.length&&<details style={{marginTop:12,color:"#b42318"}}><summary>{batchFailures.length} search group error(s) — see details</summary>{batchFailures.map((message,i)=><p key={i}>{message}</p>)}</details>}
  {!!batchResults.length&&<div style={{marginTop:14,padding:14,border:"1px solid #dde3e9",borderRadius:10}}>
   <strong>Ready to send to VA verification</strong>
   <div style={{display:"flex",gap:18,flexWrap:"wrap",margin:"12px 0"}}>
    <span><strong>{planned.assignments.length}</strong> candidate(s) automatically selected</span>
    <span><strong>{planned.noCandidate}</strong> unavailable / skipped</span>
    <span><strong>{planned.duplicates}</strong> duplicate candidate(s) skipped</span>
   </div>
   <p>One unique candidate is selected automatically for each eligible order. There is no need to open records individually. Existing tracking, already-queued orders and duplicates are checked again before purchasing; ineligible records are skipped without blocking the rest.</p>
   <p><strong>Estimated maximum TrackTaco reveal cost: {planned.estimatedCredits} credits.</strong> Actual charges depend on TrackTaco and the orders that pass the final checks. The free search has not spent credits.</p>
   <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={processing||revealAttempted||!planned.assignments.length||searchWorkers.some(w=>w.state!=="idle")||revealFetcher.state!=="idle"} onClick={launchReveal}>{revealProgress.active?"Sending eligible records to VA queue…":revealAttempted?"Batch already submitted — see results below":`Confirm paid reveal & send ${planned.assignments.length} to VA queue`}</button>
   <p style={{fontSize:12,color:"#667085"}}>Clicking Confirm authorizes TrackTaco credits for eligible reveals. No extra popup or individual selection is required. Revealed records go only to your private VA queue; Shopify is not updated until actual shipment tracking is verified.</p>
  </div>}
  {revealProgress.total>0&&<div role="status" aria-live="polite" style={{marginTop:14,padding:14,border:"1px solid #cde2d7",borderRadius:10,background:"#f2fbf6"}}>
   <strong>{revealProgress.active?"Sending to VA queue…":revealStopped?"Batch stopped after current group":"Batch complete"}</strong>
   <div style={{marginTop:8}}>{revealProgress.done} of {revealProgress.total} processed · <strong>{revealProgress.staged} queued</strong> · {revealProgress.skipped} skipped or unsuccessful</div>
   <progress value={revealProgress.done} max={revealProgress.total} style={{width:"100%",height:18,marginTop:8}}/>
   {revealProgress.active&&<button style={button} onClick={()=>{revealQueueRef.current=[];setRevealStopped(true);}}>Stop after current paid group</button>}
   <p>Credits remaining: {revealProgress.creditsRemaining??"check TrackTaco account"}. A skipped order does not prevent other orders from processing. Some failures may require a purchase-history check before retrying.</p>
   <a href="/app/verification" style={{fontWeight:700}}>Open VA Bulk Verification →</a>
  </div>}
  {!!revealIssues.length&&<details style={{marginTop:12,color:"#9a3412"}}><summary>{revealIssues.length} skipped or unsuccessful order(s) — show details</summary><div style={{maxHeight:240,overflowY:"auto"}}>{revealIssues.map((issue,i)=><p key={i}>{issue}</p>)}</div></details>}
  {progress.total>0&&!progress.active&&!batchResults.length&&<p>No candidate results were returned. See any group errors above and try a new free search; no paid reveal was requested.</p>}
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
  <button style={{...button,background:"linear-gradient(110deg,#086342,#14c87e)",color:"white"}} disabled={!agree||!count||!valid||count>LIMIT||processing} onClick={()=>fetcher.submit({intent:"fulfill",confirmed:"yes",shipmentVerified:"yes",rows:JSON.stringify(readyRows.map(({id,tracking,carrier})=>({id,tracking,carrier})))},{method:"post"})}>{busy?"Processing…":`Confirm and fulfill ${count} orders`}</button>{" "}
  <button style={button} disabled={processing} onClick={()=>setReview(false)}>Cancel</button>
  <p style={{fontSize:12,color:"#657080"}}>The automated TrackTaco workflow above stages tracking for VA verification. This separate manual CSV option is only for carrier tracking independently verified as belonging to an already-shipped order.</p>
 </s-section>}
 {(resultData?.error||resultData?.results)&&<s-section heading="Fulfillment results">
  {resultData?.error&&<p role="alert">{resultData.error}</p>}
  {resultData?.results?.map(r=><p key={r.id} style={{color:r.ok?"#086c42":"#a12222"}}>{r.ok?"✓ Fulfilled":"✕ Failed"} {r.name}: {r.message}</p>)}
 </s-section>}
 </s-page>;
}
