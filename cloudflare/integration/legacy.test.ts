import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {unstable_dev} from 'wrangler';
import {digest} from '../src/protocol.ts';
import {route,secret,event,signed} from '../test/helpers.ts';import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('workerd reopens the exact legacy tool selection without replaying peer or desktop effects',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-legacy-worker-'));
 const names=['get_artifact','get_artifact_upload_url','list_artifacts','run_js','irc_send','agent_list','agent_ask','desktop_control','goal_status','goal_update'];
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-legacy',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:names.map(name=>({name,description:'synthetic legacy schema',inputSchema:{type:'object',additionalProperties:true},target:['get_artifact','get_artifact_upload_url','list_artifacts','run_js'].includes(name)?'desktop':'host'})),compatibility:{legacyGoals:true,peers:[{channel:'#other',nick:'other-agent',buffer:'irc.docker.#other'}]},desktopBinding:{kind:'existing',desktopId:'synthetic-desktop'},desktopId:'synthetic-desktop',policy:{modelRequests:3,toolCalls:12,timeoutMs:10000,peerTurns:0,peerNicks:['other-agent'],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 const start=(goal=false)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_LEGACY_GOAL:String(goal),TEST_LEGACY:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence)},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();const post=async(n:number,text:string)=>{const e=event(n);e.data.text=text;const r=signed(e,Date.now(),secret,e.eventId);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 const stats=async()=>await (await app.fetch('/test/stats')).json() as any;const count=(s:any,k:string)=>s.calls.find((r:any)=>r.kind===k)?.n??0;
 const waitFor=async(p:(s:any)=>boolean)=>{for(let i=0;i<200;i++){const s=await stats();if(p(s))return s;await new Promise(r=>setTimeout(r,100));}assert.fail(JSON.stringify(await stats()));};
 try{
 assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);assert.equal((await post(1,'synthetic human request')).status,202);
 const first=await waitFor(s=>count(s,'send')===1);assert.equal(count(first,'tool'),4);assert.ok(count(first,'peer-send')>1);assert.equal(count(first,'model'),2);
 await app.stop();app=await start();assert.deepEqual(await (await post(1,'synthetic human request')).json(),{status:'duplicate'});await new Promise(r=>setTimeout(r,1200));const reopened=await stats();assert.equal(count(reopened,'peer-send'),count(first,'peer-send'));assert.equal(count(reopened,'tool'),4);
 assert.equal((await post(2,',goal add :: synthetic objective')).status,202);await waitFor(s=>count(s,'send')===2);
 await app.stop();app=await start();assert.equal((await post(3,',goal list')).status,202);const done=await waitFor(s=>count(s,'send')===3);assert.equal(count(done,'model'),2,'read-only goal commands survive restart without new model calls');
 const envelope={kind:'question',requestId:'agent-'+'a'.repeat(64),source:'#other',target:route.channel,rootId:'agent-'+'a'.repeat(64),ancestry:['#other',route.channel],text:'synthetic peer question'};
 const bytes=new TextEncoder().encode(JSON.stringify(envelope)),hash=await digest(bytes),parts=Buffer.from(bytes).toString('base64').match(/.{1,200}/g)!;
 const postPart=async(i:number)=>{const e=event(100+i);e.data.nick='other-agent';e.data.text=`${route.nick}: cuse-peer-v1 ${hash} ${i}/${parts.length} ${parts[i]}`;const r=signed(e,Date.now(),secret,e.eventId);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 for(let i=parts.length-1;i>=0;i--)assert.equal((await postPart(i)).status,202);
 const answered=await waitFor(s=>count(s,'send')===4);assert.equal(count(answered,'model'),4);assert.ok(count(answered,'peer-send')>count(first,'peer-send'));
 await app.stop();app=await start();for(let i=0;i<parts.length;i++)assert.deepEqual(await (await postPart(i)).json(),{status:'duplicate'});await new Promise(r=>setTimeout(r,1000));assert.equal(count(await stats(),'peer-send'),count(answered,'peer-send'));
 await app.stop();app=await start(true);assert.equal((await post(200,',goal start '+event(2).eventId+' 2')).status,202);const reviewed=await waitFor(s=>count(s,'send')===6);assert.equal(count(reviewed,'model'),6);assert.ok(!reviewed.inbox.some((r:any)=>r.state==='blocked'));
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
