import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import { ChannelSession, type ChannelSessionDeps } from "../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts";
import type { GoalState, PiGoalDelegate } from "../.runtime/pi/packages/coding-agent/src/cuse/pi-goal.ts";
import { fauxAssistantMessage, fauxProvider } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { ModelRuntime } from "../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

async function fixture(t: TestContext, communication?: ChannelSessionDeps["communication"]) {
	const dir = mkdtempSync(join(tmpdir(), "cuse-stop-"));
	const faux = fauxProvider({ models: [{ id: "initial" }, { id: "selected", reasoning: true }] });
	const runtime = await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
	runtime.registerNativeProvider(faux.provider);
	await runtime.getAvailable();
	const stopped = new Set<string>();
	let currentGoal: GoalState | null = null;
	const goal: PiGoalDelegate = {
		read: () => currentGoal,
		create: () => { throw new Error("No goal creation expected"); },
		update: () => { throw new Error("No goal update expected"); },
		admit: () => {},
		beginTurn: () => {},
		endTurn: () => {},
		canRun: () => false,
		fault: () => {},
	};
	const deps: ChannelSessionDeps = {
		cwd: dir,
		agentDir: dir,
		sessionDir: join(dir, "sessions"),
		modelRuntime: runtime,
		delegate: { piGoal: () => goal, isStoppedOperation: id => stopped.has(id) },
		communication: communication ?? {
			tools: async () => [],
			call: async () => { throw new Error("No communication expected"); },
		},
		log: () => {},
		createResources: async () => {
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: faux.getModel().provider,
				defaultModel: faux.getModel().id,
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			return { settingsManager, resourceLoader };
		},
	};
	const unexpectedFetch = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Network forbidden in stop tests");
	});
	let session: DurableChannelSession | undefined;
	t.after(async () => {
		await session?.close();
		rmSync(dir, { recursive: true, force: true });
		assert.equal(unexpectedFetch.mock.callCount(), 0);
	});
	session = await DurableChannelSession.open("#reset", deps);
	return {
		faux, stopped, deps,
		get session() { return session!; },
		get goal() { return currentGoal; },
		setGoal(value: GoalState | null) { currentGoal = value; },
		async reopen() {
			const file = session!.sessionFile;
			await session!.close();
			session = undefined;
			session = await DurableChannelSession.open("#reset", deps, { sessionFile: file });
		},
	};
}

async function snapshot(session: DurableChannelSession) {
	const watch = await session.lane.watch(ctx);
	try { return watch.snapshot; }
	finally { watch.unsubscribe(); }
}

test("stop preserves history, clears every queue, survives reopen, and permits new work", async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage("Retained answer")]);
 await f.session.promptDurable("old", "Retained question");
 const archive = await f.session.store.findEntries({order:"asc"}, ctx);
 const tip = await f.session.lane.getTipId(ctx);
 const id = f.session.sessionId;
 await f.session.lane.nextRun("Never run queued prompt", undefined, ctx);
 await f.session.lane.followUp("Never run follow-up", undefined, ctx);
 await f.session.lane.steer("Never run steering", undefined, ctx);
 await f.session.stop();
 assert.equal((await snapshot(f.session)).queues.length, 0);
 assert.equal(await f.session.lane.getTipId(ctx), tip);
 assert.deepEqual(await f.session.store.findEntries({order:"asc"}, ctx), archive);
 await f.session.stop();
 await f.reopen();
 await f.session.recover();
 assert.equal(f.session.sessionId, id);
 assert.equal(f.faux.state.callCount, 1);
 assert.equal((await snapshot(f.session)).queues.length, 0);
 f.faux.setResponses([fauxAssistantMessage("Next answer")]);
 assert.equal((await f.session.promptDurable("next", "Next question")).text, "Next answer");
});

test("stop cancels live provider inference and does not resume it after reopen", async t => {
 const f = await fixture(t);
 let entered!: () => void;
 const began = new Promise<void>(resolve => { entered = resolve; });
 let signal: AbortSignal | undefined;
 f.faux.setResponses([async (_context, options) => {
  signal = options?.signal;
  entered();
  await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), {once:true}));
  return fauxAssistantMessage("Cancelled output");
 }]);
 const running = f.session.promptDurable("live", "Do work");
 await began;
 await f.session.lane.nextRun("Queued work", undefined, ctx);
 await f.session.stop();
 await running;
 assert.equal(signal?.aborted, true);
 assert.equal((await f.session.lane.getResult("live",ctx))?.status, "aborted");
 assert.equal((await snapshot(f.session)).queues.length, 0);
 await f.reopen();
 await f.session.recover();
 assert.equal(f.faux.state.callCount, 1);
 assert.equal((await f.session.lane.inspectExecution(ctx)).current, null);
});

test("durable stop tombstone prevents recovery dispatch before lane cancellation was persisted", async t => {
 const f = await fixture(t);
 assert.equal((await f.session.lane.accept({kind:"prompt",operationId:"stopped",prompt:"Never dispatch"},ctx)).ok,true);
 await f.session.lane.nextRun("Also cancelled",undefined,ctx);
 f.stopped.add("stopped");
 await f.reopen();
 await f.session.recover();
 assert.equal(f.faux.state.callCount,0);
 assert.equal((await f.session.lane.getResult("stopped",ctx))?.status,"aborted");
 assert.equal((await snapshot(f.session)).queues.length,0);
 assert.equal((await f.session.promptDurable("stopped","Never dispatch")).text,"");
});

test("stop fences an admission racing with cancellation", async t => {
 const f = await fixture(t);
 let entered!: () => void, release!: () => void;
 const began = new Promise<void>(resolve => { entered=resolve; });
 const gate = new Promise<void>(resolve => { release=resolve; });
 const original = f.session.lane.accept.bind(f.session.lane);
 t.mock.method(f.session.lane,"accept",async (...args: Parameters<typeof original>) => {
  entered(); await gate; return original(...args);
 });
 const running = f.session.promptDurable("racing", "Never dispatch");
 await began;
 const stopping = f.session.stop();
 await new Promise(resolve => setImmediate(resolve));
 release();
 await stopping;
 await running;
 assert.equal(f.faux.state.callCount,0);
 assert.equal((await f.session.lane.getResult("racing",ctx))?.status,"aborted");
 await f.reopen();
 await f.session.recover();
 assert.equal(f.faux.state.callCount,0);
});

test("stop settles deferred provider operation without polling a reply", async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage("Deferred")]);
 await f.session.harness.setStreamOptions({deferred:true},ctx);
 const suspended=await f.session.lane.prompt("Defer",undefined,ctx);
 assert.equal(suspended.ok,true);
 const current=(await f.session.lane.inspectExecution(ctx)).current!.id;
 await f.session.stop();
 assert.equal((await f.session.lane.getResult(current,ctx))?.status,"aborted");
 const calls=f.faux.state.callCount;
 await f.reopen(); await f.session.recover();
 assert.equal(f.faux.state.callCount,calls);
});

test("stop cancels active tool execution and does not dispatch a second tool or resume", async t => {
 let entered!: () => void;
 const began = new Promise<void>(resolve => { entered = resolve; });
 let calls = 0, signal: AbortSignal | undefined;
 const f = await fixture(t, {
  tools: async () => [{name:"test_tool", inputSchema:{type:"object",properties:{}}}],
  call: async (_name, _args, abortSignal) => {
   calls++; signal=abortSignal;
   entered();
   await new Promise<void>(resolve => signal!.addEventListener("abort",()=>resolve(),{once:true}));
   throw new Error("Cancelled");
  },
 });
 f.faux.setResponses([fauxAssistantMessage([
  {type:"toolCall", id:"first", name:"test_tool", arguments:{}},
  {type:"toolCall", id:"second", name:"test_tool", arguments:{}},
 ], {stopReason:"toolUse"})]);
 const running = f.session.promptDurable("tool","Use tools");
 await began;
 await f.session.stop();
 await running;
 assert.equal(signal?.aborted,true);
 assert.equal(calls,1);
 await f.reopen(); await f.session.recover();
 assert.equal(calls,1);
 assert.equal(f.faux.state.callCount,1);
});

test("stop cancels retry backoff without waiting for or issuing another request", async t => {
 const f=await fixture(t);
 await f.session.harness.setRetryPolicy({enabled:true,maxRetries:3,baseDelayMs:60_000},ctx);
 let entered!: () => void;
 const began=new Promise<void>(resolve=>{entered=resolve;});
 f.session.harness.events.on("retry_scheduled",()=>entered());
 f.faux.setResponses([fauxAssistantMessage("",{stopReason:"error",errorMessage:"rate limit exceeded"})]);
 const running=f.session.promptDurable("retry","Retry later");
 await began;
 await f.session.stop(); await running;
 assert.equal(f.faux.state.callCount,1);
 assert.equal((await f.session.lane.getResult("retry",ctx))?.status,"aborted");
 await f.reopen(); await f.session.recover();
 assert.equal(f.faux.state.callCount,1);
});

test("classic stop clears steering and follow-ups, preserves history, and allows next prompt", async t => {
 const f=await fixture(t);
 const classic=await ChannelSession.open("#classic",f.deps);
 t.after(()=>classic.close());
 f.faux.setResponses([fauxAssistantMessage("Saved response")]);
 await classic.prompt("Saved question");
 const id=classic.sessionId;
 let entered!:()=>void;
 const began=new Promise<void>(resolve=>{entered=resolve;});
 let signal:AbortSignal|undefined;
 f.faux.setResponses([async (_context,options)=>{
  signal=options?.signal; entered();
  await new Promise<void>(resolve=>signal!.addEventListener("abort",()=>resolve(),{once:true}));
  return fauxAssistantMessage("Cancelled");
 }]);
 const running=classic.prompt("Cancel this");
 await began;
 await classic.session.steer("Do not steer");
 await classic.session.followUp("Do not follow up");
 await classic.stop(); await running;
 assert.equal(signal?.aborted,true);
 assert.equal(classic.session.pendingMessageCount,0);
 assert.equal(classic.sessionId,id);
 assert.match(JSON.stringify(classic.session.messages),/Saved question/);
 f.faux.setResponses([fauxAssistantMessage("New response")]);
 assert.equal((await classic.prompt("New question")).text,"New response");
 await classic.stop();
});

test("stop fences compaction admission without changing existing history", async t => {
 const f=await fixture(t);
 f.faux.setResponses([fauxAssistantMessage("Saved answer one"),fauxAssistantMessage("Saved answer two")]);
 await f.session.promptDurable("one","Saved question one");
 await f.session.promptDurable("two","Saved question two");
 await f.session.harness.setCompactionSettings({enabled:true,reserveTokens:2000,keepRecentTokens:1},ctx);
 const tip=await f.session.lane.getTipId(ctx);
 let entered!:()=>void, release!:()=>void;
 const began=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const original=f.session.lane.accept.bind(f.session.lane);
 t.mock.method(f.session.lane,"accept",async (...args:Parameters<typeof original>)=>{
  entered();await gate;return original(...args);
 });
 const running=f.session.compact(null);
 await began;
 const stopping=f.session.stop();
 await new Promise(resolve=>setImmediate(resolve));release();
 await stopping;await running;
 assert.equal(f.faux.state.callCount,2);
 assert.equal(await f.session.lane.getTipId(ctx),tip);
 assert.equal((await f.session.lane.inspectExecution(ctx)).current,null);
});

test("classic stop cancels compaction whose controller is created after stop begins", async t => {
 const f=await fixture(t);
 const classic=await ChannelSession.open("#classic-compact",f.deps);
 t.after(()=>classic.close());
 f.faux.setResponses([fauxAssistantMessage("Saved one"),fauxAssistantMessage("Saved two")]);
 await classic.prompt("Saved question one");await classic.prompt("Saved question two");
 const settings=classic.session.settingsManager.getCompactionSettings();
 t.mock.method(classic.session.settingsManager,"getCompactionSettings",()=>({...settings,keepRecentTokens:1}));
 let entered!:()=>void,release!:()=>void;
 const began=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const original=classic.session.abort.bind(classic.session);
 let calls=0;
 t.mock.method(classic.session,"abort",async()=>{
  if (++calls===1) { entered();await gate; }
  await original();
 });
 const running=classic.compact(null);
 const failed=assert.rejects(running,/cancelled|aborted/i);
 await began;
 const stopping=classic.stop();
 await new Promise(resolve=>setImmediate(resolve));release();
 await stopping;await failed;
 assert.equal(f.faux.state.callCount,2);
 assert.equal(classic.session.isCompacting,false);
 assert.match(JSON.stringify(classic.session.messages),/Saved question one/);
});
