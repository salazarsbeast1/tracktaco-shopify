// Run with Node 20+: TRACKTACO_API_KEY='tt_test_...' node scripts/tracktaco-smoke-test.mjs account
// Optional paid test: TRACKTACO_API_KEY='tt_live_...' node scripts/tracktaco-smoke-test.mjs reveal tn_... --spend-one-credit
const key = process.env.TRACKTACO_API_KEY;
if (!key) { console.error('Set TRACKTACO_API_KEY in your terminal environment.'); process.exit(1); }
const mode = process.argv[2] || 'account';
async function req(path, method='GET', body) {
 const response = await fetch('https://v2.tracktaco.com'+path,{method,headers:{Authorization:`Bearer ${key}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const data = await response.json().catch(()=>({error:{message:'Non-JSON response'}}));
 if (!response.ok) { console.error(`HTTP ${response.status}`,data.error||data); process.exitCode=1; return null; }
 return data;
}
if (mode==='account') {
 const d=await req('/v2/account?limit=1'); if(d) console.log(JSON.stringify({connected:true,credits:d.credits?.balance},null,2));
} else if(mode==='search') {
 const destState=process.argv[3]||'TX';
 const d=await req('/v2/tns/search','POST',{searches:[{filter:{dest:{country:'US',state:destState},status:['pre-transit','transit']},page_size:5}]});
 if(d) console.log(JSON.stringify({results:d.searches?.[0]?.results?.map(({tn_id,carrier,status,dest,reveal_cost_credits})=>({tn_id,carrier,status,dest,reveal_cost_credits})),error:d.searches?.[0]?.error},null,2));
} else if(mode==='reveal') {
 const id=process.argv[3];
 if(!id?.startsWith('tn_')||process.argv[4]!=='--spend-one-credit') { console.error('Usage: node scripts/tracktaco-smoke-test.mjs reveal tn_... --spend-one-credit');process.exit(1); }
 const d=await req('/v2/tns/reveal','POST',{tn_ids:[id]});if(d)console.log(JSON.stringify(d,null,2));
} else {console.error('Mode must be account, search, or reveal');process.exit(1);}
