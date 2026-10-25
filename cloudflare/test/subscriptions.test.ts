import test from "node:test";
import assert from "node:assert/strict";
import {subscribe,unsubscribe,renewalAt,type SubscriptionSpec} from "../src/subscriptions.ts";
import {route,secret} from "./helpers.ts";
test("real MCP methods preserve exact args, callback and opaque cursor on refresh",async()=>{
 const calls:{method:string;params:Record<string,unknown>}[]=[];
 const spec:SubscriptionSpec={arguments:{channel_id:route.buffer,trigger:"mention",nick:route.nick},callback:"https://example.invalid/events/test",secret,ttlMs:3600000};
 const grant={id:"sub",refreshBefore:new Date(100000).toISOString(),cursor:"opaque-not-sequence",truncated:false};
 const rpc=async(method:string,params:Record<string,unknown>)=>{calls.push({method,params});return grant;};
 assert.equal(calls.length,0);await subscribe(rpc,spec);await subscribe(rpc,spec,grant.cursor);await unsubscribe(rpc,spec);
 assert.deepEqual(calls.map(c=>c.method),["events/subscribe","events/subscribe","events/unsubscribe"]);
 assert.equal(calls[1].params.cursor,grant.cursor);assert.deepEqual(calls[0].params.arguments,spec.arguments);
 assert.ok(!JSON.stringify(calls[2]).includes(secret));assert.equal(renewalAt(grant,0),75000);
 assert.throws(()=>renewalAt({...grant,truncated:true},0),/review_required/);
 assert.throws(()=>renewalAt(grant,100000),/review_required/);
});
import {Renewal} from "../src/renewal.ts";
import {database} from "./helpers.ts";
test("renewal is explicitly armed, bounded and persists attempts across controller restart",async()=>{
 const {db,sql}=database();try{
 let r=new Renewal(sql);let calls=0;
 const spec:SubscriptionSpec={arguments:{channel_id:route.buffer,trigger:"message"},callback:"https://example.invalid/events/test",secret,ttlMs:100000};
 const rpc=async()=>{calls++;throw Error("private");};
 await r.alarm(rpc,spec,0);assert.equal(calls,0);
 r.arm({id:"sub",refreshBefore:new Date(100000).toISOString(),cursor:null,truncated:false},0);
 await r.alarm(rpc,spec,75000);r=new Renewal(sql);await r.alarm(rpc,spec,77000);await r.alarm(rpc,spec,81000);await r.alarm(rpc,spec,90000);
 assert.equal(calls,3);assert.equal(r.deadline(),undefined);
 }finally{db.close();}
});
test('expiry, changed grant and truncated replay stop renewal and invalidate active admission',async()=>{
 const spec:SubscriptionSpec={arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',secret,ttlMs:100000};
 for(const next of [{id:'different',truncated:false},{id:'sub',truncated:true}]){
  const {db,sql}=database();try{const r=new Renewal(sql);r.arm({id:'sub',refreshBefore:new Date(100000).toISOString(),cursor:null,truncated:false},0);
  assert.equal(r.valid(1),true);await r.alarm(async()=>({...next,refreshBefore:new Date(200000).toISOString(),cursor:null}),spec,75000);
  assert.equal(r.valid(75000),false);assert.equal(r.deadline(),undefined);assert.equal(sql.all('SELECT state FROM cuse_grant')[0].state,'coverage-gap');
  }finally{db.close();}
 }
 const {db,sql}=database();try{const r=new Renewal(sql);r.arm({id:'sub',refreshBefore:new Date(100000).toISOString(),cursor:null,truncated:false},0);let calls=0;
 await r.alarm(async()=>{calls++;throw Error();},spec,100000);assert.equal(calls,0);assert.equal(r.valid(100000),false);
 }finally{db.close();}
});
