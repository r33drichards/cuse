import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('workerd scoped acknowledgment resumes queued work with restricted replies and no warning replay',{timeout:90000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-recovery-diagnostic-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-diagnostic',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:true,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 let id='';const requestId='d'.repeat(32),expiresAt=Date.now()+1200000;
 const start=(selected?:string)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_GAP_ACK:'true',TEST_SIMPLE:'true',TEST_LONG_GRANT:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(selected?{CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([selected]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([selected]),CUSE_RECOVERY_GAP_ACK_REQUEST:JSON.stringify({id:requestId,sessionId:id,expiresAt,incarnation:'a'.repeat(32),generation:1})}:{})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();const stats=async()=>await (await app.fetch('/test/gap-ack-stats')).json() as any;
 try{
  assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);assert.equal((await app.fetch('/test/gap-ack-seed')).status,200);
  const req=signed(event());assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(req.headers),body:await req.text()})).status,202);
  id=((await (await app.fetch('/test/subscription-recovery-id')).json()) as {id:string}).id;
  await new Promise(r=>setTimeout(r,1200));const before=await stats();assert.equal(before.acks.length,0);assert.equal(before.replies.length,0);assert.equal(before.jobs[0].state,'pending');const warning=before.effectRows[0];
  await app.stop();app=await start((id[0]==='a'?'b':'a')+id.slice(1));await new Promise(r=>setTimeout(r,1200));const other=await stats();assert.equal(other.acks.length,0);assert.equal(other.replies.length,0);assert.equal(other.jobs[0].attempts,0);
  await app.stop();app=await start(id);let observed:any;
  for(let n=0;n<150;n++){observed=await stats();if(observed.replies.length===1)break;await new Promise(r=>setTimeout(r,100));}
  assert.deepEqual(observed.replies,[{text:'scheduled reply',full_control:0}]);assert.equal(observed.acks.length,1);assert.equal(observed.acks[0].previous_error,'send_uncertain');assert.equal(observed.acks[0].outcome,'unknown_delivery_accepted_without_replay');
  assert.deepEqual(observed.effectRows.find((r:any)=>r.id===warning.id),{...warning,state:'acknowledged_uncertain'});assert.equal(observed.jobs[0].payload,before.jobs[0].payload);assert.equal(observed.jobs[0].state,'done');assert.equal(observed.calls.find((r:any)=>r.kind==='model')?.n,1);
  await app.stop();app=await start(id);await new Promise(r=>setTimeout(r,1400));const restarted=await stats();assert.deepEqual(restarted.replies,observed.replies);assert.deepEqual(restarted.acks,observed.acks);
  assert.equal((await app.fetch('/test/diagnostic-seed')).status,200);const next=signed(event(2),Date.now(),secret,event(2).eventId);assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(next.headers),body:await next.text()})).status,202);await new Promise(r=>setTimeout(r,1400));const blocked=await stats();assert.deepEqual(blocked.replies,observed.replies);assert.equal(blocked.jobs[1].state,'pending');assert.equal(blocked.jobs[1].attempts,0);assert.equal(blocked.effectRows.find((r:any)=>r.id==='synthetic-uncertain').state,'uncertain');
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
