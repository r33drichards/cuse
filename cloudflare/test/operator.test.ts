import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {operate,decodeOperator,type OperatorRequest} from '../src/operator.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
import type {Binding} from '../src/worker.ts';
import {route} from './helpers.ts';

async function fixture(){
  const now=Date.now();
  const snapshot:Snapshot={version:1,sourceSessionId:'approved-fresh-start',route:{...route,agent:route.channel},model:{provider:'synthetic',modelId:'chosen'},thinkingLevel:'off',instructions:'',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:8,toolCalls:32,timeoutMs:240000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
  const hash=await snapshotHash(snapshot);
  const request:OperatorRequest={version:1,id:'a'.repeat(32),expiresAt:now+600000,routeKey:'test',snapshot,fence:{snapshotHash:hash,generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true},grant:{id:route.subscriptionId,refreshBefore:new Date(now+3600000).toISOString(),cursor:null,truncated:false}};
  const binding:Binding={activationPending:true,route:snapshot.route,secret:'synthetic-private-canary',access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic-private-canary'},fullControl:false,enabledHash:hash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
  const calls:unknown[]=[];
  const target=(key:string)=>({activateReviewed:async(...args:unknown[])=>{calls.push({key,args});}});
  return {now,request,binding,calls,target};
}
test('operator is inert without a secret and rejects expired requests before addressing an object',async()=>{
  const f=await fixture();assert.equal(await operate(undefined,{},f.target,f.now),'disabled');
  f.request.expiresAt=f.now;assert.equal(await operate(JSON.stringify(f.request),{test:f.binding},f.target,f.now),'expired');assert.equal(f.calls.length,0);
});
test('reviewed private request targets only the exact immutable generation and existing grant',async()=>{
  const f=await fixture();assert.equal(await operate(JSON.stringify(f.request),{test:f.binding},f.target,f.now),'completed');
  assert.equal(f.calls.length,1);assert.deepEqual((f.calls[0] as any).args,[f.request.id,f.request.snapshot,f.request.fence,f.request.grant]);
});
test('changed identity, snapshot, ownership, lease, callback or grant fails before mutation',async()=>{
  for(const change of [
    (f:any)=>{f.request.snapshot.policy.toolCalls++;},
    (f:any)=>{f.binding.route={...f.binding.route,nick:'different'};},
    (f:any)=>{f.binding.access.enabledHash='unreviewed';},
    (f:any)=>{f.binding.activationPending=false;},
    (f:any)=>{f.request.fence.legacyOwnerReleased=false;},
    (f:any)=>{f.request.fence.identityVerified=false;},
    (f:any)=>{f.request.grant.id='different';},
    (f:any)=>{f.request.grant.refreshBefore='invalid';},
    (f:any)=>{f.binding.subscription.arguments.trigger='unknown';},
    (f:any)=>{f.binding.subscription.ttlMs=0;},
    (f:any)=>{f.request.grant.truncated=true;},
    (f:any)=>{f.request.grant.refreshBefore=new Date(f.now-1).toISOString();},
    (f:any)=>{f.request.expiresAt=f.now+1800001;},
    (f:any)=>{f.binding.subscription.callback='https://example.invalid/events/other';},
    (f:any)=>{f.binding.subscription.arguments.channel_id='irc.other.#other';},
  ]){
    const f=await fixture();change(f);await assert.rejects(operate(JSON.stringify(f.request),{test:f.binding},f.target,f.now));assert.equal(f.calls.length,0);
  }
});
test('oversized requests fail without copying history into a manifest row',async()=>{
  const f=await fixture();f.request.snapshot.archive=['x'.repeat(500000)];await assert.rejects(operate(JSON.stringify(f.request),{test:f.binding},f.target,f.now),/operator_request_size/);assert.equal(f.calls.length,0);
});

test('bounded secret chunks preserve large exact schemas and reject missing or oversized parts',()=>{
 const raw=JSON.stringify({tools:'schema'.repeat(50000)}),encoded=gzipSync(raw).toString('base64');
 const env:Record<string,string>={CUSE_OPERATOR_PARTS:'1',CUSE_OPERATOR_PART_0:encoded};
 assert.equal(decodeOperator(env),raw);assert.equal(decodeOperator({}),undefined);
 assert.throws(()=>decodeOperator({CUSE_OPERATOR_PARTS:'33'}));
 assert.throws(()=>decodeOperator({CUSE_OPERATOR_PARTS:'2',CUSE_OPERATOR_PART_0:encoded}));
 assert.throws(()=>decodeOperator({CUSE_OPERATOR_PARTS:'1',CUSE_OPERATOR_PART_0:'a'.repeat(4801)}));
 assert.throws(()=>decodeOperator({CUSE_OPERATOR_PARTS:'1',CUSE_OPERATOR_PART_0:gzipSync('x'.repeat(500001)).toString('base64')}));
});
