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

test("peer question answer wakes source once, preserves ancestry and does not ping-pong", async (t) => {
	const calls: string[] = [];
	let controller!: DurableDelivery;
	const setupResult = setup(t, {
		open: async (channel) => ({
			promptDurable: async (id, body) => {
				calls.push(id);
				const current = controller.currentMessage(channel);
				assert.equal(current?.id, id);
				assert.deepEqual(current?.peer?.ancestry, ["#source", "#test"]);
				if (id === "one/answer") assert.match(body, /peer result/);
				return {
					text: id === "one" ? "peer result" : "source acknowledgement",
					steered: false,
				};
			},
			abort: async () => {},
		}),
	});
	controller = setupResult.controller;
	controller.enqueue({
		...message,
		peer: {
			kind: "question",
			source: "#source",
			rootId: "root",
			ancestry: ["#source", "#test"],
		},
	});
	await controller.startChannel("#test");
	await controller.startChannel("#source");
	assert.deepEqual(calls, ["one", "one/answer"]);
	assert.equal(setupResult.store.listInbox().length, 2);
	assert.equal(controller.currentMessage("#test"), undefined);
	assert.equal(controller.currentMessage("#source"), undefined);
});

test("peer answer waits behind active source turn then runs without another external kick", async (t) => {
	const sourceStarted = deferred<void>();
	const releaseSource = deferred<{ text: string; steered: boolean }>();
	const answered = deferred<void>();
	const calls: string[] = [];
	const { controller } = setup(t, {
		open: async () => ({
			promptDurable: async (id) => {
				calls.push(id);
				if (id === "source-work") {
					sourceStarted.resolve();
					return releaseSource.promise;
				}
				if (id === "one/answer") answered.resolve();
				return { text: "reply", steered: false };
			},
			abort: async () => {
				releaseSource.resolve({ text: "abort", steered: false });
			},
		}),
	});
	controller.enqueue({ ...message, id: "source-work", channel: "#source" });
	await sourceStarted.promise;
	controller.enqueue({
		...message,
		peer: {
			kind: "question",
			source: "#source",
			rootId: "root",
			ancestry: ["#source", "#test"],
		},
	});
	await controller.startChannel("#test");
	assert.deepEqual(calls, ["source-work", "one"]);
	releaseSource.resolve({ text: "source finished", steered: false });
	await answered.promise;
	await controller.startChannel("#source");
	assert.deepEqual(calls, ["source-work", "one", "one/answer"]);
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
