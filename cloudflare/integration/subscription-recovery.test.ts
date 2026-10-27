import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
for(const kind of ['expired','gap'])test(`workerd automatically recovers ${kind} subscription without losing queued work`,{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-subscription-recovery-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-recovery',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 const start=(automatic=false)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_SUBSCRIPTION_RECOVERY:kind,WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(automatic?{CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_GAP_POLICY:kind==='gap'?'resume':'hold',CUSE_RECOVERY_MIN_DELAY_MS:'1000',CUSE_RECOVERY_MAX_DELAY_MS:'4000'}:{})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();
 const stats=async()=>await (await app.fetch('/test/subscription-recovery-stats')).json() as any;
 const post=async()=>{const r=signed(event(),Date.now());return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 const waitFor=async(predicate:(s:any)=>boolean)=>{for(let n=0;n<200;n++){const s=await stats();if(predicate(s))return s;await new Promise(r=>setTimeout(r,100));}assert.fail('recovery did not reach expected state');};
 try{
  assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/subscription-recovery-seed')).status,200);
  assert.equal((await post()).status,202);await new Promise(r=>setTimeout(r,1200));assert.equal((await stats()).calls.length,0);
  await app.stop();app=await start(true);
  const done=await waitFor(s=>s.inbox.some((r:any)=>r.state==='done') && s.replies.some((r:any)=>r.text==='Recovered queued work.'));
  assert.equal(done.grant[0].state,'active');assert.equal(done.calls.find((r:any)=>r.kind==='renew').n,2);assert.equal(done.calls.find((r:any)=>r.kind==='model').n,1);
  assert.equal(done.audits.length,kind==='gap'?1:0);assert.equal(done.replies.filter((r:any)=>r.text.includes('history gap')).length,kind==='gap'?1:0);
  await app.stop();app=await start(true);assert.deepEqual(await (await post()).json(),{status:'duplicate'});
  await new Promise(r=>setTimeout(r,1200));const reopened=await stats();assert.equal(reopened.calls.find((r:any)=>r.kind==='model').n,1);assert.equal(reopened.replies.length,done.replies.length);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
