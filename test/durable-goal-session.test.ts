import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableIrcStore} from "../src/durable-store.ts";
import {DurableChannelSession} from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import {createGoalTools,goalModels,guardGoalTool} from "../.runtime/pi/packages/coding-agent/src/cuse/goal-tools.ts";
import {createModels,fauxProvider,fauxAssistantMessage} from "../.runtime/pi/packages/ai/src/index.ts";
import {SettingsManager} from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import {DefaultResourceLoader} from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";
import {BACKGROUND_CONTEXT as ctx} from "../.runtime/pi/packages/agent/src/index.ts";
async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),"cuse-goal-harness-"));let store=new DurableIrcStore(join(dir,"delivery"));const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);const runtime=Object.create(models);runtime.getAvailable=async()=>[faux.getModel()];let external=0;
 const delegate:any={send:async()=>{},goalEnabled:()=>true,goalRead:(room:string)=>store.goals.list(room),goalGuard:(room:string,id:string,kind:string,invocation:string)=>{if(!store.goals.isRun(id))return false;if(kind==="model")return store.goals.spendModel(room,id);if(kind==="tool")store.goals.spendTool(room,id,invocation);else store.goals.check(room,id);return true;},goalUpdate:(room:string,id:string,requestId:string,input:any)=>store.scheduleOperation("goal/update/"+requestId,JSON.stringify({id,input}),()=>store.goals.update(room,id,input)),goalFault:(room:string,id:string)=>store.goals.quarantineRun(room,id),goalBlock:(room:string,id:string)=>{if(!store.goals.isRun(id))return false;store.goals.blockRun(room,id);return true;}};
 const deps:any={cwd:dir,agentDir:dir,sessionDir:join(dir,"sessions"),modelRuntime:runtime,delegate,log:()=>{},desktop:{call:async()=>{external++;return {content:[{type:"text",text:"fixture external action"}]};}},createResources:async()=>{const settingsManager=SettingsManager.inMemory({defaultProvider:faux.getModel().provider,defaultModel:faux.getModel().id});const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();return {settingsManager,resourceLoader};}};
 let session=await DurableChannelSession.open("#a",deps);t.after(async()=>{await session.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const start=()=>{store.goals.control("#a","human","g1",{action:"add",ordered:true,objective:"Test fixtures only"});store.goals.control("#a","human","r",{action:"start",id:"g1",steps:2});return store.claimNext("#a")!;};
 return {get store(){return store;},faux,get session(){return session;},start,external:()=>external,delegate,deps,reopen:async()=>{const file=session.sessionFile;await session.close();store.close();store=new DurableIrcStore(join(dir,"delivery"));session=await DurableChannelSession.open("#a",deps,{sessionFile:file});}};
}
const call=(id:string,args:any)=>fauxAssistantMessage([{type:"toolCall",id,name:"goal_update",arguments:args}],{stopReason:"toolUse"});
const evidence=[{kind:"native-test",ref:"fixture:assertions.json",result:"pass"}];
test("actual durable harness binds run identity, finite admissions and task evidence; submit cannot auto-approve",async t=>{
 const f=await fixture(t);const m=f.start();f.faux.setResponses([
 call("plan",{action:"plan",tasks:[{id:"a",title:"first"},{id:"b",title:"second"}]}),
 call("a",{action:"task",id:"a",state:"done",evidence}),call("b",{action:"task",id:"b",state:"done",evidence}),call("root",{action:"task",id:"objective",state:"done",evidence}),call("submit",{action:"submit"}),
 fauxAssistantMessage("SHOULD NEVER REACH PROVIDER AFTER SUBMIT")]);
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);const g=f.store.goals.get("#a","g1");
 assert.equal(g.phase,"review");assert.equal(g.modelsRemaining,11);assert.equal(g.toolsRemaining,59);assert.equal(f.faux.state.callCount,5);assert.equal(f.external(),0);assert.equal(f.store.listInbox("pending").length,0);
 assert.ok(f.store.listOutbox().some(m=>m.text.includes("human review/approve")));
});
test("pause after provider generation blocks a prepared external tool before dispatch",async t=>{
 const f=await fixture(t);const m=f.start();f.faux.setResponses([()=>{f.store.goals.control("#a","human","r",{action:"pause",id:"g1"});return fauxAssistantMessage([{type:"toolCall",id:"external",name:"run_js",arguments:{code:"console.log(1)"}}],{stopReason:"toolUse"});},fauxAssistantMessage("should not generate")]);
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);assert.equal(f.external(),0);assert.equal(f.faux.state.callCount,1);assert.equal(f.store.goals.get("#a","g1").phase,"paused");
});
test("normal turns remain normal; they cannot smuggle start/update authority through tool fields",async t=>{
 const f=await fixture(t);f.faux.setResponses([call("forged",{action:"submit"}),fauxAssistantMessage("Goal origin was rejected")]);
 assert.equal((await f.session.promptDurable("ordinary",",goal start g1 20")).text,"Goal origin was rejected");assert.equal(f.store.goals.list("#a").length,0);
});
test("finite provider calls cap an attempted tool loop at the request boundary",async t=>{
 const f=await fixture(t);const m=f.start();f.faux.setResponses(Array.from({length:20},(_,i)=>fauxAssistantMessage([{type:"toolCall",id:"read-"+i,name:"goal_status",arguments:{}}],{stopReason:"toolUse"})));
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);assert.equal(f.faux.state.callCount,8);assert.equal(f.store.goals.get("#a","g1").phase,"blocked");assert.equal(f.external(),0);
});
test("tool immediate guard blocks a pause race after the hook; invocation identity bound by host",async()=>{
 let sideEffects=0;const guarded=guardGoalTool({name:"remote",label:"remote",description:"fixture",parameters:{} as any,execute:async()=>{sideEffects++;return {content:[],details:{}};}},{send:async()=>{},goalGuard:()=>{throw Error("paused");}},"#a");
 await assert.rejects(guarded.execute("c",{},()=>{},undefined,{operationId:"goal/g1/1/1",invocationId:"stable"} as any,ctx));assert.equal(sideEffects,0);
 let bound:any;const tools=createGoalTools({send:async()=>{},goalEnabled:()=>true,goalUpdate:(...args:any[])=>{bound=args;return {};}} as any,"#owned");const update=tools.find(t=>t.name==="goal_update")!;
 await update.execute("call",{action:"block",reason:"inspect"},()=>{},undefined,{operationId:"actual-op",invocationId:"actual-invocation"} as any,ctx);assert.deepEqual(bound,["#owned","actual-op","actual-invocation",{action:"block",reason:"inspect"}]);
});
test("model proxy preserves receiver, normal options, and enforces goal request caps/deadline options",async()=>{
 const calls:any[]=[];const models:any={streamSimple(...args:any[]){assert.equal(this,models);calls.push(args);return "stream";},getAvailable(){assert.equal(this,models);return [];} };let isGoal=false;
 const proxy=goalModels(models,{send:async()=>{},goalGuard:()=>isGoal},"#a",()=>"op");const original={maxTokens:2000,maxRetries:3,timeoutMs:2000};proxy.streamSimple({} as any,{} as any,original);assert.equal(calls[0][2],original);
 isGoal=true;proxy.streamSimple({} as any,{} as any,{maxTokens:9000,maxRetries:8,timeoutMs:900000});assert.ok(calls[1][2].signal instanceof AbortSignal);const {signal,...limited}=calls[1][2];assert.deepEqual(limited,{maxTokens:4096,maxRetries:0,timeoutMs:300000,transport:"sse",deferred:false});proxy.getAvailable();
 const unknown=goalModels(models,{send:async()=>{}},"#a",()=>"");assert.equal((await unknown.streamSimple({} as any,{} as any).result()).stopReason,"error");assert.equal(calls.length,2);
});

test("actual interrupted goal recovery cannot borrow a newer human message's authority or repeat the effect",async t=>{
 const f=await fixture(t);const m=f.start();let dispatched!:()=>void;const began=new Promise<void>(r=>{dispatched=r;});let effects=0;
 f.deps.desktop.call=async()=>{effects++;dispatched();return new Promise(()=>{});};
 f.faux.setResponses([fauxAssistantMessage([{type:"toolCall",id:"uncertain",name:"run_js",arguments:{code:"console.log(1)"}}],{stopReason:"toolUse"})]);
 const pending=f.session.promptDurable(m.id,m.body).catch(()=>undefined);await began;await f.session.suspend();await f.reopen();await pending;
 assert.equal(f.store.goals.get("#a","g1").phase,"blocked");
 f.faux.setResponses([fauxAssistantMessage("Ordinary human inspection proceeds; no goal restart.")]);
 const reply=await f.session.promptDurable("new-human-inspect","Inspect the prior uncertain action, do not repeat it.");
 assert.match(reply.text,/Ordinary human inspection/);assert.equal(effects,1);assert.equal(f.faux.state.callCount,2);assert.equal(f.store.goals.get("#a","g1").phase,"blocked");
});

test("goals cannot escape model allowances by delegating peers or resuming/deleting schedules; normal human turns unchanged",async()=>{
 let effects=0;let isGoal=true;const delegate={send:async()=>{},goalGuard:()=>isGoal};
 for(const [name,params] of [["agent_ask",{}],["irc_send",{}],["schedule_prompt",{action:"create"}],["schedule_prompt",{action:"resume"}],["schedule_prompt",{action:"delete"}]]){
  const tool=guardGoalTool({name:name as string,label:"fixture",description:"fixture",parameters:{} as any,execute:async()=>{effects++;return {content:[],details:{}};}},delegate,"#a");
  await assert.rejects(tool.execute("c",params as any,()=>{},undefined,{operationId:"goal/g/1/1",invocationId:"stable"} as any,ctx));
  assert.equal(effects,0);
 }
 const list=guardGoalTool({name:"schedule_prompt",label:"fixture",description:"fixture",parameters:{} as any,execute:async()=>{effects++;return {content:[],details:{}};}},delegate,"#a");
 await list.execute("c",{action:"list"},()=>{},undefined,{operationId:"goal/g/1/1",invocationId:"list"} as any,ctx);assert.equal(effects,1);
 isGoal=false;await list.execute("c",{action:"resume"},()=>{},undefined,{operationId:"human",invocationId:"resume"} as any,ctx);assert.equal(effects,2);
});

for(const name of ["run_js","desktop_control"])test("actual harness pause during async memo blocks "+name+" at dispatch",async t=>{
 const f=await fixture(t);const m=f.start();const original=f.delegate.goalGuard;let revoked=false,lifecycle=0;
 f.delegate.desktopControl=async()=>{lifecycle++;return {state:"stopped"};};
 f.delegate.goalGuard=(room:string,id:string,kind:string,invocation:string)=>{const admitted=original(room,id,kind,invocation);if(kind==="tool"&&!revoked){revoked=true;queueMicrotask(()=>f.store.goals.control("#a","human","p",{action:"pause",id:"g1"}));}return admitted;};
 f.faux.setResponses([fauxAssistantMessage([{type:"toolCall",id:"memo-race",name,arguments:name==="run_js"?{code:"console.log(1)"}:{action:"stop"}}],{stopReason:"toolUse"}),fauxAssistantMessage("must not call provider again")]);
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);assert.equal(revoked,true);assert.equal(f.external(),0);assert.equal(lifecycle,0);assert.equal(f.faux.state.callCount,1);assert.equal(f.store.goals.get("#a","g1").phase,"paused");
});

test("provider-level aborted request must not strand goal delivery in recovery",async t=>{
 const f=await fixture(t);const m=f.start();f.faux.setResponses([fauxAssistantMessage("",{stopReason:"aborted",errorMessage:"Request was aborted"})]);
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);assert.equal(f.store.goals.get("#a","g1").phase,"blocked");assert.equal(f.faux.state.callCount,1);assert.equal(f.external(),0);
});

test("legacy provider-abort fault can be cancelled on reopen without paid calls or replay, but human inspection remains required",async t=>{
 const f=await fixture(t);const m=f.start();const original=f.delegate.goalGuard;
 // Simulate the old adapter: charged request but no normalization of provider abort.
 f.delegate.goalGuard=(room:string,id:string,kind:string,invocation:string)=>{const v=original(room,id,kind,invocation);return kind==="model"?false:v;};
 f.faux.setResponses([fauxAssistantMessage("",{stopReason:"aborted",errorMessage:"Request was aborted"})]);
 await assert.rejects(f.session.promptDurable(m.id,m.body));assert.equal(f.store.goals.get("#a","g1").recoveryRequired,true);
 f.store.markRecoveryRequired(m.id);f.delegate.goalGuard=original;await f.reopen();
 const before=f.faux.state.callCount;f.store.retry(m.id);assert.equal(f.store.claimNext("#a")?.id,m.id);await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);
 assert.equal(f.faux.state.callCount,before);assert.equal(f.external(),0);assert.equal((await f.session.lane.inspectExecution(ctx)).current,null);
 assert.throws(()=>f.store.goals.control("#a","human","r",{action:"start",id:"g1",steps:1}),/Inspect unknown outcomes/);
 const old=f.store.goals.get("#a","g1");f.store.receiptOperation("recover-once","inspected",()=>f.store.goals.control("#a","human","r",{action:"recover",id:"g1",acknowledge:"inspected"}));const now=f.store.goals.get("#a","g1");
 assert.equal(now.recoveryRequired,false);assert.equal(now.modelsRemaining,old.modelsRemaining);assert.equal(now.toolsRemaining,old.toolsRemaining);assert.equal(now.phase,"blocked");assert.equal(f.store.listInbox("pending").length,0);
 f.store.goals.quarantineRun("#a",m.id);const replay=f.store.receiptOperation("recover-once","inspected",()=>f.store.goals.control("#a","human","r",{action:"recover",id:"g1",acknowledge:"inspected"}));assert.equal(replay.replayed,true);assert.equal(f.store.goals.get("#a","g1").recoveryRequired,true);
 f.store.goals.control("#a","human","g2",{action:"add",objective:"Inert second goal",ordered:false});assert.throws(()=>f.store.goals.control("#a","human","r",{action:"start",id:"g2",steps:1}),/Inspect unknown outcomes/);
});
test("request deadline is a normal failure while true caller cancellation stays aborted",async()=>{
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);const proxy=goalModels(models,{send:async()=>{},goalGuard:()=>true},"#a",()=>"goal-op",5);
 faux.setResponses([async(_context,options)=>{await new Promise<void>(resolve=>{const keepAlive=setTimeout(resolve,100);const done=()=>{clearTimeout(keepAlive);resolve();};if(options?.signal?.aborted)done();else options?.signal?.addEventListener("abort",done,{once:true});});return fauxAssistantMessage("",{stopReason:"aborted",errorMessage:"provider secret must not leak"});}]);
 const deadline=await proxy.streamSimple(faux.getModel(),{messages:[]}).result();assert.equal(deadline.stopReason,"error");assert.match(deadline.errorMessage??"",/timed out/);assert.ok(!deadline.errorMessage?.includes("secret"));
 const caller=new AbortController();let began!:()=>void;const ready=new Promise<void>(r=>{began=r;});
 faux.setResponses([async(_context,options)=>{began();await new Promise<void>(resolve=>options?.signal?.addEventListener("abort",()=>resolve(),{once:true}));return fauxAssistantMessage("",{stopReason:"aborted"});}]);
 const cancelProxy=goalModels(models,{send:async()=>{},goalGuard:()=>true},"#a",()=>"goal-op",1000);const running=cancelProxy.streamSimple(faux.getModel(),{messages:[]},{signal:caller.signal});await ready;caller.abort();const cancelled=await running.result();assert.equal(cancelled.stopReason,"aborted");
});

test("durable diagnostics emit fixed classifications without invoking hostile getters or leaking messages",async()=>{
 const {durableDiagnostic}=await import("../.runtime/pi/packages/coding-agent/src/cuse/durable-diagnostic.ts");
 const e=new Error("password=must-not-leak");e.name="HarnessFault";Object.defineProperty(e,"cause",{value:new Error("Assistant response is aborted while durable control is running")});assert.equal(durableDiagnostic(e),"provider-abort-control-mismatch");
 const hostile={};Object.defineProperty(hostile,"name",{get(){throw Error("secret");}});assert.equal(durableDiagnostic(hostile),"unclassified");assert.equal(durableDiagnostic(new Error("token=hidden")),"unclassified");
});

test("aborted partial tool calls are recorded as failed responses, never dispatched",async t=>{
 const f=await fixture(t);const m=f.start();f.faux.setResponses([fauxAssistantMessage([{type:"toolCall",id:"unfinished",name:"run_js",arguments:{code:"forbidden fixture effect"}}],{stopReason:"aborted"})]);
 await f.session.promptDurable(m.id,m.body);f.store.complete(m.id);assert.equal(f.external(),0);assert.equal(f.faux.state.callCount,1);assert.equal(f.store.goals.get("#a","g1").phase,"blocked");
 const {parseGoalCommand}=await import("../src/goal-types.ts");assert.equal(parseGoalCommand("recover g1"),undefined);assert.deepEqual(parseGoalCommand("recover g1 inspected"),{action:"recover",id:"g1",acknowledge:"inspected"});
});
