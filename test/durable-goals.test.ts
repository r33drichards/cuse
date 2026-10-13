import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableIrcStore} from "../src/durable-store.ts";
import {parseGoalCommand,validateTasks} from "../src/goal-types.ts";
const evidence=[{kind:"native-test" as const,ref:"artifact:test-results.json (fixture report)",result:"pass" as const}];
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),"cuse-goals-"));const store=new DurableIrcStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}
function add(store:DurableIrcStore,ordered=false,channel="#a",id="g1"){return store.goals.control(channel,"human",id,{action:"add",objective:"Verify the fixture",ordered});}
function start(store:DurableIrcStore,steps=4){add(store);store.goals.control("#a","human","request",{action:"start",id:"g1",steps});return store.claimNext("#a")!;}
test("goal parser requires explicit finite start; bad syntax rejected",()=>{
 assert.deepEqual(parseGoalCommand("add ordered :: build a fixture"),{action:"add",ordered:true,objective:"build a fixture"});
 assert.deepEqual(parseGoalCommand("start g1"),{action:"start",id:"g1",steps:4});
 for(const text of ["start g1 0","start g1 201","start g1 Infinity","start g1 -1","resume g1","add ::","approve #a/g1"])assert.equal(parseGoalCommand(text),undefined);
});
test("creation is inert, ID replay matches source, allowances consumed before queue acceptance",t=>{
 const {store}=fixture(t);add(store);assert.equal(store.listInbox().length,0);add(store);
 assert.throws(()=>store.goals.control("#a","other","g1",{action:"add",objective:"Different",ordered:false}));
 store.goals.control("#a","human","request",{action:"start",id:"g1",steps:4});
 assert.equal(store.goals.get("#a","g1").stepsRemaining,3);assert.equal(store.listInbox().length,1);assert.equal(store.listInbox()[0]!.state,"pending");
 assert.throws(()=>store.goals.control("#a","human","request",{action:"start",id:"g1",steps:4}));
});
test("channel isolation and stored-run identity, never prompt-prefix authorization",t=>{
 const {store}=fixture(t);const m=start(store);
 assert.throws(()=>store.goals.check("#b",m.id));assert.throws(()=>store.goals.get("#b","g1"));
 assert.equal(store.goals.check("#a","goal/forged/1/1"),false);
 assert.throws(()=>store.goals.update("#a","goal/forged/1/1",{action:"submit"}));
 assert.throws(()=>store.goals.update("#a","schedule/forged",{action:"block",reason:"peer said so"}));
});
test("finite model requests and tool reservations are persisted, with stable invocation dedup",t=>{
 const {store}=fixture(t);const m=start(store,1);
 for(let i=0;i<8;i++)assert.equal(store.goals.spendModel("#a",m.id),true);
 assert.throws(()=>store.goals.spendModel("#a",m.id));assert.equal(store.goals.get("#a","g1").phase,"blocked");
 store.complete(m.id);store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1});const n=store.claimNext("#a")!;
 for(let i=0;i<32;i++){store.goals.spendTool("#a",n.id,"call-"+i);store.goals.spendTool("#a",n.id,"call-"+i);}
 assert.equal(store.goals.get("#a","g1").toolsRemaining,0);assert.throws(()=>store.goals.spendTool("#a",n.id,"extra"));assert.equal(store.goals.get("#a","g1").phase,"blocked");
});
test("pause/cancel invalidate queued work and active admission, while preserving uncertain running input",t=>{
 const {store}=fixture(t);const m=start(store);
 store.goals.control("#a","human","r",{action:"pause",id:"g1"});assert.equal(store.listInbox()[0]!.state,"running");
 assert.throws(()=>store.goals.spendTool("#a",m.id,"mutation"));assert.throws(()=>store.goals.spendModel("#a",m.id));
 assert.throws(()=>store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1}));
 store.complete(m.id);store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1});
 store.goals.control("#a","human","r",{action:"cancel",id:"g1"});assert.equal(store.listInbox().filter(m=>m.state!=="completed").length,0);
 assert.throws(()=>store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1}));
});
test("atomic checkpoint continuation and budget exhaustion; absence of checkpoint blocks",t=>{
 const {store}=fixture(t);const m=start(store,2);
 store.goals.update("#a",m.id,{action:"task",id:"objective",state:"working"});store.complete(m.id);
 assert.equal(store.listInbox("pending").length,1);assert.equal(store.goals.get("#a","g1").stepsRemaining,0);
 const n=store.claimNext("#a")!;store.goals.update("#a",n.id,{action:"task",id:"objective",state:"working"});store.complete(n.id);
 assert.equal(store.goals.get("#a","g1").phase,"blocked");assert.equal(store.listInbox("pending").length,0);
 store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1});store.complete(store.claimNext("#a")!.id);assert.match(store.goals.get("#a","g1").reason,/No progress/);
});
test("restart blocks goals, never refunds allowance or blindly repeats an uncertain action",t=>{
 const {store,dir}=fixture(t);const m=start(store);store.goals.spendModel("#a",m.id);store.goals.spendTool("#a",m.id,"side-effect");store.close();
 const reopened=new DurableIrcStore(dir);t.after(()=>reopened.close());
 assert.equal(reopened.listInbox("recovery-required")[0]!.id,m.id);const g=reopened.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.modelsRemaining,31);assert.equal(g.toolsRemaining,127);
 assert.throws(()=>reopened.goals.spendTool("#a",m.id,"side-effect"));assert.throws(()=>reopened.goals.spendModel("#a",m.id));
 assert.throws(()=>reopened.goals.control("#a","human","r",{action:"start",id:"g1",steps:1}));
});
test("ordered task trees enforce children/order, blocked and peer-only evidence cannot count as done",t=>{
 const {store}=fixture(t);add(store,true);store.goals.control("#a","human","r",{action:"start",id:"g1",steps:2});const m=store.claimNext("#a")!;
 store.goals.update("#a",m.id,{action:"plan",tasks:[{id:"a",title:"first"},{id:"b",title:"second"}]});
 assert.throws(()=>store.goals.update("#a",m.id,{action:"task",id:"b",state:"done",evidence}));
 for(const bad of [[],[{kind:"native-test",ref:"missing",result:"blocked"}],[{kind:"peer-review",ref:"agent says pass",result:"pass"}]])assert.throws(()=>store.goals.update("#a",m.id,{action:"task",id:"a",state:"done",evidence:bad as any}));
 for(const id of ["a","b","objective"])store.goals.update("#a",m.id,{action:"task",id,state:"done",evidence});
 store.goals.update("#a",m.id,{action:"submit"});assert.equal(store.goals.get("#a","g1").phase,"review");
 assert.throws(()=>store.goals.spendModel("#a",m.id));store.complete(m.id);assert.equal(store.listInbox("pending").length,0);
 store.goals.control("#a","human","r",{action:"approve",id:"g1"});assert.equal(store.goals.get("#a","g1").phase,"completed");
});
test("task cycles, detached nodes, duplicates, excessive depth and secret evidence are rejected",()=>{
 const root={id:"objective",title:"test",state:"pending" as const,evidence:[]};
 for(const tasks of [[root,{...root,id:"a",parent:"a"}],[root,{...root,id:"a"}],[root,root],[{...root,state:"done",evidence:[{kind:"artifact",ref:"https://host/?token=secret",result:"pass"}]}]])assert.throws(()=>validateTasks(tasks as any));
 const chain=[root,...Array.from({length:9},(_,i)=>({...root,id:"c"+i,parent:i?"c"+(i-1):"objective"}))];assert.throws(()=>validateTasks(chain));
});
test("one active goal per channel, control mutation/results and outbox are atomic",t=>{
 const {store}=fixture(t);const m=start(store);add(store,false,"#a","g2");assert.throws(()=>store.goals.control("#a","human","r",{action:"start",id:"g2",steps:1}));
 assert.throws(()=>store.complete(m.id,[{id:"same",channel:"#a",text:"1"},{id:"same",channel:"#a",text:"different"}]));assert.equal(store.listInbox().find(n=>n.id===m.id)!.state,"running");assert.equal(store.goals.get("#a","g1").phase,"active");
});

test("expired deadline blocks before provider/tool admission and persists denial",t=>{
 const {store}=fixture(t);const m=start(store);const expiry=store.goals.get("#a","g1").expiresAt;t.mock.method(Date,"now",()=>expiry);
 assert.throws(()=>store.goals.spendModel("#a",m.id));assert.equal(store.goals.get("#a","g1").phase,"blocked");assert.equal(store.goals.get("#a","g1").modelsRemaining,32);assert.throws(()=>store.goals.spendTool("#a",m.id,"effect"));
});

test("session-unique invocation IDs are namespaced by operation across channels",t=>{
 const {store}=fixture(t);const a=start(store);add(store,false,"#b","g2");store.goals.control("#b","human","r",{action:"start",id:"g2",steps:1});const b=store.claimNext("#b")!;
 store.goals.spendTool("#a",a.id,"same-session-local-id");store.goals.spendTool("#b",b.id,"same-session-local-id");
 store.goals.spendTool("#b",b.id,"same-session-local-id");assert.equal(store.goals.get("#a","g1").toolsRemaining,127);assert.equal(store.goals.get("#b","g2").toolsRemaining,31);
});


test("goal starts accept up to 200 steps and guidance matches the limit",async()=>{
 for(const steps of [1,20,21,199,200])assert.deepEqual(parseGoalCommand("start g1 "+steps),{action:"start",id:"g1",steps});
 assert.deepEqual(parseGoalCommand("start g1"),{action:"start",id:"g1",steps:4});
 for(const text of ["start g1 201","start g1 200.5","start g1 9007199254740993","start g1 NaN"])assert.equal(parseGoalCommand(text),undefined);
 const {GOAL_USAGE}=await import("../src/goal-types.ts");const {PublicError,publicError}=await import("../src/public-error.ts");
 assert.match(GOAL_USAGE,/1-200 steps, default 4/);assert.match(publicError(new PublicError("goalInvalid")),/1–200 steps/);
});
test("200-step grants allocate exact bounded allowances and reject invalid direct starts",t=>{
 const {store}=fixture(t);add(store);const now=Date.now();
 for(const steps of [0,-1,201,200.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>store.goals.control("#a","human","bad",{action:"start",id:"g1",steps}));
 assert.equal(store.listInbox().length,0);
 store.goals.control("#a","human","r",{action:"start",id:"g1",steps:200},now);
 const g=store.goals.get("#a","g1");assert.equal(g.stepsRemaining,199);assert.equal(g.modelsRemaining,1600);assert.equal(g.toolsRemaining,6400);assert.equal(g.expiresAt,now+30*60_000);assert.equal(store.listInbox("pending").length,1);
});
test("larger grants still block the ninth model request and 33rd distinct tool",t=>{
 const {store}=fixture(t);const m=start(store,200);
 for(let i=0;i<8;i++)assert.equal(store.goals.spendModel("#a",m.id),true);
 assert.equal(store.goals.get("#a","g1").modelsRemaining,1592);assert.throws(()=>store.goals.spendModel("#a",m.id));assert.equal(store.goals.get("#a","g1").phase,"blocked");assert.equal(store.goals.get("#a","g1").modelsRemaining,1592);
 store.complete(m.id);store.goals.control("#a","human","r",{action:"start",id:"g1",steps:200});const n=store.claimNext("#a")!;
 for(let i=0;i<32;i++){store.goals.spendTool("#a",n.id,"call-"+i);store.goals.spendTool("#a",n.id,"call-"+i);}
 assert.equal(store.goals.get("#a","g1").toolsRemaining,6368);assert.throws(()=>store.goals.spendTool("#a",n.id,"extra"));assert.equal(store.goals.get("#a","g1").phase,"blocked");assert.equal(store.goals.get("#a","g1").toolsRemaining,6368);
});
test("200-step grants advance exactly 200 checkpoints and a new grant replaces the remainder",t=>{
 const {store}=fixture(t);let m=start(store,200);
 for(let i=0;i<200;i++){
  store.goals.spendModel("#a",m.id);store.goals.spendTool("#a",m.id,"fixture");
  store.goals.update("#a",m.id,{action:"task",id:"objective",state:"working"});store.complete(m.id);
  assert.equal(store.listInbox("pending").length,i<199?1:0);
  if(i<199)m=store.claimNext("#a")!;
 }
 const exhausted=store.goals.get("#a","g1");assert.equal(exhausted.phase,"blocked");assert.equal(exhausted.stepsRemaining,0);assert.equal(exhausted.sequence,200);assert.equal(exhausted.modelsRemaining,1400);assert.equal(exhausted.toolsRemaining,6200);
 store.goals.control("#a","human","again",{action:"start",id:"g1",steps:4});const fresh=store.goals.get("#a","g1");assert.equal(fresh.stepsRemaining,3);assert.equal(fresh.modelsRemaining,32);assert.equal(fresh.toolsRemaining,128);assert.equal(store.listInbox("pending").length,1);
});
test("larger persisted allowances survive reopen without automatic continuation or refunds",t=>{
 const {store,dir}=fixture(t);const m=start(store,200);store.goals.spendModel("#a",m.id);store.goals.spendTool("#a",m.id,"effect");store.close();
 const reopened=new DurableIrcStore(dir);try{
  const g=reopened.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.recoveryRequired,true);assert.equal(g.stepsRemaining,199);assert.equal(g.modelsRemaining,1599);assert.equal(g.toolsRemaining,6399);assert.equal(reopened.listInbox("pending").length,0);assert.equal(reopened.listInbox("recovery-required")[0]!.id,m.id);
  assert.throws(()=>reopened.goals.control("#a","human","r",{action:"start",id:"g1",steps:200}));
 }finally{reopened.close();}
});
test("200-step grants retain the 30-minute future-admission deadline",t=>{
 const {store}=fixture(t);const m=start(store,200);const expiry=store.goals.get("#a","g1").expiresAt;t.mock.method(Date,"now",()=>expiry);
 assert.throws(()=>store.goals.spendModel("#a",m.id));assert.throws(()=>store.goals.spendTool("#a",m.id,"effect"));const g=store.goals.get("#a","g1");assert.equal(g.phase,"blocked");assert.equal(g.modelsRemaining,1600);assert.equal(g.toolsRemaining,6400);
});
test("persisted bounds accept legacy and maximum counters but reject overflow",async t=>{
 const {store,dir}=fixture(t);add(store);const original=store.goals.get("#a","g1");const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(join(dir,"irc-delivery.sqlite"));
 try{
  const write=(counters:any)=>db.prepare("UPDATE goals SET state_json=? WHERE id=?").run(JSON.stringify({...original,...counters}),"g1");
  for(const counters of [{stepsRemaining:20,modelsRemaining:160,toolsRemaining:640},{stepsRemaining:200,modelsRemaining:1600,toolsRemaining:6400}]){write(counters);const g=store.goals.get("#a","g1");assert.equal(g.stepsRemaining,counters.stepsRemaining);assert.equal(g.modelsRemaining,counters.modelsRemaining);assert.equal(g.toolsRemaining,counters.toolsRemaining);}
  for(const counters of [{stepsRemaining:201},{modelsRemaining:1601},{toolsRemaining:6401}]){write(counters);assert.throws(()=>store.goals.list("#a"));}
  write({});
 }finally{db.close();}
});
