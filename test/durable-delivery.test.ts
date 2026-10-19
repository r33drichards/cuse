import { DesktopOpenUnavailableError } from "../src/public-error.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DurableDelivery,
	type DurableDeliveryHandlers,
} from "../src/durable-delivery.ts";
import { DurableIrcStore } from "../src/durable-store.ts";

const message = { id: "one", channel: "#test", sender: "user", body: "work" };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function setup(
	t: { after(fn: () => void | Promise<void>): void },
	handlers: Partial<DurableDeliveryHandlers> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "cuse-delivery-"));
	const store = new DurableIrcStore(dir);
	const sent: string[] = [];
	const controller = new DurableDelivery(store, {
		open: async () => ({
			promptDurable: async () => ({ text: "done", steered: false }),
			abort: async () => {},
		}),
		deliver: async (_channel, text) => {
			sent.push(text);
		},
		report: () => {},
		...handlers,
	});
	t.after(async () => {
		await controller.close();
		controller.release();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, controller, sent, dir };
}
test("persists before async opening and completes replies without duplicates", async (t) => {
	let calls = 0;
	const { controller, store, sent } = setup(t, {
		open: async () => ({
			promptDurable: async () => {
				calls++;
				return { text: "first\nsecond", steered: false };
			},
			abort: async () => {},
		}),
	});
	controller.enqueue(message);
	assert.equal(store.listInbox()[0].state, "pending");
	assert.equal(controller.enqueue(message), false);
	await controller.startChannel(message.channel);
	assert.equal(calls, 1);
	assert.deepEqual(sent, ["first", "second"]);
	assert.equal(store.listInbox()[0].state, "completed");
	await controller.drainOutputs();
	assert.equal(sent.length, 2);
});
test("crash recovery reconciles same operation ID without reexecuting a completed operation", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-crash-"));
	const before = new DurableIrcStore(dir);
	before.enqueue(message);
	before.claimNext();
	before.close();
	const completed = new Map([[message.id, "saved answer"]]);
	let executed = 0;
	const sent: string[] = [];
	const store = new DurableIrcStore(dir);
	const controller = new DurableDelivery(store, {
		open: async () => ({
			promptDurable: async (id) => {
				const result = completed.get(id);
				if (result === undefined) {
					executed++;
					throw Error("unexpected");
				}
				return { text: result, steered: false };
			},
			abort: async () => {},
		}),
		deliver: async (_channel, text) => {
			sent.push(text);
		},
		report: () => {},
	});
	t.after(async () => {
		await controller.close();
		controller.release();
		rmSync(dir, { recursive: true, force: true });
	});
	await controller.startChannel(message.channel);
	assert.equal(executed, 0);
	assert.deepEqual(sent, ["saved answer"]);
	assert.equal(store.listInbox()[0].state, "completed");
});
test("failure holds later entries until explicit recovery", async (t) => {
	let fails = true;
	const calls: string[] = [];
	const { store, controller } = setup(t, {
		open: async () => ({
			promptDurable: async (id) => {
				calls.push(id);
				if (fails) throw Error("uncertain");
				return { text: "ok", steered: false };
			},
			abort: async () => {},
		}),
	});
	controller.enqueue(message);
	controller.enqueue({ ...message, id: "two" });
	await controller.startChannel(message.channel);
	assert.deepEqual(calls, ["one"]);
	assert.deepEqual(
		store.listInbox().map((m) => m.state),
		["recovery-required", "pending"],
	);
	controller.enqueue({ ...message, id: "three" });
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(calls, ["one"]);
	fails = false;
	await controller.startChannel(message.channel);
	assert.deepEqual(calls, ["one", "one", "two", "three"]);
});
test("failed output remains queued until reconnect", async (t) => {
	let connected = false;
	const sent: string[] = [];
	const { controller, store } = setup(t, {
		deliver: async (_channel, text) => {
			if (!connected) throw Error("disconnected");
			sent.push(text);
		},
	});
	controller.enqueue(message);
	await controller.startChannel(message.channel);
	assert.equal(store.listInbox()[0].state, "completed");
	assert.equal(store.listOutbox()[0].state, "pending");
	connected = true;
	await controller.drainOutputs();
	await controller.drainOutputs();
	assert.deepEqual(sent, ["done"]);
	assert.equal(store.listOutbox()[0].deliveryUncertain, true);
});
test("closing during open waits and aborts late session without starting prompt", async (t) => {
	const opening = deferred<{
		promptDurable(): Promise<{ text: string; steered: boolean }>;
		abort(): Promise<void>;
	}>();
	let prompted = false;
	let aborted = false;
	const { controller, dir } = setup(t, { open: () => opening.promise });
	controller.enqueue(message);
	const closing = controller.close();
	assert.throws(
		() => controller.enqueue({ ...message, id: "late" }),
		/closing/,
	);
	assert.throws(() => new DurableIrcStore(dir), /Another IRC process/);
	opening.resolve({
		promptDurable: async () => {
			prompted = true;
			return { text: "", steered: false };
		},
		abort: async () => {
			aborted = true;
		},
	});
	await closing;
	controller.release();
	assert.equal(prompted, false);
	assert.equal(aborted, true);
	const reopened = new DurableIrcStore(dir);
	assert.equal(reopened.listInbox()[0].state, "pending");
	reopened.close();
});
test("closing waits for active prompt and preserves its late final answer", async (t) => {
	const started = deferred<void>();
	const answer = deferred<{ text: string; steered: boolean }>();
	const { controller, dir } = setup(t, {
		open: async () => ({
			promptDurable: async () => {
				started.resolve();
				return answer.promise;
			},
			abort: async () => {
				answer.resolve({ text: "completed before abort", steered: false });
			},
		}),
	});
	controller.enqueue(message);
	await started.promise;
	await controller.close();
	controller.release();
	const reopened = new DurableIrcStore(dir);
	assert.equal(reopened.listInbox()[0].state, "completed");
	assert.equal(reopened.listOutbox()[0].state, "pending");
	reopened.close();
});

test("starting an idle remembered channel does not wake its desktop", async (t) => {
	let opens = 0;
	const { controller } = setup(t, {
		open: async () => {
			opens++;
			throw Error("unexpected open");
		},
	});
	await controller.startChannel("#idle");
	assert.equal(opens, 0);
});
test("unjoined and failing channels do not block ready channel replies", async (t) => {
	const sent: string[] = [];
	const { controller, store } = setup(t, {
		canDeliver: (channel) => channel !== "#unjoined",
		deliver: async (channel, text) => {
			if (channel === "#failing") throw Error("send failed");
			sent.push(text);
		},
	});
	store.enqueueOutput({ id: "a", channel: "#unjoined", text: "wait" });
	store.enqueueOutput({ id: "b", channel: "#failing", text: "retry" });
	store.enqueueOutput({ id: "c", channel: "#ready", text: "delivered" });
	await controller.drainOutputs();
	assert.deepEqual(sent, ["delivered"]);
	assert.deepEqual(
		store.listOutbox().map((m) => m.state),
		["pending", "pending", "sent"],
	);
});

test("ordinary replies stay in their channel and never synthesize answer mailbox turns", async (t) => {
 const calls: string[] = [];
 const { controller, store } = setup(t, {
  open: async () => ({ promptDurable: async id => { calls.push(id); return { text: "native communication is separate", steered: false }; }, abort: async () => {} }),
 });
 controller.enqueue(message);
 await controller.startChannel(message.channel);
 assert.deepEqual(calls, [message.id]);
 assert.equal(store.listInbox().length, 1);
 assert.equal(store.listInbox()[0]!.state, "completed");
 assert.deepEqual(store.listOutbox().map(output => output.channel), [message.channel]);
 assert.equal(controller.currentMessage(message.channel), undefined);
});

test("transient discovery retries with capped backoff, preserves FIFO and reports once", async (t) => {
 t.mock.timers.enable({apis: ["setTimeout"]});
 let attempts = 0;
 let ready = false;
 const executed: string[] = [];
 const reports: unknown[] = [];
 const {controller, store} = setup(t, {
  open: async () => {
   attempts++;
   if (!ready) throw new DesktopOpenUnavailableError();
   return {promptDurable: async id => {executed.push(id); return {text:"ok",steered:false};}, abort: async () => {}};
  },
  report: (_channel, error) => { reports.push(error); },
 });
 const settle = async () => {for(let i=0;i<20;i++) await Promise.resolve();};
 controller.enqueue(message);
 await settle();
 controller.enqueue({...message,id:"two"});
 await settle();
 assert.equal(attempts,1);
 for (const delay of [5000,15000,30000,60000,60000]) {
  t.mock.timers.tick(delay-1); await settle();
  const before = attempts;
  t.mock.timers.tick(1); await settle();
  assert.equal(attempts,before+1);
 }
 assert.equal(reports.length,1);
 assert.deepEqual(store.listInbox().map(m=>m.state),["pending","pending"]);
 ready=true;
 t.mock.timers.tick(60000); await settle();
 assert.deepEqual(executed,["one","two"]);
 assert.deepEqual(store.listInbox().map(m=>m.state),["completed","completed"]);
 await controller.close();
});

test("closing cancels discovery retry", async (t) => {
 t.mock.timers.enable({apis:["setTimeout"]});
 let attempts=0;
 const {controller} = setup(t,{open:async()=>{attempts++;throw new DesktopOpenUnavailableError();}});
 controller.enqueue(message);
 await controller.startChannel(message.channel);
 await controller.close();
 t.mock.timers.tick(120000);
 await Promise.resolve();
 assert.equal(attempts,1);
});

test("unclassified open failures and typed failures after dispatch do not auto retry", async (t) => {
 t.mock.timers.enable({apis:["setTimeout"]});
 for (const postDispatch of [false,true]) {
  let attempts=0;
  const {controller,store}=setup(t,{open:async()=>{
   attempts++;
   if (!postDispatch) throw Error("invalid configuration");
   return {promptDurable:async()=>{throw new DesktopOpenUnavailableError();},abort:async()=>{}};
  }});
  controller.enqueue(message);
  await controller.startChannel(message.channel);
  controller.enqueue({...message,id:"two"});
  t.mock.timers.tick(120000); await Promise.resolve();
  assert.equal(attempts,1);
  assert.equal(store.listInbox()[0].state,postDispatch?"recovery-required":"pending");
  await controller.close();
 }
});

test("pause during own turn prevents next queued message from starting", async t => {
 let paused=false,calls=0;
 const gate=deferred<void>();
 const {controller,store}=setup(t,{canOpen:()=>!paused,open:async()=>({abort:async()=>{},promptDurable:async()=>{calls++;await gate.promise;paused=true;return{text:"paused",steered:false};}})});
 controller.enqueue(message);controller.enqueue({...message,id:"two"});
 gate.resolve();await controller.startChannel(message.channel);
 assert.equal(calls,1);assert.equal(store.listInbox().find(x=>x.id==="two")?.state,"pending");
});


test("shared reply destination persists independently of home session and deduplicates", async t => {
 const deliveries: unknown[] = [], homes: string[] = [];
 const {controller, store} = setup(t, {
  open: async home => { homes.push(home); return {promptDurable: async () => ({text: "shared response", steered: false}), abort: async () => {}}; },
  deliver: async (home, text, target) => { deliveries.push([home, text, target]); },
 });
 const shared = {...message, replyTarget: "#wchat"};
 controller.enqueue(shared);
 assert.equal(store.listInbox()[0].replyTarget, "#wchat");
 assert.equal(controller.enqueue(shared), false);
 assert.throws(() => store.enqueue({...shared, replyTarget: "#other"}), /collision/);
 await controller.startChannel(message.channel);
 assert.deepEqual(homes, ["#test"]);
 assert.deepEqual(deliveries, [["#test", "shared response", "#wchat"]]);
 assert.equal(store.listOutbox()[0].replyTarget, "#wchat");
});


test("shared reply routing survives store reopen without changing owner or receipt", () => {
 const dir = mkdtempSync(join(tmpdir(), "cuse-shared-reopen-"));
 let store = new DurableIrcStore(dir);
 try {
  store.enqueue({...message, replyTarget: "#wchat"});
  store.close(); store = new DurableIrcStore(dir);
  const pending = store.claimNext("#test")!;
  assert.equal(pending.replyTarget, "#wchat");
  store.complete(pending.id, [{id: "one/reply/0", channel: pending.channel, replyTarget: pending.replyTarget, text: "persisted"}]);
  store.close(); store = new DurableIrcStore(dir);
  assert.equal(store.listInbox()[0].channel, "#test");
  assert.equal(store.listInbox()[0].state, "completed");
  assert.equal(store.listOutbox()[0].replyTarget, "#wchat");
  assert.equal(store.listOutbox()[0].channel, "#test");
 } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
});

test("shared rejoin during a failed drain retries the saved output once without rerunning work", async t => {
 const entered = deferred<void>(), release = deferred<void>(), delivered = deferred<void>();
 let attempts = 0;
 const {store, controller} = setup(t, {
  deliver: async (_home, _text, target) => {
   assert.equal(target, "#wchat");
   attempts++;
   if (attempts === 1) { entered.resolve(); await release.promise; throw Error("shared channel unavailable"); }
   delivered.resolve();
  },
 });
 store.enqueueOutput({id: "shared-rejoin", channel: "#test", text: "saved", replyTarget: "#wchat"});
 const first = controller.drainOutputs();
 await entered.promise;
 void controller.drainOutputs(true);
 release.resolve();
 await first;
 await delivered.promise;
 await controller.drainOutputs();
 assert.equal(attempts, 2);
 assert.equal(store.listOutbox()[0].state, "sent");
});

test("stop fences active/queued work, suppresses late errors and permits new intake", async t => {
 const gate = deferred<void>(), stopped = deferred<void>();
 const calls: string[] = [], errors: unknown[] = [];
 const { controller, store, sent } = setup(t, {
  open: async () => ({
   promptDurable: async id => { calls.push(id); if (id === "one") { await gate.promise; throw Error("late tool failure"); } return {text:id,steered:false}; },
   stop: async () => { stopped.resolve(); await gate.promise; }, abort: async () => { gate.resolve(); },
  }), report: (_room,error) => errors.push(error),
 });
 controller.enqueue(message);await new Promise(resolve=>setImmediate(resolve));
 controller.enqueue({...message,id:"queued"});
 const stop = controller.stopChannel("#test");await stopped.promise;
 controller.enqueue({...message,id:"future"});
 assert.deepEqual(calls,["one"]);
 assert.equal(store.isStopped("one"),true);assert.equal(store.isStopped("queued"),true);assert.equal(store.isStopped("future"),false);
 gate.resolve();assert.equal(await stop,2);await controller.startChannel("#test");
 assert.deepEqual(calls,["one","future"]);assert.deepEqual(sent,["future"]);assert.deepEqual(errors,[]);
 assert.ok(store.listInbox().every(row=>row.state==="completed"));
});

test("stop during opening prevents old dispatch and leaves other channels alone", async t => {
 const opening = deferred<void>();const calls:string[]=[];
 const {controller,store} = setup(t,{open: async channel => {
  if(channel==="#test")await opening.promise;
  return {promptDurable:async id=>{calls.push(id);return{text:"",steered:false};},stop:async()=>{},abort:async()=>{opening.resolve();}};
 }});
 controller.enqueue(message);controller.enqueue({...message,id:"other",channel:"#other"});
 const stop=controller.stopChannel("#test");controller.enqueue({...message,id:"new"});opening.resolve();await stop;
 await controller.startChannel("#test");await controller.startChannel("#other");
 assert.ok(!calls.includes("one"));assert.ok(calls.includes("new"));assert.ok(calls.includes("other"));assert.equal(store.isStopped("other"),false);
});

test("stop intent survives restart and never retries old IDs", async t => {
 const root=mkdtempSync(join(tmpdir(),"cuse-stop-restart-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let store=new DurableIrcStore(root);store.enqueue(message);store.claimNext();store.enqueue({...message,id:"queued"});
 assert.deepEqual(store.stopChannel("#test"),["one","queued"]);store.close();store=new DurableIrcStore(root);
 try {
  assert.equal(store.isStopped("one"),true);assert.equal(store.claimNext(),undefined);
  assert.equal(store.enqueue(message),false);store.complete("one",[{id:"late",channel:"#test",text:"late"}]);store.markRecoveryRequired("one");
  assert.deepEqual(store.listOutbox(),[]);assert.equal(store.listInbox("recovery-required").length,0);
  store.enqueue({...message,id:"future"});assert.equal(store.claimNext()?.id,"future");
 }finally{store.close();}
});

test("a second stop also cancels work accepted during the first stop", async t => {
 const gate=deferred<void>();const calls:string[]=[];
 const {controller,store}=setup(t,{open:async()=>({promptDurable:async id=>{calls.push(id);await gate.promise;return{text:"",steered:false};},stop:async()=>gate.resolve(),abort:async()=>gate.resolve()}),stopSession:async()=>{await gate.promise;}});
 controller.enqueue(message);await new Promise(resolve=>setImmediate(resolve));
 const first=controller.stopChannel("#test");controller.enqueue({...message,id:"between"});const second=controller.stopChannel("#test");
 assert.equal(store.isStopped("between"),true);gate.resolve();await Promise.all([first,second]);assert.deepEqual(calls,["one"]);
});

test("failed stop keeps future work blocked until explicit successful cancellation",async t=>{
 let fail=true;const calls:string[]=[];
 const {controller,store}=setup(t,{stopSession:async()=>{if(fail)throw Error("stop failed");},open:async()=>({promptDurable:async id=>{calls.push(id);return{text:"",steered:false};},abort:async()=>{}})});
 await assert.rejects(controller.stopChannel("#test"),/stop failed/);controller.enqueue({...message,id:"new"});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[]);assert.equal(store.needsStop("#test"),true);
 fail=false;await controller.stopChannel("#test");controller.enqueue({...message,id:"newer"});await controller.startChannel("#test");assert.deepEqual(calls,["newer"]);
});
