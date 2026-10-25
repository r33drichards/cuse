import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {ActiveSession} from '../src/active.ts';import {dryRun,importSnapshot,snapshotHash,type Snapshot} from '../src/migration.ts';
import {ShadowJournal} from '../src/journal.ts';import {DesktopLedger} from '../src/desktop-coordinator.ts';import {database,route,event} from './helpers.ts';
export function snapshot(provider='faux'):Snapshot{return {version:1,sourceSessionId:'old-session',route:{...route,agent:route.channel},model:{provider,modelId:'chosen'},thinkingLevel:'off',instructions:'Keep exact prior instructions.',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:3000,peerTurns:2,peerNicks:['peer'],mentionRequired:false},archive:[{id:'old',text:'retained history'}],context:[{role:'user',content:'remembered question',timestamp:1}],retainedState:{budget:'retained'},blockers:[]};}
async function fixture(s?:Snapshot){
 const dir=mkdtempSync(join(tmpdir(),'cuse-active-'));const faux=fauxProvider({models:[{id:'chosen'},{id:'other'}]});
 const models=createModels();models.setProvider(faux.provider);const snap=s??snapshot(faux.provider.id);snap.model.provider=faux.provider.id;
 const fence={snapshotHash:await snapshotHash(snap),generation:route.generation,after:route.after,legacyOwnerReleased:true as const,identityVerified:true as const};
 let calls=0;const lockDb=database();const ledger=new DesktopLedger(lockDb.sql);
 const options={snapshot:snap,fence,models,gateway:{call:async()=>{calls++;return {content:[{type:'text',text:'tool result'}]};}},desktop:{acquire:async(id:string)=>ledger.acquire(id),verify:async(t:any)=>ledger.verify(t),settle:async(t:any,ok:boolean)=>ledger.settle(t,ok)},wake:async()=>{},report:()=>{}};
 let active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);
 return {faux,options,get active(){return active;},get calls(){return calls;},ledger,lockDb,async reopen(){await active.close();active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);},async close(){await active.close();lockDb.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('active Pi retains imported context, executes a real synthetic model and deduplicates after reopen',async()=>{
 const f=await fixture();try{
 f.faux.setResponses([async c=>{assert.ok(JSON.stringify(c).includes('remembered question'));return fauxAssistantMessage('reply');}]);
 assert.deepEqual(await f.active.handle(event()),['reply']);assert.equal(f.faux.state.callCount,1);
 await f.reopen();assert.deepEqual(await f.active.handle(event()),['reply']);assert.equal(f.faux.state.callCount,1);
 const conversation=(await f.active.harness.conversation(f.active.conversationId,ctx))!;assert.equal((await conversation.agent(ctx)).model?.modelId,'chosen');
 }finally{await f.close();}
});
test('model validation failure does not mutate settings; valid selection survives restart',async()=>{
 const f=await fixture();try{
 const bad={...event(),data:{...event().data,text:',model missing/model'}};
 assert.match((await f.active.handle(bad))[0],/unchanged/);
 const good={...event(2),data:{...event(2).data,text:`,model ${f.faux.provider.id}/other`}};
 await f.active.handle(good);await f.reopen();
 assert.equal((await (await f.active.harness.conversation(f.active.conversationId,ctx))!.agent(ctx)).model?.modelId,'other');
 }finally{await f.close();}
});
test('remote tools run once through persisted intent and shared desktop ownership',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'run_js',description:'existing tool',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 assert.deepEqual(await f.active.handle(event()),['done']);assert.equal(f.calls,1);
 await f.reopen();await f.active.handle(event());assert.equal(f.calls,1);
 assert.equal(f.lockDb.sql.all('SELECT state FROM cuse_desktop')[0].state,'idle');
 }finally{await f.close();}
});
test('uncertain desktop error holds ownership and prevents model/tool retries',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'run_js',description:'existing tool',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
 let calls=0;f.options.gateway.call=async()=>{calls++;throw Error('private failure');};
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('must not run')]);
 await assert.rejects(f.active.handle(event()));assert.equal(calls,1);assert.equal(f.faux.state.callCount,1);
 assert.throws(()=>f.ledger.acquire('other-conversation'),/reconciliation/);
 await f.reopen();await assert.rejects(f.active.handle(event(2)));assert.equal(calls,1);
 }finally{await f.close();}
});
test('import dry run is read-only, cutover and content conflicts fail closed',async()=>{
 const s=snapshot();const plan=await dryRun(s);const j=await ShadowJournal.open(await openNodeSqliteStorage(':memory:'));
 try{const fence={snapshotHash:plan.hash,generation:route.generation,after:route.after,legacyOwnerReleased:true as const,identityVerified:true as const};
 await assert.rejects(importSnapshot(j.harness,s,{...fence,snapshotHash:'wrong'}),/review_required/);
 const id=await importSnapshot(j.harness,s,fence);assert.equal(await importSnapshot(j.harness,s,fence),id);
 const changed={...s,instructions:'changed'};await assert.rejects(importSnapshot(j.harness,changed,{...fence,snapshotHash:await snapshotHash(changed)}),/import_conflict/);
 const c=(await j.harness.conversation(id,ctx))!;assert.equal((await c.entries({},100,undefined,ctx)).items.length,2);
 }finally{await j.close();}
});
test('desktop fencing persists, rejects stale release and does not expire uncertain work',()=>{
 const {db,sql}=database();try{let l=new DesktopLedger(sql);const ticket=l.acquire('one');l=new DesktopLedger(sql);assert.throws(()=>l.acquire('two'),/reconciliation/);l.settle(ticket,false);assert.throws(()=>l.acquire('three'),/reconciliation/);l.reconcile(ticket);const newer=l.acquire('two');assert.ok(newer.fence>ticket.fence);assert.throws(()=>l.settle(ticket,true),/fence_rejected/);}finally{db.close();}
});
test('model and tool budgets are durable pre-call limits, not advisory hooks',async()=>{
 const s=snapshot();s.policy.modelRequests=1;s.tools=[{name:'read',description:'read',inputSchema:{type:'object',properties:{}},target:'irc'}];
 const f=await fixture(s);try{
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('read',{})],{stopReason:'toolUse'}),fauxAssistantMessage('over budget')]);
  await assert.rejects(f.active.handle(event()));assert.equal(f.faux.state.callCount,1);assert.equal(f.calls,1);
  await f.reopen();await assert.rejects(f.active.handle(event()));assert.equal(f.faux.state.callCount,1);
 }finally{await f.close();}
 const t=snapshot();t.policy.toolCalls=1;t.tools=s.tools;const g=await fixture(t);try{
  g.faux.setResponses([fauxAssistantMessage([fauxToolCall('read',{}),fauxToolCall('read',{})],{stopReason:'toolUse'}),fauxAssistantMessage('one tool allowed')]);
  await g.active.handle(event());assert.equal(g.calls,1);
 }finally{await g.close();}
});
test('shared rooms cannot change models; peers cannot issue control commands',async()=>{
 const s=snapshot();s.route=route;const f=await fixture(s);try{
 assert.deepEqual(await f.active.handle({...event(),data:{...event().data,text:`${route.nick}: ,model ${f.faux.provider.id}/other`}}),[]);
 assert.deepEqual(await f.active.handle({...event(2),data:{...event(2).data,nick:'peer',text:`${route.nick}: ,stop`}}),[]);
 assert.equal(f.faux.state.callCount,0);
 }finally{await f.close();}
});
