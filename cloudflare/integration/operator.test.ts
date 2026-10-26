import {gzipSync} from 'node:zlib';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('private operator initializes once across restart, holds signed delivery, and exposes no admin HTTP endpoint',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-operator-worker-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'approved-fresh',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:8,toolCalls:32,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const grant={id:route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false};
 const request={version:1,id:'b'.repeat(32),expiresAt:Date.now()+600000,routeKey:'test',snapshot,fence,grant};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 const existing={...binding,route:{...binding.route,agent:'#existing',channel:'#existing',buffer:'irc.docker.#existing',profile:'existing-native',subscriptionId:'existing-sub'},secret:'whsec_'+Buffer.alloc(32,9).toString('base64')};
 const start=(pending=true,warmup=false)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_SIMPLE:'true',TEST_SINGLE_REPLY_ALARM:'true',TEST_MANY_MODELS:'true',WEBHOOK_ROUTES:JSON.stringify({existing}),CUSE_AGENT_TEST:JSON.stringify({binding:{...binding,activationPending:pending},modelConfig:{},modelSecrets:{}}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(warmup?{CUSE_OPERATOR_WARMUP:request.id}:{CUSE_OPERATOR_PARTS:'1',CUSE_OPERATOR_PART_0:gzipSync(JSON.stringify(request)).toString('base64')})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start(true,true);
 const post=async(value:unknown=event())=>{const r=signed(value);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 try{
  const oldEvent=()=>({...event(999),data:{...event(999).data,channel_id:existing.route.buffer}});
  const postExisting=async()=>{const value=oldEvent(),r=signed(value,Date.now(),existing.secret,value.eventId);r.headers.set('x-mcp-subscription-id',existing.route.subscriptionId);return app.fetch('/events/existing',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
  assert.equal((await postExisting()).status,202,'existing live route must remain open while the new agent is staged');
  assert.equal((await app.fetch('/test/operate')).status,200);
  assert.equal(((await (await app.fetch('/test/operator-stats')).json()) as any).receipts,0,'warming cannot initialize an agent');
  await app.stop();app=await start();
  assert.equal((await app.fetch('/operator',{method:'POST'})).status,404);
  assert.equal((await post()).status,503);
  const challenge=await post({type:'verification',challenge:'synthetic'});assert.equal(challenge.status,200);assert.deepEqual(await challenge.json(),{challenge:'synthetic'});
  assert.equal((await app.fetch('/test/operate')).status,200);
  const first=await (await app.fetch('/test/operator-stats')).json();assert.equal((first as any).receipts,1);
  await app.stop();app=await start();assert.equal((await app.fetch('/test/operate')).status,200);
  assert.deepEqual(await (await app.fetch('/test/operator-stats')).json(),first,'operator receipt survives eviction without resetting grant deadline');
  assert.equal((await post()).status,503);
  await app.stop();app=await start(false);assert.equal((await post()).status,202);assert.equal((await postExisting()).status,202,'existing route remains open after added-agent activation');
  let done=false;for(let i=0;i<120;i++){const stats=await (await app.fetch('/test/stats')).json() as any;if(stats.calls.some((r:any)=>r.kind==='send' && r.n===1)){assert.equal(stats.calls.find((r:any)=>r.kind==='model').n,1);done=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(done);
  const list=event(2);list.data.text=',models';const listing=signed(list,Date.now(),secret,list.eventId);
  assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(listing.headers),body:await listing.text()})).status,202);
  let listed=false;for(let i=0;i<250;i++){const state=await (await app.fetch('/test/stats')).json() as any;if(state.calls.some((r:any)=>r.kind==='send' && r.n===16)){assert.ok(!state.effects.some((r:any)=>r.state==='uncertain'));assert.equal(state.calls.find((r:any)=>r.kind==='model').n,1,'model browsing must not call the model');listed=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(listed,'15-line catalog must drain across alarm budgets without an uncertain 13th line');

 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
