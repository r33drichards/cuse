import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('actual workerd continues beyond eight calls across alarm checkpoints without repeating tools',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-active-worker-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-old',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[{name:'run_js',description:'test remote tool',inputSchema:{type:'object',properties:{step:{type:'number'}}},target:'desktop'}],desktopBinding:{kind:'existing',desktopId:'synthetic-desktop'},desktopId:'synthetic-desktop',policy:{modelRequests:8,toolCalls:32,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[{synthetic:true}],context:[{role:'user',content:'old context',timestamp:1}],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 const start=(holdTool=false)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_LONG_TURN:'true',TEST_LONG_GRANT:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence)},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();const post=async(n=1)=>{const r=signed(event(n),Date.now(),secret,event(n).eventId);return app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(r.headers),body:await r.text()});};
 const stats=async()=>await (await app.fetch('/test/stats')).json() as any;
 const waitFor=async(predicate:(s:any)=>boolean)=>{for(let i=0;i<250;i++){const s=await stats();if(predicate(s))return s;await new Promise(r=>setTimeout(r,100));}assert.fail('worker did not reach expected durable state');};
 try{
 assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);assert.equal((await post()).status,202);
 const done=await waitFor(s=>s.inbox.some((r:any)=>r.state==='done') && s.effects.some((r:any)=>r.state==='dispatched'));
 assert.equal(done.calls.find((r:any)=>r.kind==='tool').n,12);assert.equal(done.calls.find((r:any)=>r.kind==='model').n,13);assert.equal(done.calls.find((r:any)=>r.kind==='send').n,1);
 assert.deepEqual(await (await post()).json(),{status:'duplicate'});assert.deepEqual((await stats()).calls,done.calls);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
