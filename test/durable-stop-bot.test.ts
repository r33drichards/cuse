import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IrcPiBot, type BotSession } from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
import { type WeeChatHandlers, type WeeChatTransport } from "../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts";
import { parseCommand, HELP_LINES } from "../src/commands.ts";

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(root: string, options: { durable?: boolean; stop?: () => Promise<void>; prompt?: () => Promise<void> } = {}) {
 let handlers!: WeeChatHandlers;
 let stops = 0;
 const prompts: string[] = [], posted: string[] = [];
 const transport: WeeChatTransport = {
  setHandlers: value => { handlers = value; }, nickFor: () => "cuse-alpha",
  join: async channel => handlers.joined(channel), part: async channel => handlers.disconnected(channel), close: async () => {},
  say: async (_channel, text) => { posted.push(text); }, queryTopic: async () => {}, setTopic: async () => {},
  communication: () => ({ tools: async () => [], call: async () => { throw Error("unexpected tool"); } }),
 };
 const bot = new IrcPiBot({server:"test.invalid",port:6667,tls:false,nick:"cuse",controlChannel:"#alpha",channels:[],addressedOnly:true,
  durable: options.durable ?? true, goalsEnabled: true, statePath:join(root,"state.json"),workspaceRoot:join(root,"work"),cwd:root,agentDir:root,sessionDir:join(root,"sessions"),transport,
  desktopPolicy: {defaultBinding: {kind:"none"}, overrides: {}}, modelRuntime: {} as never,
  createResources: async () => { throw Error("unused"); }, forkSession: () => { throw Error("unused"); }, log: () => {}, sendSpacingMs: 0,
  openSession: async channel => ({sessionId:channel,sessionFile:join(root,"session.jsonl"),busy:false,watch:()=>()=>{},
   prompt:async(body)=>{prompts.push(body);await options.prompt?.();},promptDurable:async(_id,body)=>{prompts.push(body);await options.prompt?.();return{text:"reply",steered:false};},
   stop:async()=>{stops++;await options.stop?.();},abort:async()=>{},close:async()=>{},
  } as BotSession),
 });
 let id = 0;
 return {bot,prompts,posted,rejoin:()=>handlers.joined("#alpha"),get stops(){return stops;},
  message:(message:string, explicitId?:string)=>handlers.message({target:"#alpha",nick:"human",message,id:explicitId ?? `event-${++id}`}).catch(() => {}),
  db:()=>new DatabaseSync(join(root,"delivery","irc-delivery.sqlite")),
 };
}

test("stop parser is exact and advertised",()=>{
 assert.deepEqual(parseCommand(",stop"),{kind:"stop"});assert.deepEqual(parseCommand(",STOP"),{kind:"stop"});
 assert.equal(parseCommand(",stop now")?.kind,"error");assert.ok(HELP_LINES.some(line=>line.startsWith(",stop ")));
});
test("stop cancels queue, preserves schedule/history binding, and deduplicates native commands",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-bot-")),gate=deferred();const f=fixture(root,{prompt:()=>gate.promise,stop:async()=>{gate.release();}});
 try{
  await f.bot.start();await f.message("cuse-alpha: work","work");await settle();await f.message("cuse-alpha: queued","queued");
  await f.message(",schedule once 1h :: future task");const before=f.bot.store.get("#alpha");
  await f.message(",stop","stop-event");await settle();assert.equal(f.stops,1);assert.equal(f.prompts.length,1);
  assert.deepEqual(f.bot.store.get("#alpha"),before);assert.ok(f.posted.some(text=>text.startsWith("Stopped current")));assert.ok(!f.posted.includes("reply"));
  await f.message("cuse-alpha: future","future");await settle();assert.equal(f.prompts.length,2);
  await f.message(",stop","stop-event");await f.message("cuse-alpha: queued","queued");await settle();assert.equal(f.stops,1);assert.equal(f.prompts.length,2);
  f.bot.pollSchedules(Date.now()+3_600_001);await settle();assert.equal(f.prompts.length,3);
 }finally{gate.release();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test("idle stop acknowledges without opening a session",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-idle-"));const f=fixture(root);
 try{await f.bot.start();await f.message(",stop");await settle();assert.equal(f.stops,0);assert.equal(f.prompts.length,0);assert.ok(f.posted.some(text=>text.startsWith("Stopped current")));}
 finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test("stop pauses persistent goal without deleting its objective",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-goal-")),gate=deferred();const f=fixture(root,{prompt:()=>gate.promise,stop:async()=>gate.release()});
 try{await f.bot.start();await f.message(",goal keep this objective");await settle();await f.message(",stop");await settle();
  const goal=f.bot.piGoal("#alpha")!.read();assert.equal(goal?.status,"paused");assert.match(JSON.stringify(goal),/keep this objective/);
  const count=f.prompts.length;await settle();assert.equal(f.prompts.length,count);
 }finally{gate.release();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("a crash-persisted stop cancels an opened session before any fresh prompt",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-pending-"));let f=fixture(root);
 try{await f.bot.start();await f.message(",stop");await f.bot.close();f=fixture(root);await f.bot.start();
  await f.message("cuse-alpha: future","after-restart");await settle();assert.equal(f.stops,1);assert.equal(f.prompts.length,1);
  const db=f.db();assert.equal(db.prepare("SELECT 1 FROM pending_stops").get(),undefined);db.close();
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("classic prompt arriving during stop waits and then runs",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-classic-")),stopGate=deferred();const f=fixture(root,{durable:false,stop:()=>stopGate.promise});
 try{await f.bot.start();await f.message("cuse-alpha: first");await settle();const stop=f.message(",stop");await settle();
  const next=f.message("cuse-alpha: new");await settle();assert.equal(f.stops,1);assert.equal(f.prompts.length,1);stopGate.release();await Promise.all([stop,next]);assert.equal(f.prompts.length,2);
 }finally{stopGate.release();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("reconnect cannot bypass a failed cancellation fence",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-failed-"));let fail=true;const f=fixture(root,{stop:async()=>{if(fail)throw Error("stop failed");}});
 try{await f.bot.start();await f.message("cuse-alpha: old");await settle();await f.message(",stop");
  await f.message("cuse-alpha: new");await f.rejoin();await settle();assert.equal(f.prompts.length,1);
  fail=false;await f.message(",stop");await f.message("cuse-alpha: newer");await settle();assert.equal(f.prompts.length,2);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
