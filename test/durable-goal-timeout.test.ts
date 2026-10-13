import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableIrcStore} from "../src/durable-store.ts";
import {parseGoalCommand,formatGoal} from "../src/goal-types.ts";
import {PublicError,publicError} from "../src/public-error.ts";
const MIN=60_000,DEFAULT=30*MIN,MAX=3*24*60*MIN;
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),"cuse-goal-timeout-"));const store=new DurableIrcStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.goals.control("#a","human","g1",{action:"add",objective:"Verify timeout fixture",ordered:false});return {store,dir};}
function grant(store:DurableIrcStore,durationMs:number|undefined,steps=4){return store.goals.control("#a","human","start",{action:"start",id:"g1",steps,...(durationMs===undefined?{}:{durationMs})});}
function frozenClock(t:any){let now=1_900_000_000_000;t.mock.method(Date,"now",()=>now);return {get now(){return now;},advance(ms:number){now+=ms;}};}

test("duration parser supports optional whole m/h/d durations with independent step defaults",()=>{
 assert.deepEqual(parseGoalCommand("start g1"),{action:"start",id:"g1",steps:4});
 assert.deepEqual(parseGoalCommand("start g1 200"),{action:"start",id:"g1",steps:200});
 for(const [token,durationMs] of [["1m",MIN],["30m",DEFAULT],["90m",90*MIN],["2h",120*MIN],["72h",MAX],["3d",MAX],["4320m",MAX]] as const){
  assert.deepEqual(parseGoalCommand("start g1 200 "+token),{action:"start",id:"g1",steps:200,durationMs});
  assert.deepEqual(parseGoalCommand("start g1 "+token),{action:"start",id:"g1",steps:4,durationMs});
 }
});
test("duration parser rejects malformed, zero, fractional and over-72-hour requests",()=>{
 for(const suffix of ["0m","0h","0d","-1m","1.5h","0.5d","60s","3D","3 d","3days","Infinityh","NaNm","4d","73h","4321m","9007199254740993m","1e2h","3d extra","3d 200"]){
  assert.equal(parseGoalCommand("start g1 200 "+suffix),undefined,suffix);
 }
 for(const text of ["start g1 201 3d","start g1 0 3d","start g1 -1 3d","start g1 4.5 3d","start g1 3d 200","start g1 200 3d 1m"])assert.equal(parseGoalCommand(text),undefined,text);
});
test("timeout constants and public help match the 30m default, 1m minimum and 3d cap",async()=>{
 const constants=await import("../src/goal-types.ts");
 assert.equal(constants.MIN_GOAL_RUN_DURATION_MS,MIN);assert.equal(constants.DEFAULT_GOAL_RUN_DURATION_MS,DEFAULT);assert.equal(constants.MAX_GOAL_RUN_DURATION_MS,MAX);
 assert.match(constants.GOAL_USAGE,/duration/);assert.match(constants.GOAL_USAGE,/1m.*3d/);assert.match(constants.GOAL_USAGE,/default 30m/);
 assert.match(publicError(new PublicError("goalInvalid")),/1m.*3d/);assert.match(publicError(new PublicError("goalInvalid")),/default 30m/);
});
test("omitting duration preserves the existing default deadline and budgets",t=>{
 const clock=frozenClock(t),{store}=fixture(t);const g=grant(store,undefined,200) as any;
 assert.equal(g.expiresAt,clock.now+DEFAULT);assert.equal(g.stepsRemaining,199);assert.equal(g.modelsRemaining,1600);assert.equal(g.toolsRemaining,6400);
});
test("direct grants apply the requested exact bounded duration",async t=>{
 for(const durationMs of [MIN,DEFAULT,90*MIN,2*60*MIN,MAX])await t.test(String(durationMs),st=>{
  const clock=frozenClock(st),{store}=fixture(st);const g=grant(store,durationMs,200) as any;
  assert.equal(g.expiresAt,clock.now+durationMs);assert.equal(g.stepsRemaining,199);assert.equal(g.modelsRemaining,1600);assert.equal(g.toolsRemaining,6400);assert.equal(store.listInbox("pending").length,1);
 });
});
test("invalid direct duration leaves the inert ledger and queue unchanged",async t=>{
 for(const durationMs of [null,"3d","1800000",0,-MIN,1,MIN-1,MIN+1,1.5*MIN,MAX+MIN,NaN,Infinity,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])await t.test(String(durationMs),st=>{
  const {store}=fixture(st);const before=store.goals.get("#a","g1");
  assert.throws(()=>store.goals.control("#a","human","bad",{action:"start",id:"g1",steps:4,durationMs} as any));
  assert.deepEqual(store.goals.get("#a","g1"),before);assert.equal(store.listInbox().length,0);
 });
});
test("nonfinite or out-of-range grant clocks cannot persist an invalid deadline",async t=>{
 for(const now of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER,8_640_000_000_000_000])await t.test(String(now),st=>{
  const {store}=fixture(st);const before=store.goals.get("#a","g1");
  assert.throws(()=>store.goals.control("#a","human","bad",{action:"start",id:"g1",steps:4,durationMs:MAX},now));
  assert.deepEqual(store.goals.get("#a","g1"),before);assert.equal(store.listInbox().length,0);
 });
});
test("IRC status and queued continuation expose the absolute granted deadline",t=>{
 const clock=frozenClock(t),{store}=fixture(t);const g=grant(store,MAX) as any;
 assert.ok(formatGoal(g).includes(new Date(clock.now+MAX).toISOString()));
 const queued=store.listInbox("pending")[0]!;const payload=JSON.parse(queued.body.slice(queued.body.indexOf("\n")+1));assert.equal(payload.expiresAt,g.expiresAt);
});
test("a one-minute grant admits before its deadline but expires exactly at it without spending",t=>{
 const clock=frozenClock(t),{store}=fixture(t);grant(store,MIN);const m=store.claimNext("#a")!;
 clock.advance(MIN-1);assert.equal(store.goals.check("#a",m.id),true);clock.advance(1);
 assert.throws(()=>store.goals.spendModel("#a",m.id));assert.throws(()=>store.goals.spendTool("#a",m.id,"effect"));
 const g=store.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.reason,"Run deadline expired");assert.equal(g.modelsRemaining,32);assert.equal(g.toolsRemaining,128);
});
test("a three-day grant admits after 30m but permanently stops at its original 72h boundary",t=>{
 const clock=frozenClock(t),{store}=fixture(t);const origin=clock.now;grant(store,MAX,200);const m=store.claimNext("#a")!;
 clock.advance(DEFAULT+1);assert.equal(store.goals.spendModel("#a",m.id),true);store.goals.spendTool("#a",m.id,"first");
 clock.advance(MAX-(clock.now-origin));assert.throws(()=>store.goals.spendModel("#a",m.id));assert.throws(()=>store.goals.spendTool("#a",m.id,"late"));
 const g=store.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.expiresAt,origin+MAX);assert.equal(g.modelsRemaining,1599);assert.equal(g.toolsRemaining,6399);assert.equal(store.listInbox("pending").length,0);
});
test("checkpoints and continuations do not renew the original absolute deadline",t=>{
 const clock=frozenClock(t),{store}=fixture(t);const origin=clock.now;grant(store,MAX,4);const m=store.claimNext("#a")!;
 clock.advance(60*MIN);store.goals.update("#a",m.id,{action:"task",id:"objective",state:"working"});store.complete(m.id);
 const n=store.claimNext("#a")!;assert.notEqual(n.id,m.id);assert.equal(store.goals.get("#a","g1").expiresAt,origin+MAX);
 clock.advance(MAX-(clock.now-origin));assert.throws(()=>store.goals.update("#a",n.id,{action:"task",id:"objective",state:"working"}));store.complete(n.id);assert.equal(store.listInbox("pending").length,0);
});
test("72h runs retain eight-model and 32-distinct-tool per-step caps",t=>{
 frozenClock(t);const {store}=fixture(t);grant(store,MAX,200);const m=store.claimNext("#a")!;
 for(let i=0;i<8;i++)assert.equal(store.goals.spendModel("#a",m.id),true);
 assert.throws(()=>store.goals.spendModel("#a",m.id));assert.equal(store.goals.get("#a","g1").modelsRemaining,1592);store.complete(m.id);
 grant(store,MAX,200);const n=store.claimNext("#a")!;
 for(let i=0;i<32;i++){store.goals.spendTool("#a",n.id,"tool-"+i);store.goals.spendTool("#a",n.id,"tool-"+i);}
 assert.throws(()=>store.goals.spendTool("#a",n.id,"extra"));assert.equal(store.goals.get("#a","g1").toolsRemaining,6368);assert.equal(store.goals.get("#a","g1").phase,"blocked");
});
test("start cannot extend an active run; pause preserves expiry and only a new human grant replaces it",t=>{
 const clock=frozenClock(t),{store}=fixture(t);grant(store,60*MIN,200);const original=store.goals.get("#a","g1");
 assert.throws(()=>grant(store,MAX,200));assert.deepEqual(store.goals.get("#a","g1"),original);
 clock.advance(10*MIN);store.goals.control("#a","human","pause",{action:"pause",id:"g1"});assert.equal(store.goals.get("#a","g1").expiresAt,original.expiresAt);
 grant(store,MIN,4);const g=store.goals.get("#a","g1");assert.equal(g.expiresAt,clock.now+MIN);assert.equal(g.stepsRemaining,3);assert.equal(g.modelsRemaining,32);assert.equal(g.toolsRemaining,128);
});
test("reopening a long grant retains the exact deadline, blocks restart and never refunds allowance",t=>{
 const clock=frozenClock(t),{store,dir}=fixture(t);const origin=clock.now;grant(store,MAX,200);const m=store.claimNext("#a")!;store.goals.spendModel("#a",m.id);store.goals.spendTool("#a",m.id,"effect");store.close();clock.advance(60*MIN);
 const reopened=new DurableIrcStore(dir);try{
  const g=reopened.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.recoveryRequired,true);assert.equal(g.expiresAt,origin+MAX);assert.equal(g.stepsRemaining,199);assert.equal(g.modelsRemaining,1599);assert.equal(g.toolsRemaining,6399);assert.equal(reopened.listInbox("pending").length,0);assert.equal(reopened.listInbox("recovery-required")[0]!.id,m.id);
  assert.throws(()=>grant(reopened,MAX,200));
 }finally{reopened.close();}
});

test("a 72h grant still clamps each faux provider request to five minutes or a shorter caller timeout",async t=>{
 frozenClock(t);const {store}=fixture(t);grant(store,MAX);const m=store.claimNext("#a")!;
 const {goalModels}=await import("../.runtime/pi/packages/coding-agent/src/cuse/goal-tools.ts");
 const seen:any[]=[];const provider={complete(_model:any,_context:any,options:any){seen.push(options);return Promise.resolve({stopReason:"stop"});}};
 const delegate={goalGuard:(channel:string,operation:string)=>store.goals.spendModel(channel,operation)};
 const guarded=goalModels(provider as any,delegate as any,"#a",()=>m.id,MAX) as any;
 await guarded.complete({}, {}, {timeoutMs:MAX,maxTokens:Infinity,maxRetries:9});
 await guarded.complete({}, {}, {timeoutMs:30_000});
 assert.equal(seen[0].timeoutMs,300_000);assert.equal(seen[1].timeoutMs,30_000);
 for(const options of seen){assert.equal(options.maxRetries,0);assert.equal(options.maxTokens,4096);assert.equal(options.transport,"sse");assert.equal(options.deferred,false);assert.ok(options.signal instanceof AbortSignal);}
 assert.equal(store.goals.get("#a","g1").modelsRemaining,30);
});
test("replaying a human start receipt neither extends expiry nor starts a paused goal",t=>{
 const clock=frozenClock(t),{store}=fixture(t);const request=parseGoalCommand("start g1 200 3d")!;const fingerprint=JSON.stringify({request,sender:"human"});let calls=0;
 const apply=()=>{calls++;return store.goals.control("#a","human","command",request);};
 const first=store.receiptOperation("goal/control/#a/same",fingerprint,apply);assert.equal(first.replayed,false);
 clock.advance(60*MIN);store.goals.control("#a","human","pause",{action:"pause",id:"g1"});const paused=store.goals.get("#a","g1");
 const replay=store.receiptOperation("goal/control/#a/same",fingerprint,apply);assert.equal(replay.replayed,true);assert.equal(calls,1);assert.deepEqual(store.goals.get("#a","g1"),paused);assert.equal(store.listInbox("pending").length,0);
 assert.throws(()=>store.receiptOperation("goal/control/#a/same",JSON.stringify({request:parseGoalCommand("start g1 200 1m"),sender:"human"}),apply));assert.equal(calls,1);assert.deepEqual(store.goals.get("#a","g1"),paused);
});
