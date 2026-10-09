import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
	IrcPiBot,
	type BotSession,
	type IrcBotOptions,
} from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
import { ComputerUseClient, HttpError } from "../.runtime/pi/packages/coding-agent/src/cuse/computer-use.ts";
import { DurableIrcStore } from "../src/durable-store.ts";

class FakeIrc extends EventEmitter {
	messages: { target: string; text: string }[] = [];
	connect() {}
	quit() {}
	changeNick() {}
	join(channel: string) {
		queueMicrotask(() => this.emit("join", { nick: "cuse", channel }));
	}
	say(target: string, text: string) {
		this.messages.push({ target, text });
	}
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await tick();
	}
	assert.ok(predicate(), "condition did not become true");
}
function session(
	root: string,
	channel: string,
	prompt: NonNullable<BotSession["promptDurable"]>,
): BotSession {
	return {
		sessionId: channel,
		sessionFile: join(root, encodeURIComponent(channel) + ".jsonl"),
		busy: false,
		watch: () => () => {},
		prompt: async (body) => prompt("classic", body),
		promptDurable: prompt,
		abort: async () => {},
		close: async () => {},
		availableThinkingLevels: () => ["off"],
		thinkingLevel: () => "off",
		modelLabel: () => "test/model",
		setModel: async () => {},
		setThinkingLevel: () => {},
		cycleThinkingLevel: () => "off",
		compact: async () => {},
		reload: async () => {},
	};
}
function app(root: string, open: IrcBotOptions["openSession"], durable = true, desktopOverride?: IrcBotOptions["desktops"]) {
	const irc = new FakeIrc();
	const bot = new IrcPiBot({
		server: "synthetic.invalid",
		port: 6667,
		tls: false,
		nick: "cuse",
		channels: [],
		controlChannel: "#control",
		addressedOnly: false,
		durable,
		statePath: join(root, "state.json"),
		workspaceRoot: join(root, "work"),
		cwd: root,
		agentDir: root,
		sessionDir: join(root, "sessions"),
		desktops: desktopOverride ?? {
			ensure: async (room: string) => ({
				id: room,
				name: room,
				state: "running",
			}),
		} as IrcBotOptions["desktops"],
		modelRuntime: {} as IrcBotOptions["modelRuntime"],
		createResources: async () => {
			throw Error("unexpected resources");
		},
		openSession: open,
		forkSession: () => {
			throw Error("unexpected fork");
		},
		log: () => {},
		createClient: () =>
			irc as unknown as ReturnType<NonNullable<IrcBotOptions["createClient"]>>,
		sendSpacingMs: 0,
	});
	return { bot, irc };
}
function readInbox(root: string) {
	const db = new DatabaseSync(join(root, "delivery", "irc-delivery.sqlite"), {
		readOnly: true,
	});
	try {
		return db.prepare("SELECT * FROM inbox ORDER BY sequence").all();
	} finally {
		db.close();
	}
}

test("durable bot commits incoming message before slow session open, and sends reply once", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-bot-"));
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const calls: string[] = [];
	const { bot, irc } = app(root, async (channel) => {
		await gate;
		return session(root, channel, async (id) => {
			calls.push(id);
			return { text: "DURABLE_OK", steered: false };
		});
	});
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.has("#control"));
		irc.emit("privmsg", {
			nick: "tester",
			target: "#control",
			message: "hello",
			tags: { msgid: "message-1" },
		});
		const rows = readInbox(root);
		assert.equal(rows.length, 1);
		assert.match(String(rows[0].body), /hello/);
		assert.equal(calls.length, 0);
		release();
		await until(() => irc.messages.some((m) => m.text === "DURABLE_OK"));
		irc.emit("privmsg", {
			nick: "tester",
			target: "#control",
			message: "hello",
			tags: { msgid: "message-1" },
		});
		await tick();
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(irc.messages.filter((m) => m.text === "DURABLE_OK").length, 1);
	} finally {
		release();
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("restart resumes persisted channel and DM input with their original IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-restart-"));
	const ids: string[] = [];
	const seed = new DurableIrcStore(join(root, "delivery"));
	seed.enqueue({
		id: "channel-original",
		channel: "#control",
		sender: "tester",
		body: "channel message",
	});
	seed.enqueue({
		id: "dm-original",
		channel: "tester",
		sender: "tester",
		body: "private message",
	});
	seed.claimNext("#control");
	seed.close();
	const { bot, irc } = app(root, async (channel) =>
		session(root, channel, async (id) => {
			ids.push(id);
			return { text: id, steered: false };
		}),
	);
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => ids.length === 2);
		await until(() => irc.messages.length === 2);
		assert.deepEqual([...ids].sort(), ["channel-original", "dm-original"]);
		assert.ok(readInbox(root).every((row) => row.state === "completed"));
	} finally {
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty JOIN does not open MCP and shutdown releases exclusive delivery ownership", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-idle-"));
	let opens = 0;
	const { bot, irc } = app(root, async (channel) => {
		opens++;
		return session(root, channel, async () => ({ text: "", steered: false }));
	});
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.has("#control"));
		await tick();
		assert.equal(opens, 0);
		await bot.close();
		const reopened = new DurableIrcStore(join(root, "delivery"));
		reopened.close();
	} finally {
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("scheduled prompts stay asleep until due, enqueue once, and management replays safely", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-schedule-bot-"));
 const calls: string[] = [];
 let opens = 0;
 const {bot,irc} = app(root, async channel => {
  opens++;
  return session(root,channel,async (id) => { calls.push(id); return {text:"SCHEDULE_OK",steered:false}; });
 });
 try {
  await bot.start(); irc.emit("registered",{nick:"cuse"});
  await until(() => bot.joinedChannels.has("#control"));
  const request = {action:"create" as const,room:"#control",requestId:"create-1",timing:{kind:"delay" as const,afterMs:60000},prompt:"Reply SCHEDULE_OK"};
  const created = await bot.schedule(request) as {id:string;nextRunAt:number};
  assert.deepEqual(await bot.schedule(request),created);
  assert.equal(opens,0);
  bot.pollSchedules(created.nextRunAt-1); assert.equal(opens,0);
  bot.pollSchedules(created.nextRunAt); bot.pollSchedules(created.nextRunAt);
  await until(() => calls.length===1);
  await until(() => irc.messages.some(m=>m.text==="SCHEDULE_OK"));
  assert.equal(opens,1); assert.match(calls[0]!,/^schedule\//);
  const deletion = {action:"delete" as const,room:"#control",requestId:"delete-1",id:created.id};
  assert.deepEqual(await bot.schedule(deletion),{id:created.id,deleted:true});
  assert.deepEqual(await bot.schedule(deletion),{id:created.id,deleted:true});
  assert.deepEqual(await bot.schedule(request),created); // receipt does not resurrect deleted schedule
  assert.deepEqual(await bot.schedule({action:"list",room:"#control",requestId:"list"}),[]);
 } finally {await bot.close();rmSync(root,{recursive:true,force:true});}
});

test("IRC schedule command replay uses msgid; human can create during scheduled work", async () => {
 const root = mkdtempSync(join(tmpdir(),"cuse-schedule-command-"));
 let release!:()=>void;
 const gate = new Promise<void>(r=>{release=r;});
 let running=false;
 const {bot,irc} = app(root, async channel => session(root,channel,async()=>{running=true;await gate;return{text:"DONE",steered:false};}));
 try {
  await bot.start();irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.has("#control"));
  const initial=await bot.schedule({action:"create",room:"#control",requestId:"initial",timing:{kind:"delay",afterMs:60000},prompt:"wait"}) as {nextRunAt:number};
  bot.pollSchedules(initial.nextRunAt);await until(()=>running);
  await assert.rejects(bot.schedule({action:"create",room:"#control",requestId:"recursive",timing:{kind:"delay",afterMs:60000},prompt:"recurse"}),/cannot create/);
  const event={nick:"tester",target:"#control",message:",schedule every 5m :: check status",tags:{msgid:"schedule-command"}};
  irc.emit("privmsg",event);irc.emit("privmsg",event);
  await until(()=>irc.messages.length===2);
  const schedules=await bot.schedule({action:"list",room:"#control",requestId:"list"}) as unknown[];
  assert.equal(schedules.length,2);
 } finally {release();await bot.close();rmSync(root,{recursive:true,force:true});}
});

test("reconnect skips missed skip schedules and catches up once for default policy", async () => {
 const root=mkdtempSync(join(tmpdir(),"cuse-schedule-offline-"));
 const calls:string[]=[];
 const {bot,irc}=app(root,async channel=>session(root,channel,async(id)=>{calls.push(id);return{text:"OK",steered:false};}));
 try {
  await bot.start();irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.has("#control"));
  const common={action:"create" as const,room:"#control",timing:{kind:"interval" as const,everyMs:60000},prompt:"check"};
  const skip=await bot.schedule({...common,requestId:"skip",missedPolicy:"skip"}) as {nextRunAt:number};
  const catchup=await bot.schedule({...common,requestId:"catchup"}) as {id:string};
  irc.emit("socket close");bot.pollSchedules(skip.nextRunAt+600000);assert.equal(calls.length,0);
  irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.has("#control"));
  bot.pollSchedules(skip.nextRunAt+600000);
  await until(()=>calls.length===1);assert.ok(calls[0]!.includes(catchup.id));
 } finally {await bot.close();rmSync(root,{recursive:true,force:true});}
});

test("creating before first poll does not bypass older skip-policy recovery", async () => {
 const root=mkdtempSync(join(tmpdir(),"cuse-schedule-skip-create-"));
 const seed=new DurableIrcStore(join(root,"delivery"));
 seed.addSchedule({id:"old-skip",channel:"#control",sender:"scheduler",prompt:"must skip",timing:{kind:"interval",everyMs:60000},missedPolicy:"skip"},Date.now()-600000);
 seed.close();
 const calls:string[]=[];
 const {bot,irc}=app(root,async channel=>session(root,channel,async(id)=>{calls.push(id);return{text:"OK",steered:false};}));
 try {
  await bot.start();irc.emit("registered",{nick:"cuse"});await until(()=>bot.joinedChannels.has("#control"));
  await bot.schedule({action:"create",room:"#control",requestId:"new",timing:{kind:"delay",afterMs:60000},prompt:"new task"});
  bot.pollSchedules();await tick();assert.equal(calls.length,0);
  const rows=await bot.schedule({action:"list",room:"#control",requestId:"list"}) as {id:string;nextRunAt:number}[];
  assert.ok(rows.find(r=>r.id==="old-skip")!.nextRunAt>Date.now());
 } finally {await bot.close();rmSync(root,{recursive:true,force:true});}
});


test("remembered desktop opens recovery agent without requesting unavailable desktop", async () => {
 const root=mkdtempSync(join(tmpdir(),"cuse-open-notice-"));
 let ensures=0;
 const {bot,irc}=app(root,async(channel)=>session(root,channel,async()=>({text:"RECOVERY_READY",steered:false})),true,{
  ensure:async(room:string,id?:string)=>{
   ensures++;
   if(id) throw new HttpError(503,"PRIVATE_CANARY");
   return{id:room,name:room,state:"starting"};
  },
 } as IrcBotOptions["desktops"]);
 try {
  await bot.start();irc.emit("registered",{nick:"cuse"});
  await until(()=>bot.store.get("#control")!==undefined);
  irc.emit("privmsg",{nick:"tester",target:"#control",message:"hello",tags:{msgid:"saved"}});
  await until(()=>irc.messages.some(m=>m.text.includes("RECOVERY_READY")));
  assert.equal(readInbox(root)[0]!.state,"completed");
  assert.equal(ensures,1);
  assert.ok(!irc.messages.some(m=>m.text.includes("PRIVATE_CANARY")));
 } finally {await bot.close();rmSync(root,{recursive:true,force:true});}
});

test("desktop stop holds saved prompts until start, and sleep permits wake on next message", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-"));
 const calls: string[] = [], prompts: string[] = [];
 let release: (() => void) | undefined;
 const desktop = {
  ensure: async () => ({id: "d", name: "d", state: "running"}),
  get: async () => ({id: "d", name: "d", state: "running"}),
  viewer: () => "https://viewer.invalid/d",
  lifecycle: async (_id: string, action: string) => {calls.push(action); if (action === "stop") await new Promise<void>(r => {release = r;}); return {id: "d", state: action === "stop" ? "stopping" : "running"};},
 } as IrcBotOptions["desktops"];
 const a = app(root, async channel => session(root, channel, async (_id, body) => {prompts.push(body); return {text: "OK", steered: false};}), true, desktop);
 const send = (message: string) => a.irc.emit("privmsg", {nick: "owner", target: "#control", message});
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "d", createdAt: 1});
  send(",desktop stop"); await until(() => !!release);
  send("queued while stopping"); send(",desktop start"); await tick();
  assert.equal(prompts.length, 0); assert.deepEqual(calls, ["stop"]);
  assert.equal(a.bot.store.get("#control")?.desktopPaused, true);
  release!(); await until(() => a.irc.messages.some(m => m.text.includes("disk kept")));
  send(",desktop start"); await until(() => prompts.length === 1);
  await until(() => readInbox(root).every(m => m.state === "completed"));
  assert.equal(a.bot.store.get("#control")?.desktopPaused, false);
  send(",desktop sleep"); await until(() => calls.includes("sleep")); await tick();
  send("wake on prompt"); await until(() => prompts.length === 2);
  assert.deepEqual(calls, ["stop", "start", "sleep"]);
 } finally {release?.(); await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("desktop stop rejects an active durable worker even before session busy becomes true", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-busy-"));
 let release!: () => void; let active = false; let mutations = 0;
 const a = app(root, async channel => session(root, channel, async () => {active = true; await new Promise<void>(r => {release = r;}); return {text: "OK", steered: false};}), true, {
  ensure: async () => ({id: "d", name: "d", state: "running"}),
  lifecycle: async () => {mutations++; return {id: "d", state: "stopping"};},
 } as IrcBotOptions["desktops"]);
 try {
  await a.bot.start();
  a.irc.emit("privmsg", {nick: "owner", target: "#control", message: "work"});
  await until(() => active);
  a.irc.emit("privmsg", {nick: "owner", target: "#control", message: ",desktop stop"});
  await until(() => a.irc.messages.some(m => m.text.includes("operation is running")));
  assert.equal(mutations, 0); assert.notEqual(a.bot.store.get("#control")?.desktopPaused, true);
 } finally {release?.(); await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("desktop stop intent survives failed response and restart without opening saved messages", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-pause-"));
 let opens = 0;
 const desktops = {lifecycle: async () => {throw new HttpError(504, "ambiguous");}, ensure: async () => ({id: "d", name: "d", state: "running"})} as IrcBotOptions["desktops"];
 const open = async (channel: string) => {opens++; return session(root, channel, async () => ({text: "OK", steered: false}));};
 let a = app(root, open, true, desktops);
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "d", createdAt: 1});
  a.irc.emit("privmsg", {nick: "owner", target: "#control", message: ",desktop stop"});
  await until(() => a.irc.messages.length > 0);
  a.irc.emit("privmsg", {nick: "owner", target: "#control", message: "saved during pause", tags: {msgid: "pause-msg"}});
  await tick(); await a.bot.close();
  a = app(root, open, true, desktops); await a.bot.start();
  a.irc.emit("registered", {nick: "cuse"});
  await tick(); await tick();
  assert.equal(a.bot.store.get("#control")?.desktopPaused, true);
  assert.equal(opens, 0);
  assert.equal(readInbox(root).filter(m => m.state === "pending").length, 1);
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("confirmed desktop deletion keeps a tombstone and never provisions on later prompts or joins", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-delete-"));
 const calls: string[] = [];
 const desktops = {
  ensure: async () => {calls.push("ensure"); return {id: "old", name: "old", state: "running"};},
  delete: async (id: string) => {calls.push("delete:" + id);},
 } as IrcBotOptions["desktops"];
 const open = async () => {throw Error("must not open deleted desktop");};
 let a = app(root, open, true, desktops);
 const send = (message: string) => a.irc.emit("privmsg", {nick: "owner", target: "#control", message});
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1});
  send(",desktop delete"); await until(() => a.irc.messages.some(m => m.text.includes("Confirm with:")));
  send(",desktop delete WRONG"); await tick(); assert.deepEqual(calls, []);
  send(",desktop delete old"); await until(() => a.bot.store.get("#control")?.desktopDeleted === true && !a.bot.store.get("#control")?.desktopOperation);
  send("do more"); send(",desktop start"); await tick(); assert.deepEqual(calls, ["delete:old"]);
  await a.bot.close(); a = app(root, open, true, desktops); await a.bot.start();
  a.irc.emit("registered", {nick: "cuse"}); await tick(); await tick();
  assert.equal(a.bot.store.get("#control")?.desktopDeleted, true); assert.deepEqual(calls, ["delete:old"]);
  assert.equal(readInbox(root).filter(m => m.state === "pending").length, 1);
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("recreate reconciles ambiguous creation and cleanup across restarts before resuming with new bindings", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-recreate-"));
 const provisionKeys: string[] = [], deletes: string[] = [], openedIds: string[] = [];
 let failCreate = true, failDelete = true;
 let a: ReturnType<typeof app>;
 const desktops = {
  ensure: async (key: string, id?: string, _fresh?: boolean, beforeCreate?: () => void) => {
   if (id) return {id, name: id, state: "running"};
   provisionKeys.push(key); beforeCreate?.();
   if (failCreate) {failCreate = false; throw new HttpError(504, "ambiguous create");}
   return {id: "new", name: "new", state: "running"};
  },
  reconcile: async (key: string) => {provisionKeys.push(key); return {id: "new", name: "new", state: "running"};},
  viewer: (id: string) => "https://viewer.invalid/" + id,
  delete: async (id: string) => {
   deletes.push(id);
   assert.equal(a.bot.store.get("#control")?.desktopId, "new", "new binding must be durable before old deletion");
   if (failDelete) {failDelete = false; throw new HttpError(504, "ambiguous delete");}
  },
 } as IrcBotOptions["desktops"];
 const open: IrcBotOptions["openSession"] = async (channel, deps) => {openedIds.push((deps.desktop as unknown as {id: string}).id); return session(root, channel, async () => ({text: "OK", steered: false}));};
 a = app(root, open, true, desktops);
 const send = (message: string) => a.irc.emit("privmsg", {nick: "owner", target: "#control", message});
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1});
  send(",desktop recreate old"); await until(() => provisionKeys.length === 1); await tick();
  assert.equal(a.bot.store.get("#control")?.desktopId, "old"); assert.deepEqual(deletes, []);
  await a.bot.close(); a = app(root, open, true, desktops); await a.bot.start();
  send(",desktop new old"); await until(() => deletes.length === 1); await tick();
  assert.equal(provisionKeys[0], provisionKeys[1]); assert.equal(a.bot.store.get("#control")?.desktopPaused, true);
  send("pending"); await tick(); assert.equal(openedIds.length, 0);
  await a.bot.close(); a = app(root, open, true, desktops); await a.bot.start();
  send(",desktop recreate old"); await until(() => readInbox(root).every(m => m.state === "completed"));
  assert.deepEqual(deletes, ["old", "old"]); assert.equal(provisionKeys.length, 2);
  assert.equal(a.bot.store.get("#control")?.desktopId, "new");
  assert.equal(a.bot.store.get("#control")?.desktopOperation, undefined);
  assert.deepEqual(openedIds, ["new"]);
  send(",desktop recreate old"); await tick(); assert.deepEqual(deletes, ["old", "old"]);
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("recreate closes cached durable bindings and reopens the same conversation on the fresh desktop", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-desktop-bindings-"));
 const events: string[] = [];
 const a = app(root, async (channel, deps) => {
  const id = (deps.desktop as unknown as {id: string}).id;
  events.push("open:" + id);
  return {...session(root, channel, async () => ({text: "OK", steered: false})), close: async () => {events.push("close:" + id);}};
 }, true, {
  ensure: async (_room: string, id?: string) => ({id: id ?? "fresh", name: "test", state: "running"}),
  delete: async (id: string) => {events.push("delete:" + id);},
  viewer: (id: string) => "https://viewer.invalid/" + id,
 } as IrcBotOptions["desktops"]);
 const send = (message: string) => a.irc.emit("privmsg", {nick: "owner", target: "#control", message});
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1});
  send("first"); await until(() => readInbox(root).length === 1 && readInbox(root)[0]?.state === "completed"); await tick();
  const original = a.bot.store.get("#control")!;
  send(",desktop recreate old"); await until(() => a.bot.store.get("#control")?.desktopId === "fresh" && !a.bot.store.get("#control")?.desktopOperation);
  send("next"); await until(() => events.includes("open:fresh"));
  assert.deepEqual(events, ["open:old", "close:old", "delete:old", "open:fresh"]);
  assert.equal(a.bot.store.get("#control")?.sessionFile, original.sessionFile);
  assert.equal(a.bot.store.get("#control")?.sessionId, original.sessionId);
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("actual client never sends a second create after timeout while list visibility is delayed", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-delayed-create-"));
 let posts = 0, visible = false, createdName = "", deletes = 0;
 let a: ReturnType<typeof app>;
 const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async (url, init) => {
  if (init?.method === "POST") {
   posts++;
   assert.equal(a.bot.store.get("#control")?.desktopOperation?.createDispatched, true, "journal precedes network create");
   createdName = JSON.parse(String(init.body)).name;
   throw new HttpError(504, "backend accepted but response lost");
  }
  if (init?.method === "DELETE") {deletes++; return new Response(null, {status: 204});}
  if (String(url).endsWith("/v1/sessions")) return Response.json(visible ? [{id: "new", name: createdName, state: "running"}] : []);
  throw Error("unexpected request");
 }});
 const open = async () => {throw Error("no prompt expected");};
 a = app(root, open, true, client);
 const send = () => a.irc.emit("privmsg", {nick: "owner", target: "#control", message: ",desktop recreate old"});
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1});
  send(); await until(() => posts === 1); await tick();
  await a.bot.close(); a = app(root, open, true, client); await a.bot.start();
  send(); await until(() => a.irc.messages.some(m => m.text.includes("no second create")));
  send(); await tick(); await tick(); assert.equal(posts, 1); assert.equal(deletes, 0);
  assert.equal(a.bot.store.get("#control")?.desktopPaused, true);
  visible = true; send(); await until(() => deletes === 1); await tick();
  assert.equal(posts, 1); assert.equal(a.bot.store.get("#control")?.desktopId, "new");
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("capacity failure before dispatch restores original desktop and does not leave mutation journal", async () => {
 const root = mkdtempSync(join(tmpdir(), "cuse-create-quota-"));
 let posts = 0;
 const client = new ComputerUseClient({token: "fake", namespace: "test", maxDesktops: 1, fetch: async (_url, init) => {
  if (init?.method === "POST") posts++;
  return Response.json([{id: "old", name: client.name("#control"), state: "running"}]);
 }});
 const a = app(root, async () => {throw Error("no prompt");}, true, client);
 try {
  await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1});
  a.irc.emit("privmsg", {nick: "owner", target: "#control", message: ",desktop recreate old"});
  await until(() => a.irc.messages.some(m => m.text.includes("Desktop limit")));
  assert.equal(posts, 0); assert.equal(a.bot.store.get("#control")?.desktopOperation, undefined);
  assert.equal(a.bot.store.get("#control")?.desktopPaused, false);
  assert.equal(a.bot.store.get("#control")?.desktopId, "old");
 } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test("actual client definitive create rejections restore queue state and permit a later attempt", async () => {
 for (const status of [400, 401, 403, 409]) {
  const root = mkdtempSync(join(tmpdir(), "cuse-create-rejected-"));
  let posts = 0;
  let a: ReturnType<typeof app>;
  const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async (_url, init) => {
   if (init?.method === "POST") {
    posts++;
    assert.equal(a.bot.store.get("#control")?.desktopOperation?.createDispatched, true);
    return Response.json({code: "no_capacity", error: "PRIVATE_DETAILS"}, {status});
   }
   return Response.json([]);
  }});
  a = app(root, async () => {throw Error("no prompt expected");}, true, client);
  const send = () => a.irc.emit("privmsg", {nick: "owner", target: "#control", message: ",desktop recreate old"});
  try {
   await a.bot.start(); a.bot.store.set("#control", {desktopId: "old", createdAt: 1, desktopPaused: status === 403});
   send(); await until(() => a.irc.messages.some(m => m.text.includes("creation was rejected")));
   assert.equal(a.bot.store.get("#control")?.desktopOperation, undefined);
   assert.equal(a.bot.store.get("#control")?.desktopPaused, status === 403);
   assert.equal(a.bot.store.get("#control")?.desktopId, "old");
   assert.ok(!a.irc.messages.some(m => m.text.includes("PRIVATE_DETAILS")));
   send(); await until(() => posts === 2); await tick();
   assert.equal(a.bot.store.get("#control")?.desktopOperation, undefined);
  } finally {await a.bot.close(); rmSync(root, {recursive: true, force: true});}
 }
});

test("active agent can stop and start its own desktop without closing itself",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cuse-agent-control-")); const calls:string[]=[];
 const a=app(root,async channel=>session(root,channel,async()=>{
  assert.equal((await a.bot.desktopControl(channel,"status") as any).message,"Pod is Running but not Ready");
  await a.bot.desktopControl(channel,"stop");assert.equal(a.bot.store.get(channel)?.desktopPaused,true);
  await a.bot.desktopControl(channel,"start");assert.equal(a.bot.store.get(channel)?.desktopPaused,false);
  return{text:"SELF_RECOVERED",steered:false};
 }),true,{ensure:async()=>({id:"own",state:"running"}),get:async()=>({id:"own",state:"starting",message:"Pod is Running but not Ready"}),viewer:()=>"https://example.test/own",lifecycle:async(id:string,action:string)=>{calls.push(`${id}/${action}`);return{id,state:action};}} as any);
 try{await a.bot.start();a.irc.emit("registered",{nick:"cuse"});await until(()=>!!a.bot.store.get("#control"));a.irc.emit("privmsg",{nick:"owner",target:"#control",message:"recover"});await until(()=>a.irc.messages.some(m=>m.text==="SELF_RECOVERED"));assert.deepEqual(calls,["own/stop","own/start"]);}finally{await a.bot.close();rmSync(root,{recursive:true,force:true});}
});
