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
 const start=(pending=true,warmup=false)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_SIMPLE:'true',WEBHOOK_ROUTES:JSON.stringify({test:{...binding,activationPending:pending}}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(warmup?{CUSE_OPERATOR_WARMUP:request.id}:{CUSE_OPERATOR_PARTS:'1',CUSE_OPERATOR_PART_0:gzipSync(JSON.stringify(request)).toString('base64')})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start(true,true);
 const post=async(value:unknown=event())=>{const r=signed(value);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 try{
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
  await app.stop();app=await start(false);assert.equal((await post()).status,202);
  let done=false;for(let i=0;i<120;i++){const stats=await (await app.fetch('/test/stats')).json() as any;if(stats.calls.some((r:any)=>r.kind==='send' && r.n===1)){assert.equal(stats.calls.find((r:any)=>r.kind==='model').n,1);done=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(done);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
