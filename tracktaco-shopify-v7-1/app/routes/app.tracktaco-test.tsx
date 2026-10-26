import {useFetcher,useLoaderData} from "react-router";
import {useState} from "react";
import type {ActionFunctionArgs,LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
const API="https://v2.tracktaco.com";
async function call(path:string,body?:object){
 const key=process.env.TRACKTACO_API_KEY;
 if(!key)throw new Error("TRACKTACO_API_KEY is missing on Render");
 const response=await fetch(API+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${key}`,Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(`TrackTaco HTTP ${response.status}: ${data?.error?.code||"error"} — ${data?.error?.message||"Request failed"} (${data?.error?.request_id||"no request id"})`);
 return data;
}
export async function loader({request}:LoaderFunctionArgs){await authenticate.admin(request);return {configured:Boolean(process.env.TRACKTACO_API_KEY)};}
export async function action({request}:ActionFunctionArgs){
 await authenticate.admin(request);
 const form=await request.formData(); const intent=String(form.get("intent")||"");
 try{
  if(intent==="check")return Response.json({ok:true,intent,account:await call("/v2/account?limit=5")});
  if(intent==="search"){
   const carrier=String(form.get("carrier")||""); const state=String(form.get("state")||"").trim().toUpperCase();const city=String(form.get("city")||"").trim().toUpperCase();
   if(!["fedex","ups","dhl","any"].includes(carrier))throw new Error("Invalid carrier");
   if(state&&!/^[A-Z]{2}$/.test(state))throw new Error("State must be a two-letter code");
   if(city&&!/^[A-Z\s.'-]{1,80}$/.test(city))throw new Error("Invalid city");
   if(!state&&!city)throw new Error("Provide a destination city or state");
   const filter:any={dest:{country:"US",...(state?{state}:{}),...(city?{city}:{})}};
   if(carrier!=="any")filter.carrier=[carrier];
   return Response.json({ok:true,intent,search:await call("/v2/tns/search",{searches:[{filter,page_size:25}]})});
  }
  if(intent==="reveal"){
   if(form.get("confirmed")!=="yes")throw new Error("Explicit credit-spend confirmation is required");
   const id=String(form.get("tn_id")||"");if(!/^tn_[A-Za-z0-9_-]{4,200}$/.test(id))throw new Error("Invalid tracking record ID");
   return Response.json({ok:true,intent,reveal:await call("/v2/tns/reveal",{tn_ids:[id]})});
  }
  throw new Error("Invalid action");
 }catch(e){return Response.json({ok:false,intent,error:e instanceof Error?e.message:"Request failed"});}
}
const btn={border:"1px solid #b8bdc5",borderRadius:8,padding:"9px 14px",background:"white",cursor:"pointer"};
type Hit={tn_id:string;carrier:string;status?:string;dest?:{city?:string;state?:string;country?:string};reveal_cost_credits?:number};
export default function Test(){
 const {configured}=useLoaderData<typeof loader>(); const f=useFetcher<typeof action>();
 const [carrier,setCarrier]=useState("any"),[state,setState]=useState("TX"),[city,setCity]=useState("");const [selected,setSelected]=useState<Hit|null>(null);
 const result=f.data as any;const hits:Hit[]=result?.intent==="search"&&result.ok?(result.search?.searches?.[0]?.results||[]):[];
 return <s-page heading="TrackTaco · API tests"><s-section heading="Account connection">
 <p>This page tests TrackTaco separately from Shopify fulfillment. Searching costs no credits. Revealing a tracking record can cost credits. Nothing here changes Shopify orders.</p>
 <p>API key: {configured?"Configured on server":"Missing"}</p>
 <f.Form method="post"><input type="hidden" name="intent" value="check"/><button style={btn} type="submit" disabled={!configured||f.state!=="idle"}>Check connection and balance</button></f.Form>
 {result?.ok&&result.intent==="check"&&<p role="status">Connected. Balance: <strong>{result.account?.credits?.balance??"Not returned"}</strong> credits.</p>}
 </s-section><s-section heading="Search real TrackTaco inventory · free">
 <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"end"}}>
 <label>Carrier <select style={btn} value={carrier} onChange={e=>setCarrier(e.target.value)}>{["any","ups","fedex","dhl"].map(c=><option key={c} value={c}>{c.toUpperCase()}</option>)}</select></label>
 <label>US state <input style={btn} maxLength={2} value={state} onChange={e=>setState(e.target.value)}/></label>
 <label>City (optional) <input style={btn} value={city} onChange={e=>setCity(e.target.value)}/></label>
 <button style={btn} disabled={!configured||f.state!=="idle"} onClick={()=>{setSelected(null);f.submit({intent:"search",carrier,state,city},{method:"post"})}}>Search (free)</button>
 </div>
 {result?.ok&&result.intent==="search"&&<><p>{hits.length} matches on this page. Select one to test the paid reveal API.</p>
 <div style={{maxHeight:380,overflowY:"auto"}}>{hits.map(h=><div key={h.tn_id} style={{display:"flex",gap:10,alignItems:"center",padding:8,borderBottom:"1px solid #ddd"}}><input type="radio" checked={selected?.tn_id===h.tn_id} onChange={()=>setSelected(h)}/><span>{h.carrier.toUpperCase()} · {h.status||"Unknown"} · {h.dest?.city||"?"}, {h.dest?.state||"?"}</span><span style={{marginLeft:"auto"}}>{h.reveal_cost_credits??1} credit</span></div>)}</div>
 {result.search?.searches?.[0]?.error&&<p role="alert">{result.search.searches[0].error.message}</p>}</>}
 {selected&&<div style={{padding:14,background:"#f8f8fa",marginTop:15,borderRadius:9}}><strong>Reveal one tracking number?</strong><p>This may spend {selected.reveal_cost_credits??1} credit. The tracking record may belong to another person's shipment. It will NOT be linked to Shopify.</p><button style={{...btn,background:"#1e6147",color:"white"}} disabled={f.state!=="idle"} onClick={()=>f.submit({intent:"reveal",confirmed:"yes",tn_id:selected.tn_id},{method:"post"})}>Confirm paid reveal</button></div>}
 {result?.ok&&result.intent==="reveal"&&<div role="status"><p>Reveal result:</p>{result.reveal?.results?.map((r:any)=><p key={r.tn_id}>{r.outcome}: {r.outcome==="revealed"?`${r.carrier} — ${r.tracking_number}`:r.error?.message||"Not revealed"}</p>)}<p>Credits remaining: {result.reveal?.credits_remaining??"Not returned"}</p></div>}
 </s-section>{result?.ok===false&&<s-section heading="API result"><p role="alert">{result.error}</p></s-section>}</s-page>;
}
