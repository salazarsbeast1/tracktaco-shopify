import {useState} from "react";
import {useFetcher, useLoaderData} from "react-router";
import type {ActionFunctionArgs,LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import prisma from "../db.server";

const FIND_FULFILLMENTS=`#graphql
query ReviewOrder($id:ID!){order(id:$id){id name shippingAddress{city provinceCode countryCodeV2} fulfillments(first:20){id status trackingInfo{number company}}}}`;
const UPDATE=`#graphql
mutation UpdateTracking($id:ID!,$tracking:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking){fulfillment{id trackingInfo{number company}} userErrors{field message}}}`;
export async function loader({request}:LoaderFunctionArgs){
 const {session}=await authenticate.admin(request);
 const rows=await prisma.pendingTracking.findMany({where:{shop:session.shop},orderBy:{createdAt:"desc"},take:300});
 return {rows:rows.map(r=>({...r,createdAt:r.createdAt.toISOString(),reviewedAt:r.reviewedAt?.toISOString()||null}))};
}
export async function action({request}:ActionFunctionArgs){
 const {admin,session}=await authenticate.admin(request);
 const form=await request.formData();
 let selections:{id:string;inspected:boolean}[];
 try{selections=JSON.parse(String(form.get("rows")||"[]"));}catch{return Response.json({error:"Invalid selection"},{status:400});}
 if(!Array.isArray(selections)||!selections.length||selections.length>100||new Set(selections.map(x=>x.id)).size!==selections.length) return Response.json({error:"Select 1–100 distinct records"},{status:400});
 const intent=String(form.get("intent")||"");
 if(intent==="remove"){
  const ids=selections.map(r=>r.id);
  const updated=await prisma.pendingTracking.updateMany({
   where:{shop:session.shop,id:{in:ids},status:{in:["PENDING","FAILED","REJECTED","PUBLISHED"]}},
   data:{status:"ARCHIVED",reviewedAt:new Date(),verificationNote:"Removed from VA review queue",lastError:null}
  });
  return Response.json({removed:updated.count});
 }
 if(form.get("confirmed")!=="yes")return Response.json({error:"Verification confirmation required"},{status:400});
 if(form.get("intent")==="approve"&&selections.some(r=>r.inspected!==true))return Response.json({error:"Review every selected record before approval"},{status:400});
 if(!["approve","reject"].includes(intent))return Response.json({error:"Unknown action"},{status:400});
 const results=[];
 for(const row of selections){
  try{
   const record=await prisma.pendingTracking.findFirst({where:{shop:session.shop,id:row.id,status:{in:["PENDING","FAILED"]}}});
   if(!record)throw new Error("Record is no longer pending");
   if(intent==="reject"){
    await prisma.pendingTracking.update({where:{id:record.id},data:{status:"REJECTED",reviewedAt:new Date(),verificationNote:"Rejected during batch review"}});
    results.push({id:record.id,ok:true,message:"Rejected"});continue;
   }
   const verificationNote="Reviewer confirmed this tracking belongs to this order’s actual shipment during batch verification";
   const response=await admin.graphql(FIND_FULFILLMENTS,{variables:{id:record.orderId}});
   const payload=await response.json();
   if(!response.ok||payload.errors?.length)throw new Error(payload.errors?.[0]?.message||"Shopify lookup failed");
   const order=payload.data?.order;
   if(!order)throw new Error("Order not found");
   const addr=order.shippingAddress;
   const same=(a:unknown,b:unknown)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
   if(!same(addr?.city,record.destinationCity)||!same(addr?.countryCodeV2,record.destinationCountry)||!same(addr?.provinceCode,record.destinationState))throw new Error("Order address changed since search; recheck tracking");
   const fulfillments=order.fulfillments||[];
   if(fulfillments.length!==1)throw new Error("Expected exactly one existing fulfillment. No tracking changed; review split/unfulfilled orders separately.");
   const fulfillment=fulfillments[0];
   if(fulfillment.trackingInfo?.some((t:any)=>t.number===record.trackingNumber)){
    await prisma.pendingTracking.update({where:{id:record.id},data:{status:"PUBLISHED",verificationNote,reviewedAt:new Date(),lastError:null}});
    results.push({id:record.id,ok:true,message:"Tracking already present in Shopify"});continue;
   }
   // Do not silently overwrite an actual tracking number already provided by the supplier.
   if(fulfillment.trackingInfo?.length)throw new Error("Supplier tracking already exists. Review manually before replacing existing tracking.");
   const mutation=await admin.graphql(UPDATE,{variables:{id:fulfillment.id,tracking:{number:record.trackingNumber,company:record.carrier==="FEDEX"?"FedEx":record.carrier}}});
   const responseBody=await mutation.json();
   if(!mutation.ok||responseBody.errors?.length)throw new Error(responseBody.errors?.[0]?.message||"Shopify update failed");
   const result=responseBody.data?.fulfillmentTrackingInfoUpdate;
   if(result?.userErrors?.length)throw new Error(result.userErrors.map((e:any)=>e.message).join("; "));
   if(!result?.fulfillment?.id)throw new Error("Shopify did not confirm tracking update");
   await prisma.pendingTracking.update({where:{id:record.id},data:{status:"PUBLISHED",reviewedAt:new Date(),verificationNote,lastError:null}});
   results.push({id:record.id,ok:true,message:`Tracking updated on ${order.name}`});
  }catch(error){
   const message=error instanceof Error?error.message:"Unexpected error";
   if(intent==="approve")await prisma.pendingTracking.updateMany({where:{shop:session.shop,id:row.id,status:{in:["PENDING","FAILED"]}},data:{status:"FAILED",lastError:message}});
   results.push({id:row.id,ok:false,message});
  }
 }
 return Response.json({results});
}
const field:React.CSSProperties={padding:8,border:"1px solid #ccd4dd",borderRadius:7};
export default function Verification(){
 const {rows}=useLoaderData<typeof loader>();
 const fetcher=useFetcher<typeof action>();
 const [selected,setSelected]=useState<Record<string,boolean>>({});
 const [inspected,setInspected]=useState<Record<string,boolean>>({});
 const [acknowledged,setAcknowledged]=useState(false);
 const [status,setStatus]=useState("PENDING");
 const items=rows.filter(r=>status==="HISTORY" ? ["PUBLISHED","REJECTED","ARCHIVED"].includes(r.status) : ["PENDING","FAILED"].includes(r.status));
 const available=items.filter(r=>["PENDING","FAILED"].includes(r.status));
 const chosen=available.filter(r=>selected[r.id]);
 const markVisibleReviewed=()=>setInspected(p=>({...p,...Object.fromEntries(available.map(r=>[r.id,true]))}));
 const removeRows=(ids:string[])=>{
  if(!ids.length||busy)return;
  if(!window.confirm(`Remove ${ids.length} record(s) from the VA queue? This archives the review records, not the Shopify orders.`))return;
  fetcher.submit({intent:"remove",rows:JSON.stringify(ids.map(id=>({id,inspected:false})))},{method:"post"});
  setSelected(p=>({...p,...Object.fromEntries(ids.map(id=>[id,false]))}));
 };
 const submit=(intent:"approve"|"reject")=>fetcher.submit({intent,confirmed:acknowledged?"yes":"no",rows:JSON.stringify(chosen.map(r=>({id:r.id,inspected:!!inspected[r.id]})))},{method:"post"});
 const busy=fetcher.state!=="idle";
 const fmtStatus=(x:string)=>x.charAt(0)+x.slice(1).toLowerCase();
 const pill=(x:string):React.CSSProperties=>({display:"inline-block",padding:"3px 9px",borderRadius:999,fontWeight:700,fontSize:11,background:x==="PUBLISHED"?"#d2f7e7":x==="FAILED"?"#fee4e2":x==="PENDING"?"#fff1c4":"#f2f4f7",color:x==="PUBLISHED"?"#067647":x==="FAILED"?"#b42318":x==="PENDING"?"#915b00":"#344054"});
 return <s-page heading="TrackTaco · VA Bulk Verification">
  <s-section>
   <div style={{padding:"14px 4px 18px"}}>
    <h2 style={{margin:"0 0 8px",fontSize:21}}>Review TrackTaco records before publishing</h2>
    <p style={{margin:0,color:"#475467"}}>Review the tracking records, remove orders you don’t need, then verify the selected shipments and update Shopify in one batch.</p>
    <p style={{padding:12,background:"#eef7ff",borderRadius:8,color:"#175cd3",fontSize:13}}>TrackTaco records stay private until reviewed. Destination matching alone does not prove a number belongs to a shipment; verify each selected record against actual shipment evidence.</p>
   </div>
   <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
    <label>Status <select style={field} value={status} onChange={e=>setStatus(e.target.value)}><option value="PENDING">Needs review (pending + failed)</option><option value="HISTORY">History (published + removed)</option></select></label>
    <button style={field} disabled={busy||!available.length} onClick={()=>setSelected(Object.fromEntries(available.map(r=>[r.id,true])))}>Select all visible</button>
    <button style={field} disabled={busy} onClick={()=>setSelected({})}>Clear</button>
    <button style={{...field,borderColor:"#fda29b",color:"#b42318",background:"#fff5f3"}} disabled={!chosen.length||busy} onClick={()=>removeRows(chosen.map(r=>r.id))}>Remove selected ({chosen.length})</button>
    <button style={field} disabled={busy||!available.length} onClick={markVisibleReviewed}>Mark all visible reviewed</button>
    <strong style={{marginLeft:"auto"}}>{chosen.length} selected</strong>
   </div>
   <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr>{["Select","Shopify order","Destination","Carrier","Tracking","Status","Reviewed actual shipment?","Actions"].map(h=><th key={h} style={{textAlign:"left",padding:"12px 9px",background:"#f8fafc",borderBottom:"1px solid #ccd4dd",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead><tbody>{items.map(r=><tr key={r.id} style={{borderBottom:"1px solid #e5e7eb"}}>
    <td style={{padding:9}}><input aria-label={`Select ${r.orderName}`} type="checkbox" disabled={busy||!(["PENDING","FAILED"].includes(r.status))} checked={!!selected[r.id]} onChange={e=>setSelected(p=>({...p,[r.id]:e.target.checked}))}/></td>
    <td style={{padding:9,fontWeight:600}}>{r.orderName}</td><td style={{padding:9}}>{r.destinationCity}, {r.destinationState||r.destinationCountry}</td><td style={{padding:9}}>{r.carrier}</td><td style={{padding:9,fontFamily:"monospace"}}>{r.trackingNumber}</td><td style={{padding:9}}><span style={pill(r.status)}>{fmtStatus(r.status)}</span>{r.lastError&&<p style={{color:"#b42318",fontSize:11}}>{r.lastError}</p>}</td>
    <td style={{padding:9,minWidth:165}}>{["PENDING","FAILED"].includes(r.status)?<label><input type="checkbox" checked={!!inspected[r.id]} onChange={e=>setInspected(p=>({...p,[r.id]:e.target.checked}))}/> Shipment reviewed</label>:r.verificationNote||"—"}</td>
    <td style={{padding:9}}><button type="button" title={`Remove ${r.orderName} from queue`} aria-label={`Remove ${r.orderName} from queue`} disabled={busy} onClick={()=>removeRows([r.id])} style={{...field,color:"#b42318",borderColor:"#fda29b",padding:"6px 10px"}}>Remove</button></td>
   </tr>)}</tbody></table></div>
   {!items.length&&<p>{status==="HISTORY" ? "No completed or archived records yet." : "You’re all caught up! No tracking records need verification."}</p>}
   <label style={{display:"block",marginTop:14}}><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/> I confirm that each selected record was reviewed against its actual shipment, and its tracking number belongs to the specified order.</label>
   <div style={{display:"flex",gap:10,marginTop:14,alignItems:"center",flexWrap:"wrap"}}><button style={{...field,background:"#008060",color:"white",fontWeight:700}} disabled={!chosen.length||busy||!acknowledged||chosen.some(r=>!inspected[r.id])} onClick={()=>submit("approve")}>{busy?"Processing…":`Verify selected & Update Shopify (${chosen.length})`}</button><button style={field} disabled={!chosen.length||busy||!acknowledged} onClick={()=>submit("reject")}>Reject selected</button></div>
   {fetcher.data&&"removed" in fetcher.data&&<p role="status">Archived {fetcher.data.removed} record(s) from the queue. Shopify orders and tracking are unchanged.</p>}
   {fetcher.data?.error&&<p role="alert">{fetcher.data.error}</p>}
   {fetcher.data?.results&&<div role="status" style={{marginTop:14}}><p>Successful Shopify updates move straight to History and disappear from Needs review. Failed updates remain here.</p>{fetcher.data.results.map(r=><p key={r.id} style={{color:r.ok?"#136a42":"#b42318"}}>{r.ok?"✓":"✕"} {r.message}</p>)}</div>}
   <p style={{fontSize:12,color:"#667085",marginTop:16}}>Successfully published tracking automatically leaves this queue and stays accessible under History. Removing a record archives it without deleting a Shopify order. Updates require one eligible existing fulfillment and will not automatically overwrite supplier tracking.</p>
  </s-section>
 </s-page>;
}
