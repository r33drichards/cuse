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
function app(root: string, open: IrcBotOptions["openSession"], durable = true) {
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
		desktops: {
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
