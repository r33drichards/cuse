import test from 'node:test';
import assert from 'node:assert/strict';
import {Renewal,type RecoveryPolicy} from '../src/renewal.ts';
import {subscribe,type Grant,type Coverage,type SubscriptionSpec} from '../src/subscriptions.ts';
import {InboxStore} from '../src/store.ts';
import {database,route,secret,event} from './helpers.ts';
const policy:RecoveryPolicy={mode:'auto',minDelayMs:30000,maxDelayMs:900000};
const coverage:Coverage={version:1,incarnation:'a'.repeat(32),generation:0,status:'continuous'};
const spec:SubscriptionSpec={arguments:{channel_id:route.buffer,trigger:'message'},callback:'https://example.invalid/events/test',secret,ttlMs:3600000};
const grant=(changes:Partial<Grant>={}):Grant=>({id:'sub',refreshBefore:new Date(100000).toISOString(),cursor:'opaque-ack',truncated:false,coverage,...changes});
const later=(changes:Partial<Grant>={}):Grant=>grant({refreshBefore:new Date(10000000).toISOString(),...changes});
const fixture=(p:RecoveryPolicy=policy)=>{const {db,sql}=database();const r=new Renewal(sql,p);r.arm(grant(),0);return {db,sql,r};};

test('automatic expiry recovery replays exact saved ACK and pins incarnation; normal renewal omits cursor',async()=>{
 const f=fixture();try{
  let params:Record<string,unknown>={};const rpc=async(_method:string,p:Record<string,unknown>)=>{params=p;return later();};
  await f.r.alarm(rpc,spec,100001);
  assert.equal(params.cursor,'opaque-ack');assert.deepEqual(params.recovery,{mode:'prove',expectedIncarnation:coverage.incarnation});assert.equal(f.r.valid(100001),true);
  await f.r.alarm(rpc,spec,f.r.deadline()!);assert.equal(params.cursor,undefined);
 }finally{f.db.close();}
});
test('attempt and capped cooldown persist before I/O across restart without a hot loop',async()=>{
 const f=fixture();try{
  let calls=0;const rpc=async()=>{calls++;assert.ok(Number(f.sql.all('SELECT due FROM cuse_grant')[0].due)>now);throw Error('mcp_operation_failed');};
  let now=75000;await f.r.alarm(rpc,spec,now);assert.equal(f.r.valid(now),false);assert.equal(f.r.deadline(),105000);
  let r=new Renewal(f.sql,policy);await r.alarm(rpc,spec,now+1);assert.equal(calls,1);
  for(let n=0;n<10;n++){now=r.deadline()!;await r.alarm(rpc,spec,now);assert.ok(r.deadline()!-now<=900000);r=new Renewal(f.sql,policy);}
  assert.equal(r.deadline()!-now,900000);assert.equal(calls,11);
  await r.alarm(async()=>later(),spec,r.deadline()!);assert.equal(r.valid(now),true);
 }finally{f.db.close();}
});
test('crash/in-flight refresh cannot bypass cooldown and stale completion cannot overwrite explicit arm',async()=>{
 const f=fixture();try{
  let resolve!:(value:Grant)=>void;const pending=f.r.alarm(()=>new Promise<Grant>(r=>{resolve=r;}),spec,75000);
  assert.equal(f.r.deadline(),105000);let calls=0;
  await new Renewal(f.sql,policy).alarm(async()=>{calls++;return later();},spec,75001);assert.equal(calls,0);
  const reviewed=later({cursor:'reviewed'});f.r.arm(reviewed,76000);resolve(later({cursor:'stale'}));await pending;
  assert.equal(JSON.parse(String(f.sql.all('SELECT grant_json FROM cuse_grant')[0].grant_json)).cursor,'reviewed');
 }finally{f.db.close();}
});
test('same-id recreation, missing proof, identity changes and permanent gaps hold without automatic reset',async()=>{
 for(const next of [later({id:'different'}),later({coverage:{...coverage,incarnation:'b'.repeat(32)}}),later({coverage:undefined}),later({truncated:true,coverage:{...coverage,generation:1,status:'gap',reason:'native_epoch_changed'}})]){
  const f=fixture();try{await f.r.alarm(async()=>next,spec,100001);assert.equal(f.r.valid(100001),false);assert.equal(f.r.deadline(),undefined);assert.equal(new Renewal(f.sql,policy).deadline(),undefined);}finally{f.db.close();}
 }
});
test('legacy expiry only enrolls incarnation with retained-subscription continuity proof',async()=>{
 for(const proven of [false,true]){
  const f=fixture();try{
   f.r.arm(grant({coverage:undefined}),0);
   await f.r.alarm(async()=>later({coverage:{...coverage,...(proven?{continuity:'retained-subscription' as const}:{})}}),spec,100001);
   assert.equal(f.r.valid(100001),proven);
  }finally{f.db.close();}
 }
});
test('bounded native-window proof polling requires matching generation proof to rearm',async()=>{
 for(const proven of [false,true]){
  const f=fixture();try{
   const gap:Coverage={...coverage,generation:1,status:'recovering',reason:'native_window_gap'};
   await f.r.alarm(async()=>later({coverage:gap,truncated:true}),spec,75000);
   assert.equal(f.r.valid(75000),false);assert.equal(f.r.deadline(),105000);
   await new Renewal(f.sql,policy).alarm(async()=>later({coverage:{...coverage,generation:1,...(proven?{proof:'retained_native_anchor' as const,recoveredGeneration:1}:{})}}),spec,105000);
   assert.equal(f.r.valid(105000),proven);assert.equal(f.r.gapWarnings().length,0);
  }finally{f.db.close();}
 }
});
test('explicit resume alone accepts acknowledged loss and audits each gap generation exactly once',async()=>{
 for(const resume of [false,true]){
  const f=fixture({...policy,gapPolicy:resume?'resume':'hold'});try{
   const degraded=(generation:number)=>later({truncated:true,coverage:{...coverage,generation,status:'degraded',reason:'native_epoch_changed',proof:'acknowledged_loss',acknowledgedGeneration:generation}});
   await f.r.alarm(async()=>degraded(1),spec,100001);assert.equal(f.r.valid(100001),resume);
   assert.equal(f.r.gapWarnings().length,resume?1:0);
   if(resume){f.r.arm(degraded(1),100002);assert.equal(f.r.gapWarnings().length,1);f.r.arm(degraded(2),100003);assert.equal(f.r.gapWarnings().length,2);assert.equal(JSON.parse(String(f.sql.all('SELECT grant_json FROM cuse_grant')[0].grant_json)).truncated,true);}
  }finally{f.db.close();}
 }
});
test('degraded acknowledgment must match generation; malformed metadata and past grants stay gated',async()=>{
 for(const next of [later({truncated:true,coverage:{...coverage,generation:2,status:'degraded',proof:'acknowledged_loss',acknowledgedGeneration:1}}),later({coverage:{...coverage,incarnation:'invalid'}}),grant()]){
  const f=fixture({...policy,gapPolicy:'resume'});try{await f.r.alarm(async()=>next,spec,100001);assert.equal(f.r.valid(100001),false);assert.equal(f.r.gapWarnings().length,0);}finally{f.db.close();}
 }
});
test('legacy stopped grants migrate only under opted-in policy, without changing unrelated durable state',async()=>{
 const {db,sql}=database();try{
  sql.all("CREATE TABLE cuse_grant (id INTEGER PRIMARY KEY,grant_json TEXT,due INTEGER,attempts INTEGER,state TEXT)");
  sql.all("INSERT INTO cuse_grant VALUES (1,?,100000,3,'coverage-gap')",JSON.stringify(grant({coverage:undefined})));
  sql.all('CREATE TABLE preserved (value TEXT)');sql.all("INSERT INTO preserved VALUES ('pending job / uncertain action')");
  assert.equal(new Renewal(sql,policy).deadline(),undefined);
  const r=new Renewal(sql,{...policy,gapPolicy:'resume'});assert.equal(r.deadline(),100000);
  await r.alarm(async()=>later({truncated:true,coverage:{...coverage,generation:1,status:'degraded',reason:'legacy_unknown',proof:'acknowledged_loss',acknowledgedGeneration:1}}),spec,100001);
  assert.equal(r.valid(100001),true);assert.equal(sql.all('SELECT * FROM preserved')[0].value,'pending job / uncertain action');
 }finally{db.close();}
});
test('configuration and response validation fail clearly without retry storms',async()=>{
 const {db,sql}=database();try{
  for(const p of [{...policy,minDelayMs:0},{...policy,maxDelayMs:Infinity},{...policy,minDelayMs:900001}])assert.throws(()=>new Renewal(sql,p),/configuration/);
  const r=new Renewal(sql,policy);r.arm(grant(),0);await r.alarm(async()=>later(),{...spec,ttlMs:NaN},75000);assert.equal(r.deadline(),undefined);assert.equal(new Renewal(sql,policy).deadline(),undefined);
  await assert.rejects(()=>subscribe(async()=>later({coverage:{...coverage,generation:-1}}),spec),/response_invalid/);
 }finally{db.close();}
});

test('subscription replay preserves inbox dedup, completed effects, and uncertain-action fences',async()=>{
 const f=fixture({...policy,gapPolicy:'resume'});try{
  const inbox=new InboxStore(f.sql,route);const first=event(1),second=event(2);
  assert.equal(inbox.accept(first,'digest-one'),'accepted');assert.equal(inbox.accept(second,'digest-two'),'accepted');
  const job=inbox.claim(0)!;inbox.complete(job.id,['already sent']);
  f.sql.all("UPDATE cuse_effects SET state='uncertain'");
  const jobs=JSON.stringify(f.sql.all('SELECT * FROM cuse_inbox ORDER BY position'));
  const effects=JSON.stringify(f.sql.all('SELECT * FROM cuse_effects ORDER BY id'));
  await f.r.alarm(async()=>later({truncated:true,coverage:{...coverage,generation:1,status:'degraded',reason:'legacy_unknown',proof:'acknowledged_loss',acknowledgedGeneration:1}}),spec,100001);
  assert.equal(f.r.valid(100001),true);
  assert.equal(inbox.accept(first,'digest-one'),'duplicate');assert.equal(inbox.accept(second,'digest-two'),'duplicate');
  assert.equal(JSON.stringify(f.sql.all('SELECT * FROM cuse_inbox ORDER BY position')),jobs);
  assert.equal(JSON.stringify(f.sql.all('SELECT * FROM cuse_effects ORDER BY id')),effects);
  assert.throws(()=>inbox.accept(first,'different-payload'),/event_id_conflict/);
 }finally{f.db.close();}
});

test('explicit hold-to-resume transition retries only coverage gaps after reserved cooldown',async()=>{
 const f=fixture();try{
  await f.r.alarm(async()=>later({truncated:true,coverage:{...coverage,generation:1,status:'gap',reason:'native_epoch_changed'}}),spec,75000);
  assert.equal(f.sql.all('SELECT state FROM cuse_grant')[0].state,'coverage-gap');
  const resume=new Renewal(f.sql,{...policy,gapPolicy:'resume'});assert.equal(resume.deadline(),105000);
  let calls=0;const rpc=async()=>{calls++;return later({truncated:true,coverage:{...coverage,generation:1,status:'degraded',reason:'native_epoch_changed',proof:'acknowledged_loss',acknowledgedGeneration:1}});};
  await resume.alarm(rpc,spec,75001);assert.equal(calls,0);
  await resume.alarm(rpc,spec,105000);assert.equal(calls,1);assert.equal(resume.valid(105000),true);assert.equal(resume.gapWarnings().length,1);
  const reopened=new Renewal(f.sql,{...policy,gapPolicy:'resume'});await reopened.alarm(rpc,spec,105001);assert.equal(calls,1);assert.equal(reopened.gapWarnings().length,1);
 }finally{f.db.close();}
});
test('explicit resume policy cannot clear an incarnation mismatch hold',async()=>{
 const f=fixture();try{
  await f.r.alarm(async()=>later({coverage:{...coverage,incarnation:'b'.repeat(32)}}),spec,75000);
  assert.equal(f.sql.all('SELECT state FROM cuse_grant')[0].state,'held');
  const resume=new Renewal(f.sql,{...policy,gapPolicy:'resume'});let calls=0;
  await resume.alarm(async()=>{calls++;return later();},spec,10000000);
  assert.equal(calls,0);assert.equal(resume.deadline(),undefined);assert.equal(resume.valid(10000000),false);
 }finally{f.db.close();}
});

test('policy transition retains observed gap generation and rejects rollback',async()=>{
 const f=fixture();try{
  await f.r.alarm(async()=>later({truncated:true,coverage:{...coverage,generation:2,status:'gap',reason:'native_epoch_changed'}}),spec,75000);
  const resume=new Renewal(f.sql,{...policy,gapPolicy:'resume'});
  await resume.alarm(async()=>later({truncated:true,coverage:{...coverage,generation:1,status:'degraded',reason:'native_epoch_changed',proof:'acknowledged_loss',acknowledgedGeneration:1}}),spec,105000);
  assert.equal(resume.valid(105000),false);assert.equal(resume.gapWarnings().length,0);assert.equal(resume.deadline(),undefined);
 }finally{f.db.close();}
});

test('first automatic enrollment of a still-active legacy grant must prove retained row, not just same ID',async()=>{
 for(const retained of [false,true]){
  const f=fixture();try{
   f.r.arm(grant({coverage:undefined}),0);let sent:Record<string,unknown>={};
   await f.r.alarm(async(_method,params)=>{sent=params;return later({coverage:{...coverage,...(retained?{continuity:'retained-subscription' as const}:{})}});},spec,75000);
   assert.equal(sent.cursor,'opaque-ack');assert.deepEqual(sent.recovery,{mode:'prove'});
   assert.equal(f.r.valid(75000),retained);
  }finally{f.db.close();}
 }
});
test('legacy enrollment without an ACK cannot silently trust a same-ID grant',async()=>{
 const f=fixture();try{
  f.r.arm(grant({coverage:undefined,cursor:null}),0);let calls=0;
  await f.r.alarm(async()=>{calls++;return later();},spec,75000);
  assert.equal(calls,0);assert.equal(f.r.valid(75000),false);assert.equal(f.r.deadline(),undefined);
 }finally{f.db.close();}
});

test('later repaired gap retains historic loss audit without inventing a new lost generation',async()=>{
 const f=fixture({...policy,gapPolicy:'resume'});try{
  const lost=later({truncated:true,coverage:{...coverage,generation:1,status:'degraded',reason:'native_epoch_changed',proof:'acknowledged_loss',acknowledgedGeneration:1,lossGeneration:1}});
  await f.r.alarm(async()=>lost,spec,75000);assert.equal(f.r.gapWarnings().length,1);
  const repaired=later({truncated:true,coverage:{...coverage,generation:2,status:'degraded',reason:'native_window_gap',proof:'retained_native_anchor',recoveredGeneration:2,lossGeneration:1}});
  await f.r.alarm(async()=>repaired,spec,f.r.deadline()!);
  assert.equal(f.r.valid(100000),true);assert.equal(f.r.gapWarnings().length,1);assert.equal(f.r.gapWarnings()[0].generation,1);assert.equal(f.r.gapWarnings()[0].reason,'native_epoch_changed');
  const stored=JSON.parse(String(f.sql.all('SELECT grant_json FROM cuse_grant')[0].grant_json));assert.equal(stored.truncated,true);assert.equal(stored.coverage.generation,2);
 }finally{f.db.close();}
});

test('first-observed historic loss uses unspecified provenance, not the later repaired gap reason',async()=>{
 const f=fixture({...policy,gapPolicy:'resume'});try{
  const repaired=later({truncated:true,coverage:{...coverage,generation:2,status:'degraded',reason:'native_window_gap',proof:'retained_native_anchor',recoveredGeneration:2,lossGeneration:1}});
  await f.r.alarm(async()=>repaired,spec,75000);
  assert.equal(f.r.valid(75000),true);assert.equal(f.r.gapWarnings().length,1);
  assert.equal(f.r.gapWarnings()[0].generation,1);assert.equal(f.r.gapWarnings()[0].reason,'unspecified');
 }finally{f.db.close();}
});

test('legacy enrollment may poll a recoverable gap only with exact ACK retained-row continuity',async()=>{
 for(const retained of [false,true]){
  const f=fixture();try{
   f.r.arm(grant({coverage:undefined}),0);
   await f.r.alarm(async(_method,params)=>{
    assert.equal(params.cursor,'opaque-ack');assert.deepEqual(params.recovery,{mode:'prove'});
    return later({truncated:true,coverage:{...coverage,generation:1,status:'recovering',reason:'native_window_gap',...(retained?{continuity:'retained-subscription' as const}:{})}});
   },spec,75000);
   assert.equal(f.r.valid(75000),false);assert.equal(f.r.deadline(),retained?105000:undefined);
   let calls=0;const reopened=new Renewal(f.sql,policy);
   await reopened.alarm(async(_method,params)=>{
    calls++;assert.equal(params.cursor,'opaque-ack');assert.deepEqual(params.recovery,{mode:'prove',expectedIncarnation:coverage.incarnation});
    return later({coverage:{...coverage,generation:1,status:'continuous',proof:'retained_native_anchor',recoveredGeneration:1}});
   },spec,105000);
   assert.equal(calls,retained?1:0);assert.equal(reopened.valid(105000),retained);assert.equal(reopened.gapWarnings().length,0);
  }finally{f.db.close();}
 }
});

test('additive recovery metadata keeps the previous five-column positional arm rollback-compatible',()=>{
 const {db,sql}=database();try{
  const r=new Renewal(sql,policy);r.arm(grant(),0);
  // Exact pre-feature statement: rollback must not fail with a column mismatch.
  const reviewed=later({cursor:'legacy-rollback'});
  sql.all("INSERT INTO cuse_grant VALUES (1,?,?,0,'active') ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,due=excluded.due,attempts=0,state='active'",JSON.stringify(reviewed),7500000);
  assert.equal(sql.all('PRAGMA table_info(cuse_grant)').length,5);
  assert.equal(JSON.parse(String(sql.all('SELECT grant_json FROM cuse_grant')[0].grant_json)).cursor,'legacy-rollback');
  assert.equal(r.valid(100000),true);
 }finally{db.close();}
});
