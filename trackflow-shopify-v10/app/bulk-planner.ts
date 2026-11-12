/**
 * Pure helpers for the 500-order bulk search/reveal flow.
 * These do not purchase tracking, stage records, or fulfill Shopify orders.
 */
export type TrackingAssignment = {orderId:string;tnId:string;cost:number};
export type SearchRow = {
  orderId?:string;
  error?:string|null;
  hits?:Array<{tn_id?:string;reveal_cost_credits?:number|null}>;
} | null;

export function chunkItems<T>(items:readonly T[], size:number):T[][] {
  if(!Number.isInteger(size)||size<=0)throw new Error("Chunk size must be a positive integer");
  const groups:T[][]=[];
  for(let i=0;i<items.length;i+=size)groups.push(items.slice(i,i+size));
  return groups;
}

export function planBulkCandidates(rows:readonly SearchRow[]) {
  const seenOrders=new Set<string>();
  const usedCandidates=new Set<string>();
  const assignments:TrackingAssignment[]=[];
  let noCandidate=0, duplicates=0;
  for(const row of rows){
    if(!/^gid:\/\/shopify\/Order\/\d+$/.test(row?.orderId||"")||row?.error){noCandidate++;continue;}
    const orderId=row.orderId!;
    if(seenOrders.has(orderId)){duplicates++;continue;}
    seenOrders.add(orderId);
    const hits=Array.isArray(row.hits)?row.hits:[];
    const candidate=hits.find(hit=>/^tn_[a-zA-Z0-9_-]{4,200}$/.test(hit?.tn_id||"")&&!usedCandidates.has(hit.tn_id!));
    if(!candidate){if(hits.length)duplicates++;else noCandidate++;continue;}
    const tnId=candidate.tn_id!;
    usedCandidates.add(tnId);
    const rawCost=Number(candidate.reveal_cost_credits??1);
    assignments.push({orderId,tnId,cost:Number.isFinite(rawCost)&&rawCost>=0?rawCost:1});
  }
  return {assignments,noCandidate,duplicates,estimatedCredits:assignments.reduce((sum,a)=>sum+a.cost,0)};
}
