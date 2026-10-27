import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unstable_dev} from 'wrangler';import {route,secret,signed,event} from '../test/helpers.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
const managed=['status','read','write','validate','activate'].map(n=>'weechat_managed_script_'+n).sort();
test('workerd managed JS catalog is exact-session opt-in, preserves saved snapshot and does not replay writes on restart',{timeout:90000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-managed-js-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic-managed-js',route:{...route,agent:route.channel},model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic only',tools:[{name:'weechat_buffers',description:'Read buffers',inputSchema:{type:'object',properties:{}},target:'irc'},{name:'weechat_command_manifest',description:'Generic command surface forbidden in restricted mode',inputSchema:{type:'object',properties:{}},target:'irc'}],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:8,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const binding={route:snapshot.route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:true,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',ttlMs:3600000}};
 let id='',other='';
 const start=(selected?:string)=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{TEST_MANAGED_JS:'true',TEST_LONG_GRANT:'true',WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),...(id?{CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([id,other]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([id,other])}:{}),...(selected?{CUSE_MANAGED_JS_SESSION_IDS:JSON.stringify([selected])}:{})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();const stats=async()=>await (await app.fetch('/test/managed-js-stats')).json() as any;
 const post=async(n:number)=>{const e=event(n),req=signed(e,Date.now(),secret,e.eventId);assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(req.headers),body:await req.text()})).status,202);};
 const completed=async(n:number)=>{let observed:any;for(let k=0;k<150;k++){observed=await stats();if(observed.calls.find((r:any)=>r.kind==='send')?.n===n)return observed;await new Promise(r=>setTimeout(r,100));}assert.fail('queued reply did not complete: '+JSON.stringify(observed));};
 try{
  assert.equal((await app.fetch('/test/setup')).status,200);assert.equal((await app.fetch('/test/arm')).status,200);const prepared=(await stats()).prepared;
  id=((await (await app.fetch('/test/subscription-recovery-id')).json()) as {id:string}).id;other=(id[0]==='a'?'b':'a')+id.slice(1);
  await app.stop();app=await start();await post(1);const disabled=await completed(1);
  assert.deepEqual(JSON.parse(disabled.catalogs[0].names),['weechat_buffers']);assert.deepEqual(disabled.tools,[]);assert.equal(disabled.prepared,prepared);
  await app.stop();app=await start(other);await post(2);const nonselected=await completed(2);assert.deepEqual(nonselected.tools,[]);assert.deepEqual(JSON.parse(nonselected.catalogs.at(-1).names),['weechat_buffers']);assert.equal(nonselected.prepared,prepared);
  await app.stop();app=await start(id);await post(3);const selected=await completed(3);
  assert.deepEqual(JSON.parse(selected.catalogs.at(-1).names).sort(),['weechat_buffers',...managed].sort());assert.deepEqual(selected.tools.map((r:any)=>r.name).sort(),managed);assert.equal(selected.prepared,prepared);assert.equal(JSON.parse(selected.prepared).fence.snapshotHash,fence.snapshotHash);assert.deepEqual(JSON.parse(selected.prepared).snapshot,snapshot);
  await app.stop();app=await start(id);await post(3);await new Promise(r=>setTimeout(r,1500));const reopened=await stats();assert.deepEqual(reopened.tools,selected.tools);assert.deepEqual(reopened.catalogs,selected.catalogs);assert.equal(reopened.calls.find((r:any)=>r.kind==='send')?.n,3);assert.equal(reopened.prepared,prepared);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
