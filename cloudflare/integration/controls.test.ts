import {channelPlanHash,type ChannelPlan} from '../src/channels.ts';import {objectKey} from '../src/protocol.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('workerd command receipts and scheduled alarm survive eviction without duplicate model or sends',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-controls-worker-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 const dynamicRoute={...snapshot.route,channel:'#fresh',buffer:'irc.docker.#fresh',subscriptionId:'pending'};const dynamicSnapshot={...snapshot,route:dynamicRoute};
 const dynamicSecret='whsec_'+Buffer.alloc(32,11).toString('base64');
 const plan:ChannelPlan={key:'fresh',controller:objectKey(snapshot.route),fresh:true,bootstrap:snapshot.route,snapshot:dynamicSnapshot,binding:{...binding,route:dynamicRoute,secret:dynamicSecret,access:{...binding.access,fullControl:true,exclusiveProfile:true},subscription:{...binding.subscription,arguments:{channel_id:dynamicRoute.buffer,trigger:'message'},callback:'https://example.invalid/events/fresh'}},approvedHash:''};plan.approvedHash=await channelPlanHash(plan);
 const start=()=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{MODEL_CREDENTIAL_KEY:Buffer.alloc(32,8).toString('base64'),CHANNEL_PLANS:JSON.stringify([plan]),TEST_SIMPLE:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence)},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();
 const post=async(n:number,text:string)=>{const e=event(n);e.data.text=text;const r=signed(e,Date.now(),secret,e.eventId);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 const stats=async()=>await (await app.fetch('/test/stats')).json() as any;
 const count=(s:any,k:string)=>s.calls.find((r:any)=>r.kind===k)?.n??0;
 const waitFor=async(p:(s:any)=>boolean)=>{for(let i=0;i<150;i++){const s=await stats();if(p(s))return s;await new Promise(r=>setTimeout(r,100));}assert.fail('worker did not reach expected state');};
 try{
  assert.equal((await app.fetch('/test/auth/seed')).status,200);
  assert.deepEqual(await (await app.fetch('/test/auth/verify')).json(),{same:true,hasAuth:true,refreshes:1,encrypted:true});
  assert.deepEqual(await (await app.fetch('/test/skills')).json(),{beforeLoad:true,integrity:true,root:true,support:true,calls:4});
  assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);
  assert.equal((await post(10,',schedule once 5s :: scheduled synthetic task')).status,202);
  const created=await waitFor(s=>count(s,'send')===1);assert.equal(count(created,'model'),0);
  await app.stop();app=await start();
  assert.deepEqual(await (await post(10,',schedule once 5s :: scheduled synthetic task')).json(),{status:'duplicate'});
  const ran=await waitFor(s=>count(s,'model')===1 && count(s,'send')===2);assert.equal(count(ran,'tool'),0);
  assert.equal((await post(11,',model missing/model')).status,202);await waitFor(s=>count(s,'send')===3);
  assert.equal((await post(12,'ordinary request after invalid model')).status,202);await waitFor(s=>count(s,'model')===2 && count(s,'send')===4);
  await app.stop();app=await start();await new Promise(r=>setTimeout(r,1500));assert.deepEqual(await (await app.fetch('/test/auth/verify')).json(),{same:true,hasAuth:true,refreshes:1,encrypted:true});const restored=await stats();assert.equal(count(restored,'model'),2);assert.equal(count(restored,'send'),4);
  assert.equal((await post(13,',join #fresh')).status,202);await waitFor(s=>count(s,'send')===5);
  const dynamic=event(30);dynamic.data.channel_id=dynamicRoute.buffer;dynamic.data.text=dynamicRoute.nick+': new channel prompt';const request=signed(dynamic,Date.now(),dynamicSecret,dynamic.eventId);request.headers.set('x-mcp-subscription-id','synthetic-dynamic');
  assert.equal((await app.fetch('/events/fresh',{method:'POST',headers:Object.fromEntries(request.headers),body:await request.text()})).status,202);
  let dynamicDone=false;for(let i=0;i<100;i++){const state=await (await app.fetch('/test/dynamic/stats')).json() as any;if(count(state,'send')===1){assert.equal(count(state,'model'),1);dynamicDone=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(dynamicDone,'dynamic registry must route the signed event into its prepared session');

 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
