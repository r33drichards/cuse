import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {IrcPiBot,type IrcBotOptions} from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
class FakeIrc extends EventEmitter{messages:{target:string;text:string}[]=[];connect(){}quit(){}join(channel:string){queueMicrotask(()=>this.emit("join",{nick:"cuse",channel}));}say(target:string,text:string){this.messages.push({target,text});}}
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(p:()=>boolean){for(let i=0;i<200&&!p();i++)await tick();assert.ok(p());}
async function fixture(t:any,enabled:boolean){
 const dir=mkdtempSync(join(tmpdir(),"cuse-goal-command-"));const irc=new FakeIrc();let ensure=0;const prompts:string[]=[];let step=0;
 const bot=new IrcPiBot({server:"fixture.invalid",port:6667,tls:false,nick:"cuse",channels:["#other"],controlChannel:"#cuse",addressedOnly:true,durable:true,goalsEnabled:enabled,statePath:join(dir,"state.json"),workspaceRoot:join(dir,"work"),cwd:dir,agentDir:dir,sessionDir:join(dir,"sessions"),createResources:async()=>{throw Error("unexpected");},desktops:{ensure:async(room:string)=>{ensure++;return {id:room,state:"running"};}} as any,modelRuntime:{} as any,log:()=>{},forkSession:()=>{throw Error("no fork");},createClient:()=>irc as any,sendSpacingMs:0,openSession:async(room)=>({sessionId:room,sessionFile:join(dir,encodeURIComponent(room)+".jsonl"),busy:false,watch:()=>()=>{},abort:async()=>{},close:async()=>{},availableThinkingLevels:()=>["off"],thinkingLevel:()=>"off",modelLabel:()=>"fixture/model",setModel:async()=>{},setThinkingLevel:()=>{},cycleThinkingLevel:()=>"off",compact:async()=>{},reload:async()=>{},prompt:async()=>({text:"ordinary",steered:false}),promptDurable:async(id,body)=>{
  prompts.push(id);if(!id.startsWith("goal/"))return {text:"ordinary peer request cannot invoke commands",steered:false};
  if(++step===1)bot.goalUpdate(room,id,"update-"+id,{action:"task",id:"objective",state:"working"});
  else {bot.goalUpdate(room,id,"update-"+id,{action:"task",id:"objective",state:"done",evidence:[{kind:"native-test",ref:"fixture.json",result:"pass"}]});bot.goalUpdate(room,id,"submit-"+id,{action:"submit"});}
  return {text:"fixture checkpoint",steered:false};
 }})} as IrcBotOptions);
 t.after(async()=>{await bot.close();rmSync(dir,{recursive:true,force:true});});await bot.start();irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.size===2&&bot.store.entries().length===2);
 const say=(message:string,msgid?:string)=>irc.emit("privmsg",{nick:"human",target:"#cuse",message,...(msgid?{tags:{msgid}}:{})});return {bot,irc,prompts,ensure:()=>ensure,say};
}
test("goals default/disabled gate rejects commands without opening an agent",async t=>{const f=await fixture(t,false);f.say(",goal add :: inert fixture");await until(()=>f.irc.messages.some(m=>m.text.includes("CUSE_GOALS_ENABLED")));assert.equal(f.prompts.length,0);assert.equal(f.ensure(),2);});
test("IRC goal add is inert, human start/approve work, peer text cannot invoke commands and tagged replay does not grant again",async t=>{
 const f=await fixture(t,true);f.say(",goal add ordered :: only the fixture","add-1");await until(()=>(f.bot.goalRead("#cuse") as any[]).length===1);let g=(f.bot.goalRead("#cuse") as any[])[0];assert.equal(g.sender,"human");assert.equal(g.phase,"paused");assert.equal(f.prompts.length,0);
 await f.bot.send({room:"#other",channel:"#cuse",text:"cuse ,goal start "+g.id+" 20"});await until(()=>f.prompts.length===1);assert.equal((f.bot.goalRead("#cuse") as any[])[0].phase,"paused");
 f.say(",goal start "+g.id+" 2","start-1");await until(()=>(f.bot.goalRead("#cuse") as any[])[0].phase==="review");await until(()=>f.prompts.length===3);assert.equal(f.ensure(),2);
 f.say(",goal start "+g.id+" 2","start-1");await tick();await tick();assert.equal(f.prompts.length,3);assert.equal((f.bot.goalRead("#cuse") as any[])[0].phase,"review");assert.deepEqual(f.bot.goalRead("#other"),[]);
 f.say(",goal approve "+g.id);await until(()=>(f.bot.goalRead("#cuse") as any[])[0].phase==="completed");assert.equal(f.ensure(),2);
});
