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
function fixture(root: string, options: { durable?: boolean; clear?: () => Promise<void>; prompt?: () => Promise<void> } = {}) {
 let handlers!: WeeChatHandlers;
 let clears = 0;
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
   prompt:async()=>{},promptDurable:async(_id,body)=>{prompts.push(body);await options.prompt?.();return{text:"reply",steered:false};},
   clearContext:async()=>{clears++;await options.clear?.();},abort:async()=>{},close:async()=>{},
  } as BotSession),
 });
 let id = 0;
 return {bot,prompts,posted,get clears(){return clears;},
  message:(message:string, explicitId?:string)=>handlers.message({target:"#alpha",nick:"human",message,id:explicitId ?? `event-${++id}`}).catch(() => {}),
  db:()=>new DatabaseSync(join(root,"delivery","irc-delivery.sqlite")),
 };
}

test("clear command is exact, advertised and refuses arguments", () => {
 assert.deepEqual(parseCommand(",clear"), {kind:"clear"});
 assert.deepEqual(parseCommand(",CLEAR"), {kind:"clear"});
 assert.equal(parseCommand(",clear now")?.kind, "error");
 assert.match(HELP_LINES.find(line => line.startsWith(",clear "))!, /retain history, desktop, files and schedules/);
});

test("clear gates concurrent intake and commands, retains schedules and native replay receipts", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-context-gate-")), gate = deferred();
 const f = fixture(root,{clear:()=>gate.promise});
 try {
  await f.bot.start();await settle();
  await f.message("cuse-alpha: old input", "old-input");await settle();
  assert.equal(f.prompts.length,1);
  await f.message(",schedule once 1h :: future task");await settle();
  const db=f.db();const schedules = db.prepare("SELECT * FROM schedules").all();db.close();
  const before=f.bot.store.get("#alpha");
  const reset=f.message(",clear", "clear-command");await settle();assert.equal(f.clears,1);
  await f.message("cuse-alpha: new input", "new-input");await settle();assert.equal(f.prompts.length,1);
  await f.message(",clear", "concurrent-clear");await f.message(",goal old objective");await settle();
  assert.ok(f.posted.some(text=>text.includes("reset is in progress")));
  assert.equal(f.bot.piGoal("#alpha")!.read(),null);
  gate.release();await reset;await settle();
  assert.equal(f.prompts.length,2);assert.match(f.prompts[1],/new input/);
  assert.deepEqual(f.bot.store.get("#alpha"),before);
  const after=f.db();assert.deepEqual(after.prepare("SELECT * FROM schedules").all(),schedules);after.close();
  assert.ok(f.posted.some(text=>text.startsWith("Context cleared.")));
  await f.message("cuse-alpha: old input","old-input");await f.message(",clear","clear-command");await settle();
  assert.equal(f.prompts.length,2);assert.equal(f.clears,1);
  f.bot.pollSchedules(Date.now()+3_600_001);await settle();
  assert.equal(f.prompts.length,3);assert.match(f.prompts[2],/future task/);
 } finally { gate.release();await f.bot.close();rmSync(root,{recursive:true,force:true}); }
});

test("clear refuses an active delivery without interrupting its action",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-active-")),gate=deferred();const f=fixture(root,{prompt:()=>gate.promise});
 try {await f.bot.start();await f.message("cuse-alpha: work");await settle();await f.message(",clear");await settle();
  assert.equal(f.clears,0);assert.ok(f.posted.some(text=>text.includes("Context was not cleared")));assert.equal(f.prompts.length,1);
 }finally{gate.release();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

for (const state of ["pending","recovery-required"] as const) test(`clear refuses ${state} old work without modifying it`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-pending-"));const f=fixture(root);
 try {await f.bot.start();await settle();const db=f.db();
  db.prepare("INSERT INTO inbox(id,channel,sender,body,state,created_at) VALUES(?,?,?,?,?,?)").run("old-job","#alpha","schedule:old","old task",state,Date.now());db.close();
  await f.message(",clear");await settle();assert.equal(f.clears,0);assert.equal(f.prompts.length,0);
  const after=f.db();assert.equal(after.prepare("SELECT state FROM inbox WHERE id='old-job'").get()?.state,state);after.close();
  assert.ok(f.posted.some(text=>text.includes("resolve recovery first")));
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("paused goal must be explicitly cleared before context reset",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-goal-"));const f=fixture(root);
 try{await f.bot.start();await f.message(",goal old objective");await f.message(",goal pause");await settle();
  await f.message(",clear");await settle();assert.equal(f.clears,0);
  assert.ok(f.posted.some(text=>text.includes("Use ,goal clear first")));
  await f.message(",goal clear");await settle();await f.message(",clear");await settle();assert.equal(f.clears,1);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("classic extension sessions refuse clear explicitly",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-classic-"));const f=fixture(root,{durable:false});
 try{await f.bot.start();await f.message(",clear");await settle();assert.equal(f.clears,0);assert.ok(f.posted.some(text=>text.includes("requires durable mode")));}
 finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("failed reset releases gate without claiming success or dropping newly accepted input",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-failure-")),gate=deferred();const f=fixture(root,{clear:async()=>{await gate.promise;throw Error("synthetic failure");}});
 try{await f.bot.start();const clear=f.message(",clear");await settle();await f.message("cuse-alpha: next");await settle();assert.equal(f.prompts.length,0);
  gate.release();await clear;await settle();assert.equal(f.prompts.length,1);assert.ok(!f.posted.some(text=>text.startsWith("Context cleared.")));
 }finally{gate.release();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test("restart does not replay pre-reset IRC input or the clear command",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-context-replay-"));let f=fixture(root);
 try{
  await f.bot.start();await f.message("cuse-alpha: previous task","old-native-id");await settle();
  await f.message(",clear","reset-native-id");await settle();assert.equal(f.clears,1);
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message("cuse-alpha: previous task","old-native-id");await f.message(",clear","reset-native-id");await settle();
  assert.equal(f.prompts.length,0);assert.equal(f.clears,0);
  await f.message("cuse-alpha: fresh task","new-native-id");await settle();assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/fresh task/);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
