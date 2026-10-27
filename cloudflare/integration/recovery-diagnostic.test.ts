import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('workerd one-shot diagnostic observes adapter without clearing uncertain effects or running queued work',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-recovery-diagnostic-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-diagnostic',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:true,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 let id='';const requestId='d'.repeat(32),expiresAt=Date.now()+1200000;
 const start=(selected?:string)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_LONG_GRANT:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(selected?{CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([selected]),CUSE_RECOVERY_DIAGNOSTIC_REQUEST:JSON.stringify({id:requestId,sessionId:id,expiresAt})}:{})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();const stats=async()=>await (await app.fetch('/test/diagnostic-stats')).json() as any;
 try{
  assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);assert.equal((await app.fetch('/test/diagnostic-seed')).status,200);
  const req=signed(event());assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(req.headers),body:await req.text()})).status,202);
  id=((await (await app.fetch('/test/subscription-recovery-id')).json()) as {id:string}).id;
  await new Promise(r=>setTimeout(r,1200));assert.equal((await stats()).diagnostic.length,0);
  await app.stop();app=await start((id[0]==='a'?'b':'a')+id.slice(1));await new Promise(r=>setTimeout(r,1200));assert.equal((await stats()).diagnostic.length,0);
  await app.stop();app=await start(id);let observed:any;
  for(let n=0;n<100;n++){observed=await stats();if(observed.diagnostic[0]?.state==='complete')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(observed.diagnostic[0]?.configured_full_control,1);assert.equal(observed.diagnostic[0]?.required_tool_present,0);
  assert.equal(observed.calls.find((r:any)=>r.kind==='diagnostic')?.n,1);assert.equal(observed.calls.find((r:any)=>r.kind==='model'),undefined);
  assert.deepEqual(observed.effects,[{state:'uncertain',n:1}]);assert.deepEqual(observed.inbox,[{state:'pending',n:1}]);
  await app.stop();app=await start(id);await new Promise(r=>setTimeout(r,1400));const reopened=await stats();
  assert.equal(reopened.calls.find((r:any)=>r.kind==='diagnostic')?.n,1);assert.deepEqual(reopened.effects,observed.effects);assert.deepEqual(reopened.inbox,observed.inbox);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
