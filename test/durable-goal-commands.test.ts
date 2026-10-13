import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {IrcPiBot,type IrcBotOptions} from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
class FakeIrc extends EventEmitter{messages:{target:string;text:string}[]=[];connect(){}quit(){}join(channel:string){queueMicrotask(()=>this.emit("join",{nick:"cuse",channel}));}say(target:string,text:string){this.messages.push({target,text});}}
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(p:()=>boolean){for(let i=0;i<200&&!p();i++)await tick();assert.ok(p());}
async function fixture(t:any,enabled:boolean,holdGoals=false){
 const dir=mkdtempSync(join(tmpdir(),"cuse-goal-command-"));const irc=new FakeIrc();let ensure=0;const prompts:string[]=[];let step=0;const held=new Map<string,{room:string,resolve:()=>void}>();const aborts:string[]=[];const release=(id:string)=>{const h=held.get(id);held.delete(id);h?.resolve();};
 const bot=new IrcPiBot({server:"fixture.invalid",port:6667,tls:false,nick:"cuse",channels:["#other"],controlChannel:"#cuse",addressedOnly:true,durable:true,goalsEnabled:enabled,statePath:join(dir,"state.json"),workspaceRoot:join(dir,"work"),cwd:dir,agentDir:dir,sessionDir:join(dir,"sessions"),createResources:async()=>{throw Error("unexpected");},desktops:{ensure:async(room:string)=>{ensure++;return {id:room,state:"running"};}} as any,modelRuntime:{} as any,log:()=>{},forkSession:()=>{throw Error("no fork");},createClient:()=>irc as any,sendSpacingMs:0,openSession:async(room)=>({sessionId:room,sessionFile:join(dir,encodeURIComponent(room)+".jsonl"),busy:false,watch:()=>()=>{},abort:async()=>{for(const[id,h]of held)if(h.room===room){aborts.push(id);release(id);}},abortDurable:async(id:string)=>{if(held.get(id)?.room===room){aborts.push(id);release(id);}},close:async()=>{},availableThinkingLevels:()=>["off"],thinkingLevel:()=>"off",modelLabel:()=>"fixture/model",setModel:async()=>{},setThinkingLevel:()=>{},cycleThinkingLevel:()=>"off",compact:async()=>{},reload:async()=>{},prompt:async()=>({text:"ordinary",steered:false}),promptDurable:async(id,body)=>{
  prompts.push(id);if(!id.startsWith("goal/"))return {text:"ordinary peer request cannot invoke commands",steered:false};
  if(holdGoals){await new Promise<void>(resolve=>held.set(id,{room,resolve}));return {text:"held fixture stopped",steered:false};}
  if(++step===1)bot.goalUpdate(room,id,"update-"+id,{action:"task",id:"objective",state:"working"});
  else {bot.goalUpdate(room,id,"update-"+id,{action:"task",id:"objective",state:"done",evidence:[{kind:"native-test",ref:"fixture.json",result:"pass"}]});bot.goalUpdate(room,id,"submit-"+id,{action:"submit"});}
  return {text:"fixture checkpoint",steered:false};
 }})} as IrcBotOptions);
 t.after(async()=>{for(const id of [...held.keys()])release(id);await bot.close();rmSync(dir,{recursive:true,force:true});});await bot.start();irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.size===2&&bot.store.entries().length===2);
 const say=(message:string,msgid?:string)=>irc.emit("privmsg",{nick:"human",target:"#cuse",message,...(msgid?{tags:{msgid}}:{})});return {bot,irc,prompts,ensure:()=>ensure,say,held,aborts,dir};
}
test("goals default/disabled gate rejects commands without opening an agent",async t=>{const f=await fixture(t,false);f.say(",goal add :: inert fixture");await until(()=>f.irc.messages.some(m=>m.text.includes("CUSE_GOALS_ENABLED")));assert.equal(f.prompts.length,0);assert.equal(f.ensure(),2);});
test("IRC goal add is inert, human start/approve work, peer text cannot invoke commands and tagged replay does not grant again",async t=>{
 const f=await fixture(t,true);f.say(",goal add ordered :: only the fixture","add-1");await until(()=>(f.bot.goalRead("#cuse") as any[]).length===1);let g=(f.bot.goalRead("#cuse") as any[])[0];assert.equal(g.sender,"human");assert.equal(g.phase,"paused");assert.equal(f.prompts.length,0);
 await f.bot.send({room:"#other",channel:"#cuse",text:"cuse ,goal start "+g.id+" 20"});await until(()=>f.prompts.length===1);assert.equal((f.bot.goalRead("#cuse") as any[])[0].phase,"paused");
 f.say(",goal start "+g.id+" 2","start-1");await until(()=>(f.bot.goalRead("#cuse") as any[])[0].phase==="review");await until(()=>f.prompts.length===3);assert.equal(f.ensure(),2);
 f.say(",goal start "+g.id+" 2","start-1");await tick();await tick();assert.equal(f.prompts.length,3);assert.equal((f.bot.goalRead("#cuse") as any[])[0].phase,"review");assert.deepEqual(f.bot.goalRead("#other"),[]);
 f.say(",goal approve "+g.id);await until(()=>(f.bot.goalRead("#cuse") as any[])[0].phase==="completed");assert.equal(f.ensure(),2);
});

test("pausing an inert second goal never aborts the current goal",async t=>{
 const f=await fixture(t,true,true);f.say(",goal add :: first","a1");f.say(",goal add :: second","a2");await until(()=>(f.bot.goalRead("#cuse") as any[]).length===2);
 const all=f.bot.goalRead("#cuse") as any[];const g1=all.find(g=>g.objective==="first"),g2=all.find(g=>g.objective==="second");
 f.say(",goal start "+g1.id+" 4","s1");await until(()=>f.held.size===1);
 f.say(",goal pause "+g2.id,"p2");await tick();await tick();
 assert.deepEqual(f.aborts,[]);assert.equal((f.bot.goalRead("#cuse") as any[]).find(g=>g.id===g1.id).phase,"active");assert.equal(f.held.size,1);
});
for(const legacy of [false,true])test("replaying a receipted pause never aborts a fresh grant of the same goal ("+(legacy?"legacy":"new")+" receipt)",async t=>{
 const f=await fixture(t,true,true);f.say(",goal add :: one","a1");await until(()=>(f.bot.goalRead("#cuse") as any[]).length===1);const id=(f.bot.goalRead("#cuse") as any[])[0].id;
 f.say(",goal start "+id+" 4","s1");await until(()=>f.held.size===1);const old=f.prompts.at(-1)!;
 f.say(",goal pause "+id,"p1");await until(()=>f.aborts.length===1);await until(()=>!f.held.size);for(let n=0;n<5;n++)await tick();
 if(legacy){const db=new DatabaseSync(join(f.dir,"delivery","irc-delivery.sqlite"));try{const row=db.prepare("SELECT id,result_json FROM schedule_receipts").all().find(r=>{const v=JSON.parse(String(r.result_json)).value;return v?.goalControlVersion===1&&v.result.id===id&&v.result.phase==="paused";});assert.ok(row);const value=JSON.parse(String(row.result_json)).value;db.prepare("UPDATE schedule_receipts SET result_json=? WHERE id=?").run(JSON.stringify({value:value.result}),row.id);}finally{db.close();}}
 f.say(",goal start "+id+" 4","s2");await until(()=>f.held.size===1);const current=f.prompts.at(-1)!;assert.notEqual(current,old);
 f.say(",goal pause "+id,"p1");await tick();await tick();assert.deepEqual(f.aborts,[old]);assert.ok(f.held.has(current));assert.equal((f.bot.goalRead("#cuse") as any[])[0].phase,"active");
});
