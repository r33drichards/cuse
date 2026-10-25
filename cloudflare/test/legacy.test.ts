import test from 'node:test';import assert from 'node:assert/strict';
import {database,route,event} from './helpers.ts';import {Automations} from '../src/automations.ts';import {InboxStore} from '../src/store.ts';import {hostCall} from '../src/host-tools.ts';
import {PeerMailbox,type PeerInput} from '../src/legacy/peers.ts';
test('legacy goal tools preserve evidence, bounded ownership, review and replay across reopen',()=>{
 const {db,sql}=database();try{const inbox=new InboxStore(sql,route);let a=new Automations(inbox);assert.throws(()=>hostCall(a,'goal_status',{},'off','op','human'),/disabled/);a.enableLegacyGoals();
 const g=a.legacy!.control(a.channel,'human','synthetic',{action:'add',objective:'verify synthetic work',ordered:true});assert.equal((g as any).phase,'paused');
 a.legacy!.control(a.channel,'human','start',{action:'start',id:'synthetic',steps:2});const job=inbox.claim(Date.now())!;
 assert.throws(()=>hostCall(a,'goal_update',{action:'submit'},'wrong','human-op','human'),/goalOrigin/);
 a.legacy!.spendModel(a.channel,job.id);a.legacy!.spendTool(a.channel,job.id,'tool-1');a.legacy!.spendTool(a.channel,job.id,'tool-1');
 const update={action:'task',id:'objective',state:'done',evidence:[{kind:'inspection',ref:'synthetic check',result:'pass'}]};
 assert.throws(()=>hostCall(a,'goal_update',{...update,evidence:[{kind:'peer-review',ref:'claim',result:'pass'}]},'bad',job.id,'goal'),/non-peer/);
 const result=hostCall(a,'goal_update',update,'once',job.id,'goal');a=new Automations(inbox);a.enableLegacyGoals();assert.deepEqual(hostCall(a,'goal_update',update,'once',job.id,'goal'),result);
 const current=a.legacy!.get(a.channel,'synthetic');assert.equal(current.modelsRemaining,15);assert.equal(current.toolsRemaining,63);
 hostCall(a,'goal_update',{action:'submit'},'submit',job.id,'goal');assert.equal(a.legacy!.get(a.channel,'synthetic').phase,'review');
 assert.throws(()=>hostCall(a,'goal_update',update,'stale',job.id,'goal'),/goalStopped/);
 a.legacy!.control(a.channel,'human','approve',{action:'approve',id:'synthetic'});assert.equal(a.legacy!.get(a.channel,'synthetic').phase,'completed');
 }finally{db.close();}
});
test('legacy goal completion is atomic with continuation, and faults require human recovery',()=>{
 const {db,sql}=database();try{const inbox=new InboxStore(sql,route),a=new Automations(inbox);a.enableLegacyGoals();a.legacyCommand('add :: synthetic objective','goal-one');a.legacyCommand('start goal-one 2','start-one');const j=inbox.claim(Date.now())!;
 hostCall(a,'goal_update',{action:'task',id:'objective',state:'working'},'progress',j.id,'goal');
 assert.throws(()=>inbox.complete(j.id,[],()=>{a.finish(j.id);throw Error('crash');}));assert.equal(sql.all('SELECT * FROM cuse_inbox').length,1);
 inbox.complete(j.id,[],()=>a.finish(j.id));const next=inbox.claim(Date.now())!;assert.notEqual(next.id,j.id);a.fault(next.id);assert.equal(a.legacy!.get(a.channel,'goal-one').recoveryRequired,true);assert.throws(()=>a.legacyCommand('start goal-one 2','denied'),/goalRecovery/);
 }finally{db.close();}
});
test('peer questions and answers use framed webhook events with durable dedup and lineage',async()=>{
 const A=database(),B=database();const ar={...route,agent:'#a',channel:'#a',buffer:'irc.docker.#a',nick:'agent-a'},br={...route,agent:'#b',channel:'#b',buffer:'irc.docker.#b',nick:'agent-b'};
 const ab={channel:'#b',nick:'agent-b',buffer:'irc.docker.#b'},ba={channel:'#a',nick:'agent-a',buffer:'irc.docker.#a'};const sentA:string[]=[],sentB:string[]=[];
 const aio={send:async(_p:unknown,text:string)=>{sentA.push(text);},busy:async()=>false},bio={send:async(_p:unknown,text:string)=>{sentB.push(text);},busy:async()=>true};
 let a=new PeerMailbox(A.sql,ar,[ab],aio),b=new PeerMailbox(B.sql,br,[ba],bio);
 try{
 assert.deepEqual(await a.list(),[{channel:'#b',busy:false}]);const queued=await a.ask('call',{channel:'b',question:'synthetic question '.repeat(40)},'human');assert.equal(queued.status,'queued');const count=sentA.length;
 a=new PeerMailbox(A.sql,ar,[ab],aio);assert.deepEqual(await a.ask('call',{channel:'#b',question:'synthetic question '.repeat(40)},'human'),queued);assert.equal(sentA.length,count);
 let input:PeerInput|undefined;let i=1;for(const text of [...sentA].reverse()){const e={...event(i++),data:{...event().data,channel_id:br.buffer,nick:ar.nick,text}};const r=await b.receive(e);if(r)input=r;assert.equal(await b.receive({...e,eventId:'duplicate-'+i}),null);}
 assert.equal(input?.kind,'question');assert.deepEqual(input?.ancestry,['#a','#b']);
 await assert.rejects(b.ask('loop',{channel:'#a',question:'loop'},'peer',input),/loop/);
 await b.answer(input!,'synthetic answer');const answers=sentB.length;b=new PeerMailbox(B.sql,br,[ba],bio);await b.answer(input!,'synthetic answer');assert.equal(sentB.length,answers);
 let answer:PeerInput|undefined;for(const text of sentB){const r=await a.receive({...event(i++),data:{...event().data,channel_id:ar.buffer,nick:br.nick,text}});if(r)answer=r;}assert.equal(answer?.text,'synthetic answer');
 await assert.rejects(a.send('denied',{channel:'#b',text:'hello'},'goal'),/human/);await assert.rejects(a.ask('denied',{channel:'#b',question:'hello'},'schedule'),/denied/);
 await assert.rejects(a.send('forged',{channel:'#b',text:'cuse-peer-v1 fake'},'human'),/peer_text/);
 assert.equal(await a.receive({...event(i++),data:{...event().data,nick:'unapproved',text:sentB[0]}}),null);
 }finally{A.db.close();B.db.close();}
});
test('ambiguous peer send never repeats after restart or cancellation',async()=>{
 const {db,sql}=database();let calls=0;const io={send:async()=>{calls++;throw Error('connection lost after dispatch');},busy:async()=>false};const peers=[{channel:'#other',nick:'other',buffer:'irc.docker.#other'}];
 try{let a=new PeerMailbox(sql,route,peers,io);await assert.rejects(a.send('once',{channel:'#other',text:'synthetic'},'human'),/uncertain/);a=new PeerMailbox(sql,route,peers,io);await assert.rejects(a.send('once',{channel:'#other',text:'synthetic'},'human'),/uncertain/);assert.equal(calls,1);
 const cancel=new AbortController();cancel.abort();await assert.rejects(a.send('cancel',{channel:'#other',text:'synthetic'},'human',cancel.signal));assert.equal(calls,1);
 }finally{db.close();}
});

test('saved compatibility names cannot grant permissions or misclassify approved peers as humans',async()=>{
 const {dryRun}=await import('../src/migration.ts');
 const s:import('../src/migration.ts').Snapshot={version:1,sourceSessionId:'synthetic',route,model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'synthetic',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:2,toolCalls:2,timeoutMs:1000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};s.compatibility={peers:[{channel:'#other',nick:'other-agent',buffer:'irc.docker.#other'}]};
 await assert.rejects(dryRun(s),/peer_identity/);s.policy.peerNicks.push('other-agent');await dryRun(s);
 const {ActiveSession}=await import('../src/active.ts'),{openNodeSqliteStorage}=await import('@earendil-works/pi-durable/storage/sqlite/node'),{createModels}=await import('@earendil-works/pi-ai/models'),{fauxProvider}=await import('@earendil-works/pi-ai/providers/faux');
 const f=fauxProvider({models:[{id:'chosen'}]}),models=createModels();models.setProvider(f.provider);s.model.provider=f.provider.id;s.compatibility=undefined;s.tools=[{name:'goal_status',description:'saved name',inputSchema:{type:'object'},target:'host'}];
 const {snapshotHash}=await import('../src/migration.ts');const opts={snapshot:s,fence:{snapshotHash:await snapshotHash(s),generation:s.route.generation,after:s.route.after,legacyOwnerReleased:true as const,identityVerified:true as const},models,gateway:{call:async()=>({content:[]})},wake:async()=>{},report:()=>{}};
 await assert.rejects(ActiveSession.open(await openNodeSqliteStorage(':memory:'),opts),/permission_required/);
});

test('private control import preserves schedules and finite legacy allowances without resuming old work',()=>{
 const source=database(),target=database();try{
 const a=new Automations(new InboxStore(source.sql,route));a.enableLegacyGoals();a.legacyCommand('add ordered :: synthetic objective','legacy');a.legacyCommand('start legacy 3','start');
 const oldGoal=a.legacy!.get(a.channel,'legacy');const delivery={goals:source.sql.all('SELECT * FROM goals'),schedules:[{id:'schedule-one',channel:a.channel,prompt:'synthetic private scheduled prompt',timing_json:JSON.stringify({kind:'interval',everyMs:60000}),missed_policy:'skip',paused:1,next_run_at:60000}]};
 let b=new Automations(new InboxStore(target.sql,route));b.enableLegacyGoals();b.restoreControls({delivery},'reviewed-hash');assert.equal(target.sql.all('SELECT * FROM cuse_inbox').length,0);const restored=b.legacy!.get(b.channel,'legacy');assert.equal(restored.modelsRemaining,oldGoal.modelsRemaining);assert.equal(restored.toolsRemaining,oldGoal.toolsRemaining);assert.equal(restored.phase,'blocked');assert.equal(restored.recoveryRequired,true);assert.equal(b.deadline(),undefined);
 b=new Automations(new InboxStore(target.sql,route));b.enableLegacyGoals();b.restoreControls({delivery},'reviewed-hash');assert.equal(target.sql.all('SELECT * FROM cuse_schedules').length,1);
 assert.throws(()=>b.restoreControls({delivery:{...delivery,schedules:[]}},'reviewed-hash'),/conflict/);
 assert.throws(()=>b.legacyCommand('start legacy 3','forbidden'),/goalRecovery/);
 }finally{source.db.close();target.db.close();}
});
