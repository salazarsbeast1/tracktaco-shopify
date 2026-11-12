import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkItems,planBulkCandidates} from '../app/bulk-planner.ts';

test('500 orders are split into safe groups without dropping orders',()=>{
 const ids=Array.from({length:500},(_,i)=>`gid://shopify/Order/${1000+i}`);
 const searchGroups=chunkItems(ids,5);
 assert.equal(searchGroups.length,100);
 assert.ok(searchGroups.every(g=>g.length<=5));
 assert.deepEqual(searchGroups.flat(),ids);
 const revealGroups=chunkItems(ids,25);
 assert.equal(revealGroups.length,20);
 assert.ok(revealGroups.every(g=>g.length<=25));
 assert.deepEqual(revealGroups.flat(),ids);
});

test('automatically selects 500 distinct candidates, no individual review needed',()=>{
 const results=Array.from({length:500},(_,i)=>({orderId:`gid://shopify/Order/${1000+i}`,hits:[{tn_id:`tn_candidate${i}`,reveal_cost_credits:1}]}));
 const plan=planBulkCandidates(results);
 assert.equal(plan.assignments.length,500);
 assert.equal(plan.estimatedCredits,500);
 assert.equal(plan.noCandidate,0);
 assert.equal(plan.duplicates,0);
 assert.equal(new Set(plan.assignments.map(a=>a.tnId)).size,500);
});

test('duplicate order and duplicate candidate are skipped, while alternatives are chosen',()=>{
 const rows=[
  {orderId:'gid://shopify/Order/1',hits:[{tn_id:'tn_shared'}]},
  {orderId:'gid://shopify/Order/1',hits:[{tn_id:'tn_duplicate'}]},
  {orderId:'gid://shopify/Order/2',hits:[{tn_id:'tn_shared'},{tn_id:'tn_different'}]},
  {orderId:'gid://shopify/Order/3',hits:[{tn_id:'tn_shared'}]},
  {orderId:'gid://shopify/Order/4',hits:[]},
  {orderId:'gid://shopify/Order/5',error:'Already fulfilled',hits:[]},
 ];
 const plan=planBulkCandidates(rows);
 assert.deepEqual(plan.assignments.map(a=>a.orderId),['gid://shopify/Order/1','gid://shopify/Order/2']);
 assert.deepEqual(plan.assignments.map(a=>a.tnId),['tn_shared','tn_different']);
 assert.equal(plan.duplicates,2);
 assert.equal(plan.noCandidate,2);
});

test('invalid candidate data does not stop other orders',()=>{
 const plan=planBulkCandidates([
  null,
  {orderId:'gid://shopify/Order/1',hits:[{tn_id:'invalid!'}]},
  {orderId:'gid://shopify/Order/2',hits:[{tn_id:'tn_valid',reveal_cost_credits:2}]},
 ]);
 assert.equal(plan.assignments.length,1);
 assert.equal(plan.estimatedCredits,2);
});

test('rejects invalid batch size',()=>{
 assert.throws(()=>chunkItems([1,2],0));
});
