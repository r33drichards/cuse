import {Runner} from '../src/runner.ts';
import {objectKey} from '../src/protocol.ts';
import {Automations} from '../src/automations.ts';import {InboxStore} from '../src/store.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {ActiveSession,RestrictedPeerDenial} from '../src/active.ts';import {dryRun,importSnapshot,snapshotHash,type Snapshot} from '../src/migration.ts';
import {ModelFailure,responseMetadata} from '../src/provider-response.ts';
import {ShadowJournal} from '../src/journal.ts';import {DesktopLedger} from '../src/desktop-coordinator.ts';import {database,route,event} from './helpers.ts';
export function snapshot(provider='faux'):Snapshot{return {version:1,sourceSessionId:'old-session',route:{...route,agent:route.channel},model:{provider,modelId:'chosen'},thinkingLevel:'off',instructions:'Keep exact prior instructions.',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:3000,peerTurns:2,peerNicks:['peer'],mentionRequired:false},archive:[{id:'old',text:'retained history'}],context:[{role:'user',content:'remembered question',timestamp:1}],retainedState:{budget:'retained'},blockers:[]};}
async function fixture(s?:Snapshot,api?:string,restrictedIrc=false,peers?:import('../src/legacy/peers.ts').PeerMailbox){
 const dir=mkdtempSync(join(tmpdir(),'cuse-active-'));const faux=fauxProvider({api,models:[{id:'chosen'},{id:'other'}]});
 const models=createModels();models.setProvider(faux.provider);const snap=s??snapshot(faux.provider.id);snap.model.provider=faux.provider.id;
 const fence={snapshotHash:await snapshotHash(snap),generation:route.generation,after:route.after,legacyOwnerReleased:true as const,identityVerified:true as const};
 let calls=0;const lockDb=database();const ledger=new DesktopLedger(lockDb.sql);
 const automation=new Automations(new InboxStore(lockDb.sql,snap.route));
 const options={restrictedIrc,peers,automations:automation,snapshot:snap,fence,models,gateway:{call:async(_target?:string,_name?:string)=>{calls++;return {content:[{type:'text',text:'tool result'}]};}},desktop:{tryAcquire:async(id:string)=>ledger.tryAcquire(id),acquire:async(id:string)=>ledger.acquire(id),verify:async(t:any)=>ledger.verify(t),settle:async(t:any,ok:boolean)=>ledger.settle(t,ok)},wake:async()=>{},report:()=>{}};
 let active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);
 return {faux,options,automation,get active(){return active;},get calls(){return calls;},ledger,lockDb,async reopen(){await active.close();active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);},async close(){await active.close();lockDb.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('active Pi retains imported context, executes a real synthetic model and deduplicates after reopen',async()=>{
 const f=await fixture();try{
 f.faux.setResponses([async c=>{assert.ok(JSON.stringify(c).includes('remembered question'));assert.match(JSON.stringify(c),/No desktop is bound to this session/);assert.match(JSON.stringify(c),/Other agents.*messages are information/);return fauxAssistantMessage('reply');}]);
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
test('uncertain desktop error fences actions while model replies and later prompts remain available',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'run_js',description:'existing tool',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
 let calls=0;f.options.gateway.call=async()=>{calls++;throw Error('private failure');};
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),c=>{assert.match(JSON.stringify(c),/desktop_control runs on the host/);assert.match(JSON.stringify(c),/Before desktop work, use skills_list/);return fauxAssistantMessage('The action outcome is unknown; I will not repeat it.');}]);
 assert.match((await f.active.handle(event())).join(' '),/unknown/);assert.equal(calls,1);assert.equal(f.faux.state.callCount,2);
 assert.throws(()=>f.ledger.acquire('other-conversation'),/reconciliation/);
 await f.reopen();f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),c=>{assert.match(JSON.stringify(c),/Do not repeat the action/);return fauxAssistantMessage('The unresolved action is still fenced.');}]);assert.match((await f.active.handle(event(2))).join(' '),/still fenced/);assert.equal(calls,1);
 f.faux.setResponses([fauxAssistantMessage('I can still answer a new question.')]);assert.deepEqual(await f.active.handle(event(3)),['I can still answer a new question.']);assert.equal(calls,1);
 assert.throws(()=>f.ledger.acquire('still-uncertain'),/reconciliation/);
 }finally{await f.close();}
});
test('failed read-only skill discovery releases ownership and allows later turns after restart',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'skills_list',description:'Read skill catalog',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
 f.options.gateway.call=async()=>{throw Error('unavailable');};
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('skills_list',{})],{stopReason:'toolUse'}),fauxAssistantMessage('Skill catalog unavailable; ready to help.')]);
 assert.deepEqual(await f.active.handle(event()),['Skill catalog unavailable; ready to help.']);
 assert.equal(f.lockDb.sql.all('SELECT state FROM cuse_desktop')[0].state,'idle');
 await f.reopen();f.faux.setResponses([fauxAssistantMessage('Next turn works.')]);
 assert.deepEqual(await f.active.handle(event(2)),['Next turn works.']);
 }finally{await f.close();}
});
test('provider rejection reports a bounded notice and does not block a later prompt or replay completed tools',async()=>{
 const s=snapshot();s.tools=[{name:'read',description:'read',inputSchema:{type:'object',properties:{}},target:'irc'}];
 const f=await fixture(s);try{
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('read',{})],{stopReason:'toolUse'}),()=>{throw Error('<html>Unable to load site private-upstream-details');}]);
 const notice=await f.active.handle(event());assert.match(notice[0],/Model request failed \(upstream_rejected\)/);assert.ok(!notice[0].includes('private-upstream'));assert.equal(f.calls,1);
 await f.reopen();assert.deepEqual(await f.active.handle(event()),notice);assert.equal(f.calls,1);
 f.faux.setResponses([fauxAssistantMessage('Recovered.')]);assert.deepEqual(await f.active.handle(event(2)),['Recovered.']);assert.equal(f.calls,1);
 }finally{await f.close();}
});
test('active Codex calls receive the Worker transport adapter without enabling retries',async()=>{
 const f=await fixture(undefined,'openai-codex-responses');try{
 const fetcher:typeof fetch=async()=>new Response('synthetic');(f.options as any).modelFetch=fetcher;
 f.faux.setResponses([(_context,options)=>{assert.equal(options?.fetch,fetcher);assert.equal(options?.transport,'sse');assert.equal(options?.maxRetries,0);return fauxAssistantMessage('Encoded transport selected.');}]);
 assert.deepEqual(await f.active.handle(event()),['Encoded transport selected.']);
 }finally{await f.close();}
});
test('Codex response metadata survives reopen without retaining private headers or response bodies',async()=>{
 const f=await fixture(undefined,'openai-codex-responses');try{
 const start=Date.now();
 f.faux.setResponses([async(_input,options)=>{
  assert.equal(options?.maxRetries,0);
  await options?.onResponse?.({status:403,headers:{'CF-Ray':'a506e6d5cad40f07-SJC','Content-Type':'text/html; charset=utf-8','Set-Cookie':'MUST_NOT_PERSIST',authorization:'MUST_NOT_PERSIST'}},f.options.models.getModel(f.faux.provider.id,'chosen')!);
  throw Error('<html>Unable to load site PRIVATE_BODY');
 }]);
 assert.match((await f.active.handle(event())).join(' '),/upstream_rejected/);
 const stored=await f.active.harness.snapshot(ModelFailure,event().eventId,ctx);
 assert.equal(stored?.category,'upstream_rejected');assert.equal(stored?.http?.status,403);assert.equal(stored?.http?.rayId,'a506e6d5cad40f07-SJC');assert.equal(stored?.http?.contentType,'text/html');assert.ok(stored!.http!.at>=start);
 assert.ok(!JSON.stringify(stored).includes('MUST_NOT_PERSIST'));assert.ok(!JSON.stringify(stored).includes('PRIVATE_BODY'));
 await f.reopen();assert.deepEqual(await f.active.harness.snapshot(ModelFailure,event().eventId,ctx),stored);
 assert.equal(f.faux.state.callCount,1);
 assert.equal(responseMetadata({status:403,headers:{'cf-ray':'arbitrary-private-text','content-type':'text/html\nprivate'}})?.rayId,null);
 assert.equal(responseMetadata({status:403,headers:{'content-type':'text/html\nprivate'}})?.contentType,null);
 assert.equal(responseMetadata({status:0,headers:{}}),undefined);
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
  assert.match((await f.active.handle(event())).join(" "),/Turn limit reached/);assert.equal(f.faux.state.callCount,1);assert.equal(f.calls,1);
  await f.reopen();assert.match((await f.active.handle(event())).join(" "),/Turn limit reached/);assert.equal(f.faux.state.callCount,1);
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

test('legacy session commands preserve settings and history with replay-safe toggles and resets',async()=>{
 const f=await fixture();try{
  const cmd=(n:number,text:string)=>f.active.handle({...event(n),data:{...event(n).data,text}},undefined,'control');
  const help=await cmd(20,',help');assert.ok(help.some(s=>s.includes(',schedule')));assert.ok(help.every(s=>Buffer.byteLength(s)<=350));
  assert.match((await cmd(21,',models other')).join(' '),/other/);
  assert.match((await cmd(22,',thinking off')).join(' '),/off/);
  const toggle=await cmd(23,',toggle mention');await f.reopen();assert.deepEqual(await cmd(23,',toggle mention'),toggle);
  await cmd(24,',clear');const c=(await f.active.harness.conversation(f.active.conversationId,ctx))!;
  assert.equal((await c.context(ctx)).messages.length,0);assert.ok((await c.entries({},100,undefined,ctx)).items.length>=3);
  assert.match((await cmd(25,',reload')).join(' '),/reloaded/);
  const scheduled=await cmd(26,',schedule once 10s :: keep working');assert.ok(scheduled[0].includes('id'));assert.ok(f.automation.deadline());
  assert.equal(f.faux.state.callCount,0,'commands must not become model instructions');
 }finally{await f.close();}
});

test('legacy goal submit reaches human review without granting another provider call or quarantine',async()=>{
 const s=snapshot();s.compatibility={legacyGoals:true};s.policy.toolCalls=4;s.policy.modelRequests=4;s.tools=[{name:'goal_update',description:'legacy task evidence',inputSchema:{type:'object'},target:'host'},{name:'goal_status',description:'legacy task status',inputSchema:{type:'object'},target:'host'}];
 const f=await fixture(s);try{
 f.automation.legacyCommand('add :: synthetic objective','synthetic');f.automation.legacyCommand('start synthetic 2','start');const job=f.automation.inbox.claim(Date.now())!;
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('goal_update',{action:'task',id:'objective',state:'done',evidence:[{kind:'inspection',ref:'synthetic evidence',result:'pass'}]})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxToolCall('goal_update',{action:'submit'})],{stopReason:'toolUse'}),fauxAssistantMessage('must not run after submit')]);
 const replies=await f.active.handle(JSON.parse(job.payload),undefined,'goal');assert.match(replies[0],/review/);assert.equal(f.faux.state.callCount,2);assert.equal(f.automation.legacy!.get(f.automation.channel,'synthetic').phase,'review');
 f.automation.inbox.complete(job.id,replies,()=>f.automation.finish(job.id));await f.reopen();assert.equal(f.automation.legacy!.get(f.automation.channel,'synthetic').phase,'review');assert.equal(f.automation.legacy!.get(f.automation.channel,'synthetic').recoveryRequired,undefined);
 const approval=event(99);approval.data.text=',goal approve synthetic';await f.active.handle(approval);assert.equal(f.automation.legacy!.get(f.automation.channel,'synthetic').phase,'completed');
 }finally{await f.close();}
});

test('healthy desktop contention does not poison the losing session',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'run_js',description:'existing tool',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
  const owner=f.ledger.acquire('other-healthy-agent');
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('Desktop busy; no action performed.')]);
  assert.deepEqual(await f.active.handle(event()),['Desktop busy; no action performed.']);assert.equal(f.calls,0);
  f.ledger.settle(owner,true);await f.reopen();
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
  assert.deepEqual(await f.active.handle(event(2)),['done']);assert.equal(f.calls,1);
  assert.equal(f.lockDb.sql.all('SELECT state FROM cuse_desktop')[0].state,'idle');
 }finally{await f.close();}
});
test('lost acquire response remains uncertain and never replays the tool',async()=>{
 const s=snapshot();s.desktopBinding={kind:'existing',desktopId:'desk-one'};s.desktopId='desk-one';s.tools=[{name:'run_js',description:'existing tool',inputSchema:{type:'object',properties:{}},target:'desktop'}];
 const f=await fixture(s);try{
  let attempts=0;f.options.desktop.tryAcquire=async id=>{attempts++;f.ledger.tryAcquire(id);throw Error('lost response');};
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('Ownership is uncertain; no tool was dispatched.')]);
  assert.match((await f.active.handle(event())).join(' '),/uncertain/);assert.equal(f.calls,0);assert.equal(attempts,1);
  assert.equal(f.lockDb.sql.all('SELECT state FROM cuse_desktop')[0].state,'held');
  await f.reopen();f.faux.setResponses([fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'}),fauxAssistantMessage('Still fenced.')]);await f.active.handle(event(2));assert.equal(f.calls,0);assert.equal(attempts,1);assert.equal(f.faux.state.callCount,4);
 }finally{await f.close();}
});

test('native pre-intent hooks checkpoint long turns across slices without repeating or skipping tools',async()=>{
 const s=snapshot();s.policy.modelRequests=1;s.policy.toolCalls=1;s.tools=[{name:'read',description:'read',inputSchema:{type:'object',properties:{}},target:'irc'}];
 const f=await fixture(s);try{
  (f.options as any).slice={capacity:10,durationMs:60000};(f.options as any).turnLimits={models:64,tools:256};await f.reopen();
  f.faux.setResponses([...Array.from({length:12},()=>fauxAssistantMessage([fauxToolCall('read',{})],{stopReason:'toolUse'})),fauxAssistantMessage('All twelve steps completed.')]);
  let slices=0;for(;;){
   try{assert.deepEqual(await f.active.handle(event()),['All twelve steps completed.']);break;}
   catch(error){assert.equal((error as Error).constructor.name,'ExecutionYield');assert.ok(f.active.closed);assert.ok(++slices<20);await f.reopen();}
  }
  assert.ok(slices>1);assert.equal(f.calls,12);assert.equal(f.faux.state.callCount,13);
  await f.reopen();assert.deepEqual(await f.active.handle(event()),['All twelve steps completed.']);assert.equal(f.calls,12);assert.equal(f.faux.state.callCount,13);
 }finally{await f.close();}
});

test('failed IRC inspection does not fence later writes after reopen',async()=>{
 const s=snapshot();s.tools=['weechat_buffers','weechat_msg'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}},target:'irc' as const}));
 const f=await fixture(s);try{
 let writes=0;f.options.gateway.call=async(_target?:string,name?:string)=>{if(name==='weechat_buffers')throw Error('private transport detail');writes++;return {content:[{type:'text',text:'dispatched'}]};};
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('weechat_buffers',{})],{stopReason:'toolUse'}),c=>{assert.match(JSON.stringify(c),/Read unavailable/);assert.doesNotMatch(JSON.stringify(c),/private transport detail/);return fauxAssistantMessage('Read failed.');}]);
 await f.active.handle(event());await f.reopen();
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('weechat_msg',{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 assert.deepEqual(await f.active.handle(event(2)),['done']);assert.equal(writes,1);
 }finally{await f.close();}
});

test('IRC inspection remains available without releasing an uncertain write',async()=>{
 const s=snapshot();s.tools=['weechat_buffers','weechat_msg'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}},target:'irc' as const}));
 const f=await fixture(s);try{
 let reads=0,writes=0;f.options.gateway.call=async(_target?:string,name?:string)=>{if(name==='weechat_msg'){writes++;throw Error('unknown');}reads++;return {content:[{type:'text',text:'channel inspected'}]};};
 const turn=(name:string)=>[fauxAssistantMessage([fauxToolCall(name,{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')];
 f.faux.setResponses(turn('weechat_msg'));await f.active.handle(event());await f.reopen();
 f.faux.setResponses(turn('weechat_buffers'));await f.active.handle(event(2));assert.equal(reads,1);
 f.faux.setResponses(turn('weechat_msg'));await f.active.handle(event(3));assert.equal(writes,1);
 }finally{await f.close();}
});

test('legacy held IRC read recovers exact operation without a desktop lock and is idempotent',async()=>{
 const {defineDocFamily}=await import('@earendil-works/pi-durable');const {objectKey}=await import('../src/protocol.ts');
 const Halt=defineDocFamily<{halted:boolean;pending:string[]},null>({family:true,kind:'cuse.halt',version:1,scope:'session',initial:()=>({halted:false,pending:[]})});
 const s=snapshot();s.tools=[{name:'weechat_buffers',description:'read',inputSchema:{type:'object',properties:{}},target:'irc'}];
 const f=await fixture(s);try{
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('weechat_buffers',{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);await f.active.handle(event());
 const id=await f.active.harness.commit(async tx=>{const tasks=await tx.scanTasks({conversationId:f.active.conversationId,kind:'pi.tool'},10);const id=Number(tasks.items[0].id);const g=await tx.doc(Halt,objectKey(s.route),null);g.halted=true;g.pending=[objectKey(s.route)+':'+id];return id;},ctx);
 await assert.rejects(f.active.recoverRead(id+999),/terminal/);
 assert.match(await f.active.recoverRead(id),/recovered; no action replayed/);
 assert.match(await f.active.recoverRead(id),/already recorded/);
 }finally{await f.close();}
});

test('restricted runtime preserves original snapshot hash and history across reopen without adding tools',async()=>{
 const s=snapshot();s.tools=['weechat_buffers','weechat_cmd_irc_msg_751f5e60161a'].map(name=>({name,description:name,inputSchema:{type:'object'},target:'irc' as const}));
 // Host write wrappers are attenuated before peer-binding requirements.
 s.tools.push(...['irc_send','agent_ask'].map(name=>({name,description:name,inputSchema:{type:'object'},target:'host' as const})));
 const f=await fixture(s,undefined,true);try{
 const original=JSON.stringify(s),hash=await snapshotHash(s);
 assert.deepEqual(f.active.tools.map(t=>t.name),['weechat_buffers']);
 f.faux.setResponses([c=>{assert.ok(JSON.stringify(c).includes('remembered question'));return fauxAssistantMessage('retained');}]);
 assert.deepEqual(await f.active.handle(event()),['retained']);
 await f.reopen();
 assert.deepEqual(f.active.tools.map(t=>t.name),['weechat_buffers']);
 assert.equal(JSON.stringify(s),original);assert.equal(await snapshotHash(s),hash);assert.equal(f.options.fence.snapshotHash,hash);
 assert.equal(f.calls,0);
 }finally{await f.close();}
});

test('restricted peer denial is durable and terminal, preserves payload, and does not block following human work',async()=>{
 const f=await fixture(undefined,undefined,true);try{
 let receives=0,answers=0;
 (f.options as any).peers={receive:async()=>{receives++;return {kind:'question'};},answer:async()=>{answers++;}};
 const e=event();e.data.nick='PEER';e.data.text=f.options.snapshot.route.nick+': cuse-peer-v1 '+ 'a'.repeat(64)+' 0/1 e30=';
 const key=objectKey(f.options.snapshot.route)+':'+e.eventId;
 const inbox=new InboxStore(f.lockDb.sql,f.options.snapshot.route);
 inbox.accept(e,'peer-envelope');inbox.accept(event(2),'human');
 const runner=new Runner(inbox,{run:async(job,_checkpoint,signal)=>f.active.handle(JSON.parse(job.payload),signal)});
 await runner.step();
 assert.equal(inbox.job(e.eventId)?.state,'done');assert.equal(inbox.job(e.eventId)?.payload,JSON.stringify(e));
 const receipt=await f.active.harness.snapshot(RestrictedPeerDenial,key,ctx);
 assert.deepEqual(receipt,{outcome:'denied_without_dispatch'});
 assert.equal(receives,0);assert.equal(answers,0);assert.equal(f.faux.state.callCount,0);
 assert.equal(f.lockDb.sql.all('SELECT COUNT(*) AS n FROM cuse_effects')[0].n,0);
 await f.reopen();assert.deepEqual(await f.active.handle(e),[]);
 assert.deepEqual(await f.active.harness.snapshot(RestrictedPeerDenial,key,ctx),receipt);
 assert.equal(receives,0);assert.equal(answers,0);
 f.faux.setResponses([fauxAssistantMessage('ordinary message works')]);
 await runner.step();assert.equal(inbox.job(event(2).eventId)?.state,'done');assert.equal(f.faux.state.callCount,1);
 assert.equal(inbox.job(e.eventId)?.payload,JSON.stringify(e));
 assert.equal(f.lockDb.sql.all('SELECT COUNT(*) AS n FROM cuse_effects WHERE event=?',e.eventId)[0].n,0);
 }finally{await f.close();}
});

test('human marker quotations and non-addressed peer text are not restricted peer envelopes',async()=>{
 const f=await fixture(undefined,undefined,true);try{
 const e=event();e.data.text=f.options.snapshot.route.nick+': cuse-peer-v1 quoted in a human question';
 f.faux.setResponses([fauxAssistantMessage('human quote answered')]);
 assert.deepEqual(await f.active.handle(e),['human quote answered']);
 assert.equal(await f.active.harness.snapshot(RestrictedPeerDenial,objectKey(f.options.snapshot.route)+':'+e.eventId,ctx),undefined);
 const p=event(2);p.data.nick='peer';p.data.text=f.options.snapshot.route.nick+': discussing cuse-peer-v1 marker';
 f.faux.setResponses([fauxAssistantMessage('ordinary peer text')]);
 assert.deepEqual(await f.active.handle(p),['ordinary peer text']);
 assert.equal(await f.active.harness.snapshot(RestrictedPeerDenial,objectKey(f.options.snapshot.route)+':'+p.eventId,ctx),undefined);
 }finally{await f.close();}
});

test('restricted runtime preserves existing read-only peer listing without receiving or sending',async()=>{
 const s=snapshot();s.compatibility={peers:[]};s.tools=[{name:'agent_list',target:'host',description:'list peers',inputSchema:{type:'object'}}];
 let listed=0;
 const peers={list:async()=>{listed++;return [];},receive:async()=>{throw Error('must not receive');},send:async()=>{throw Error('must not send');},ask:async()=>{throw Error('must not ask');},answer:async()=>{throw Error('must not answer');}} as any;
 const f=await fixture(s,undefined,true,peers);try{
 assert.deepEqual(f.active.tools.map(t=>t.name),['agent_list']);
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('agent_list',{})],{stopReason:'toolUse'}),fauxAssistantMessage('listed')]);
 assert.deepEqual(await f.active.handle(event()),['listed']);assert.equal(listed,1);
 }finally{await f.close();}
});
