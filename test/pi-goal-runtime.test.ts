import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableIrcStore } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-store.ts";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import type { ChannelSessionDeps } from "../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts";
import type { PiGoalDelegate } from "../.runtime/pi/packages/coding-agent/src/cuse/pi-goal.ts";
import { createPiGoalTools } from "../.runtime/pi/packages/coding-agent/src/cuse/pi-goal-tools.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx, type HarnessEvent } from "../.runtime/pi/packages/agent/src/index.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "cuse-pi-goal-"));
	const sessions = new Map<string, DurableChannelSession>();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = Object.create(models);
	runtime.getAvailable = async () => [faux.getModel()];
	let store = new DurableIrcStore(join(dir, "delivery"));
	let enabled = true;
	const events: HarnessEvent[] = [];
	const diagnostics: string[] = [];
	const unexpectedFetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in pi-goal integration tests"); });
	const access = (room: string): PiGoalDelegate => ({
		read: () => store.piGoals.read(room),
		admit: operationId => store.piGoals.admit(room, operationId),
		canRun: operationId => store.piGoals.canRun(operationId),
		create: (objective, tokenBudget, requestId, turnId) => store.receiptOperation(
			`pi-goal/tool/${room}/${requestId}`, JSON.stringify({ action: "create", objective, tokenBudget, turnId }),
			() => store.piGoals.create(room, objective, tokenBudget, turnId),
		).value,
		update: (status, requestId, turnId) => store.receiptOperation(
			`pi-goal/tool/${room}/${requestId}`, JSON.stringify({ action: "update", status, turnId }),
			() => store.piGoals.update(room, status, turnId),
		).value,
		beginTurn: (turnId, operationId, snapshot) => store.piGoals.beginTurn(room, turnId, undefined, operationId, snapshot),
		endTurn: (turnId, usage) => store.piGoals.endTurn(room, turnId, usage),
		fault: operationId => store.piGoals.fault(room, operationId),
	});
	const deps: ChannelSessionDeps = {
		cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), modelRuntime: runtime,
		communication: { tools: async () => [], call: async () => { throw Error("No native communication expected"); } },
		delegate: { piGoal: room => enabled ? access(room) : undefined },
		desktop: { call: async () => { throw new Error("No desktop execution expected"); } } as unknown as ChannelSessionDeps["desktop"],
		log: line => diagnostics.push(line),
		createResources: async () => {
			const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id });
			const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await resourceLoader.reload();
			return { settingsManager, resourceLoader };
		},
	};
	const open = async (room = "#one", sessionFile?: string) => {
		const session = await DurableChannelSession.open(room, deps, sessionFile ? { sessionFile } : {});
		sessions.set(room, session);
		for (const type of ["turn_start", "turn_end", "run_end", "tool_end", "handler_error"] as const) session.harness.events.on(type, event => { events.push(event); });
		return session;
	};
	await open();
	t.after(async () => {
		for (const session of sessions.values()) await session.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
		assert.equal(unexpectedFetch.mock.callCount(), 0);
	});
	const runNext = async (room = "#one") => {
		const message = store.claimNext(room);
		assert.ok(message, `Expected pending input for ${room}`);
		const session = sessions.get(room)!;
		const result = await session.promptDurable(message.id, message.body);
		store.complete(message.id);
		return { message, result };
	};
	return {
		get store() { return store; }, get session() { return sessions.get("#one")!; },
		faux, access, open, runNext, events, diagnostics,
		setEnabled(value: boolean) { enabled = value; },
		setDesktopCall(call: ChannelSessionDeps["desktop"]["call"]) { deps.desktop.call = call; },
		async restart() {
			const files = [...sessions].map(([room, session]) => [room, session.sessionFile] as const);
			for (const session of sessions.values()) await session.close();
			sessions.clear();
			store.close();
			store = new DurableIrcStore(join(dir, "delivery"));
			for (const [room, file] of files) await open(room, file);
		},
	};
}

function call(name: string, args: Record<string, unknown>, id = name) {
	return fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }], { stopReason: "toolUse" });
}

function turnEvents(events: HarnessEvent[]) {
	return events.filter((event): event is Extract<HarnessEvent, { type: "turn_end" }> => event.type === "turn_end");
}

test("native durable pi-goal continues only after settlement and charges the completion turn once", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Verify the synthetic fixture and report its result");
	f.faux.setResponses([fauxAssistantMessage("First check completed"), call("update_goal", { status: "complete" }), fauxAssistantMessage("Verified and complete")]);
	const first = await f.runNext();
	assert.equal(f.faux.state.callCount, 1);
	assert.equal(f.store.piGoals.read("#one")?.status, "active");
	assert.equal(f.store.listInbox("pending").length, 1);
	assert.equal((await f.session.lane.inspectExecution(ctx)).current, null);
	const second = await f.runNext();
	assert.equal(f.faux.state.callCount, 3);
	assert.equal(second.result.text, "Verified and complete");
	assert.equal(f.store.piGoals.read("#one")?.status, "complete");
	assert.equal(f.store.listInbox("pending").length, 0);
	const turns = turnEvents(f.events);
	assert.equal(turns.length, 3);
	const expected = turns[0].message.usage.totalTokens + turns[1].message.usage.totalTokens;
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, expected, "The final complete tool turn is charged; post-completion summary is not");
	f.access("#one").endTurn(`${f.session.sessionId}:${turns[1].turnId}`, turns[1].message.usage);
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, expected, "Recovery event replay must not charge twice");
	await f.session.promptDurable(first.message.id, first.message.body);
	await f.session.promptDurable(second.message.id, second.message.body);
	assert.equal(f.faux.state.callCount, 3, "Completed delivery replay must not call a provider again");
	assert.deepEqual(f.diagnostics, []);
});

test("create/get/update goal tools retain upstream contract inside one durable run", async t => {
	const f = await fixture(t);
	const tools = await f.session.lane.getActiveTools(ctx);
	for (const name of ["create_goal", "get_goal", "update_goal", "run_js", "desktop_control", "schedule_prompt"]) assert.ok(tools.includes(name), name);
	for (const name of ["read", "write", "edit", "bash", "goal_status", "goal_update"]) assert.ok(!tools.includes(name), name);
	f.store.enqueue({ id: "human-create", channel: "#one", sender: "human", body: "Set a goal to verify this synthetic fixture" });
	f.faux.setResponses([
		call("create_goal", { objective: "Verify the synthetic fixture" }),
		context => {
			assert.match(context.systemPrompt ?? "", /perform a completion audit/);
			assert.match(context.systemPrompt ?? "", /<untrusted_objective>\nVerify the synthetic fixture/);
			return call("get_goal", {});
		},
		call("update_goal", { status: "complete" }),
		context => { assert.match(context.systemPrompt ?? "", /The goal has been marked complete/); return fauxAssistantMessage("Done"); },
	]);
	await f.runNext();
	assert.equal(f.store.piGoals.read("#one")?.objective, "Verify the synthetic fixture");
	assert.equal(f.store.piGoals.read("#one")?.status, "complete");
	assert.equal(f.store.listInbox("pending").length, 0);
	const turns = turnEvents(f.events);
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, turns[1].message.usage.totalTokens + turns[2].message.usage.totalTokens);
	const results = f.events.filter(event => event.type === "tool_end");
	assert.equal(results.length, 3);
	assert.ok(results.every(event => !event.isError));
});

test("pause is responsive during a live turn without aborting it or queuing continuation", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let signal: AbortSignal | undefined;
	f.faux.setResponses([async (_context, options) => { signal = options?.signal; entered(); await gate; return fauxAssistantMessage("Current turn finished"); }]);
	const running = f.runNext();
	await began;
	f.store.piGoals.command("#one", "pause");
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	assert.equal(f.session.busy, true);
	assert.equal(signal?.aborted, false);
	release();
	assert.equal((await running).result.text, "Current turn finished");
	assert.equal(f.faux.state.callCount, 1);
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, turnEvents(f.events)[0].message.usage.totalTokens);
});

test("token budget produces one wrap-up and stops subsequent goal work", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "--tokens 1 Inspect the synthetic fixture");
	f.faux.setResponses([fauxAssistantMessage("Progress before the budget boundary"), fauxAssistantMessage("Budget reached; remaining work is recorded")]);
	await f.runNext();
	const exhausted = f.store.piGoals.read("#one")!;
	assert.equal(exhausted.status, "budget_limited");
	assert.ok(exhausted.tokensUsed >= 1);
	const pending = f.store.listInbox("pending");
	assert.equal(pending.length, 1);
	assert.match(pending[0].body, /reached its token budget/);
	await f.runNext();
	assert.equal(f.faux.state.callCount, 2);
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, exhausted.tokensUsed);
});

test("same-cwd channels have independent goals and clearing cancels only their own continuation", async t => {
	const f = await fixture(t);
	await f.open("#two");
	f.store.piGoals.command("#one", "First channel objective");
	f.store.piGoals.command("#two", "Second channel objective");
	assert.notEqual(f.store.piGoals.read("#one")?.id, f.store.piGoals.read("#two")?.id);
	f.store.piGoals.command("#one", "clear");
	assert.equal(f.store.piGoals.read("#one"), null);
	assert.equal(f.store.piGoals.read("#two")?.objective, "Second channel objective");
	assert.equal(f.store.listInbox("pending").filter(message => message.channel === "#one").length, 0);
	f.faux.setResponses([call("update_goal", { status: "complete" }), fauxAssistantMessage("Second channel verified")]);
	await f.runNext("#two");
	assert.equal(f.store.piGoals.read("#two")?.status, "complete");
	assert.equal(f.store.piGoals.read("#one"), null);
});

test("host restart pauses an active goal and never replays its pending continuation", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	f.faux.setResponses([fauxAssistantMessage("First pass done")]);
	await f.runNext();
	const before = f.store.piGoals.read("#one")!;
	assert.equal(f.store.listInbox("pending").length, 1);
	await f.restart();
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	assert.equal(f.store.piGoals.read("#one")?.tokensUsed, before.tokensUsed);
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal(f.faux.state.callCount, 1);
	f.store.piGoals.command("#one", "resume");
	assert.equal(f.store.listInbox("pending").length, 1);
	f.faux.setResponses([call("update_goal", { status: "complete" }), fauxAssistantMessage("Resumed and completed")]);
	await f.runNext();
	assert.equal(f.store.piGoals.read("#one")?.status, "complete");
	assert.equal(f.faux.state.callCount, 3);
});

for (const enabled of [true, false]) test(`restart settles an accepted goal operation without provider replay when goals are ${enabled ? "paused" : "disabled"}`, async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	const message = f.store.claimNext("#one")!;
	const accepted = await f.session.lane.accept({ kind: "prompt", operationId: message.id, prompt: message.body }, ctx);
	assert.equal(accepted.ok, true);
	f.setEnabled(enabled);
	await f.restart();
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	await f.session.promptDurable(message.id, message.body);
	assert.equal(f.faux.state.callCount, 0);
	assert.equal((await f.session.lane.inspectExecution(ctx)).current, null);
	assert.equal((await f.session.lane.getResult(message.id, ctx))?.status, "aborted");
});

for (const action of ["pause", "clear"] as const) test(`${action} updates the next provider context in a live tool run`, async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	f.faux.setResponses([
		() => { f.store.piGoals.command("#one", action); return call("get_goal", {}); },
		context => {
			assert.match(context.systemPrompt ?? "", action === "pause" ? /paused by the user\. Stop pursuing it/ : /No persistent goal is set\. Do not continue pursuing a cleared goal/);
			return fauxAssistantMessage("Acknowledged the control change");
		},
	]);
	await f.runNext();
	assert.equal(f.faux.state.callCount, 2);
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal(f.store.piGoals.read("#one")?.status ?? null, action === "pause" ? "paused" : null);
	assert.ok(f.events.some(event => event.type === "tool_end" && event.toolName === "get_goal" && event.isError));
});

test("durable goal mutation receipts are replay-safe and namespaced by session", async t => {
	const f = await fixture(t);
	const tools = createPiGoalTools(f.access("#one"), "first-session");
	assert.ok(tools.every(tool => tool.replay === "safe"));
	const invocation = {
		invocationId: "replayed-invocation", operationId: "synthetic-operation", turnId: "synthetic-turn",
		getMemo: async () => undefined, setMemo: async () => {},
	};
	const create = tools.find(tool => tool.name === "create_goal")!;
	f.access("#one").beginTurn("first-session:synthetic-turn");
	const first = await create.execute("create", { objective: "Verify original receipt" }, () => {}, undefined, invocation, ctx);
	const firstId = f.store.piGoals.read("#one")!.id;
	const repeated = await create.execute("create", { objective: "Verify original receipt" }, () => {}, undefined, invocation, ctx);
	assert.deepEqual(repeated, first);
	assert.equal(f.store.piGoals.read("#one")!.id, firstId);
	const update = tools.find(tool => tool.name === "update_goal")!;
	const updateInvocation = { ...invocation, invocationId: "completed-invocation", turnId: "completion-turn" };
	f.access("#one").beginTurn("first-session:completion-turn");
	const completed = await update.execute("update", { status: "complete" }, () => {}, undefined, updateInvocation, ctx);
	assert.deepEqual(await update.execute("update", { status: "complete" }, () => {}, undefined, updateInvocation, ctx), completed);
	const secondCreate = createPiGoalTools(f.access("#one"), "second-session").find(tool => tool.name === "create_goal")!;
	f.access("#one").beginTurn("second-session:synthetic-turn");
	await secondCreate.execute("create", { objective: "Verify a new session" }, () => {}, undefined, invocation, ctx);
	assert.notEqual(f.store.piGoals.read("#one")!.id, firstId);
	assert.equal(f.store.piGoals.read("#one")!.objective, "Verify a new session");
	assert.equal(f.faux.state.callCount, 0);
});

test("interrupted goal recovery never repeats an already-dispatched desktop action", async t => {
	const f = await fixture(t);
	let entered!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	let effects = 0;
	f.setDesktopCall(async () => { effects++; entered(); return new Promise(() => {}); });
	f.store.piGoals.command("#one", "Inspect a synthetic desktop effect once");
	f.faux.setResponses([call("run_js", { code: "synthetic effect; no real execution" })]);
	const running = f.runNext().catch(error => error);
	await began;
	const message = f.store.listInbox("running")[0];
	assert.ok(message);
	assert.equal(effects, 1);
	await f.session.suspend();
	await running;
	await f.restart();
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	await f.session.promptDurable(message.id, message.body);
	assert.equal(effects, 1);
	assert.equal(f.faux.state.callCount, 1);
	assert.equal((await f.session.lane.inspectExecution(ctx)).current, null);
	assert.equal(f.store.listInbox("pending").length, 0);
});

test("a failed provider response pauses goal continuation while ordinary chat remains available", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic non-retryable response" })]);
	await f.runNext();
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal((await f.session.lane.inspectExecution(ctx)).current, null);
	f.faux.setResponses([fauxAssistantMessage("Ordinary chat still works")]);
	assert.equal((await f.session.promptDurable("new-human-message", "Please respond without pursuing the paused goal")).text, "Ordinary chat still works");
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
});

test("HarnessFault pauses goal and leaves explicit recovery required instead of replaying", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Inspect the synthetic fixture");
	let restoreMutation: (() => void) | undefined;
	const stopHook = f.session.harness.hooks.on("before_request", () => {
		const fault = t.mock.method(f.session.store, "mutate", async () => { throw new Error("synthetic durable storage fault"); });
		restoreMutation = () => fault.mock.restore();
	});
	await assert.rejects(f.runNext(), error => error instanceof Error && error.name === "HarnessFault");
	stopHook();
	restoreMutation?.();
	const message = f.store.listInbox("running")[0];
	assert.ok(message);
	f.store.markRecoveryRequired(message.id);
	assert.equal(f.store.piGoals.read("#one")?.status, "paused");
	assert.equal(f.store.listInbox("recovery-required").length, 1);
	assert.equal(f.store.listInbox("pending").length, 0);
	assert.equal(f.faux.state.callCount, 0);
	await assert.rejects(f.session.promptDurable("ordinary-after-fault", "Inspect without replay"), error => error instanceof Error && error.name === "HarnessFault");
	await f.restart();
	assert.equal(f.store.listInbox("recovery-required").length, 1, "Reopen preserves the unresolved delivery barrier");
	assert.equal(f.faux.state.callCount, 0);
	await f.session.promptDurable(message.id, message.body);
	assert.equal((await f.session.lane.getResult(message.id, ctx))?.status, "aborted");
	assert.equal(f.faux.state.callCount, 0);
});

for (const name of ["update_goal", "create_goal"] as const) test(`a delayed ${name} cannot mutate a replacement goal created while its response was in flight`, async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Objective A: inspect the first fixture");
	const originalId = f.store.piGoals.read("#one")!.id;
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.faux.setResponses([
		async context => {
			assert.match(context.systemPrompt ?? "", /Objective A: inspect the first fixture/);
			entered();
			await gate;
			return call(name, name === "update_goal" ? { status: "complete" } : { objective: "Stale objective C from the old response" });
		},
		context => {
			assert.match(context.systemPrompt ?? "", /<untrusted_objective>\nObjective B: preserve the replacement/);
			return fauxAssistantMessage("The previous mutation was rejected; the replacement remains active");
		},
	]);
	const running = f.runNext();
	await began;
	f.store.piGoals.command("#one", "clear");
	f.store.piGoals.command("#one", "Objective B: preserve the replacement");
	const replacementId = f.store.piGoals.read("#one")!.id;
	assert.notEqual(replacementId, originalId);
	release();
	await running;
	const current = f.store.piGoals.read("#one")!;
	assert.equal(current.id, replacementId);
	assert.equal(current.objective, "Objective B: preserve the replacement");
	assert.equal(current.status, "active");
	assert.ok(f.events.some(event => event.type === "tool_end" && event.toolName === name && event.isError));
	const pending = f.store.listInbox("pending");
	assert.equal(pending.length, 1);
	assert.match(pending[0].body, /Objective B: preserve the replacement/);
	assert.equal(f.faux.state.callCount, 2);
});

test("a delayed create_goal from a no-goal turn cannot replace a newly selected human goal", async t => {
	const f = await fixture(t);
	f.store.enqueue({ id: "human-delayed-create", channel: "#one", sender: "human", body: "Prepare a synthetic goal" });
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.faux.setResponses([
		async () => { entered(); await gate; return call("create_goal", { objective: "Outdated model choice" }); },
		fauxAssistantMessage("The human-selected goal takes precedence"),
	]);
	const running = f.runNext();
	await began;
	f.store.piGoals.command("#one", "Human-selected objective");
	const selectedId = f.store.piGoals.read("#one")!.id;
	release();
	await running;
	assert.equal(f.store.piGoals.read("#one")!.id, selectedId);
	assert.equal(f.store.piGoals.read("#one")!.objective, "Human-selected objective");
	assert.ok(f.events.some(event => event.type === "tool_end" && event.toolName === "create_goal" && event.isError));
});

for (const change of ["replace", "resume"] as const) test(`a failed old goal response cannot pause the goal after the human chooses to ${change}`, async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Objective A before the delayed response");
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.faux.setResponses([async () => {
		entered();
		await gate;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic old response failed" });
	}]);
	const running = f.runNext();
	await began;
	if (change === "replace") {
		f.store.piGoals.command("#one", "clear");
		f.store.piGoals.command("#one", "Objective B selected by the human");
	} else {
		f.store.piGoals.command("#one", "pause");
		f.store.piGoals.command("#one", "resume");
	}
	const currentId = f.store.piGoals.read("#one")!.id;
	release();
	await running;
	assert.equal(f.store.piGoals.read("#one")!.id, currentId);
	assert.equal(f.store.piGoals.read("#one")!.status, "active");
	assert.equal(f.store.listInbox("pending").length, 1);
	assert.equal(f.faux.state.callCount, 1);
});

test("an awaited before_request goal replacement cannot lend its identity to the old prepared request", async t => {
	const f = await fixture(t);
	f.store.piGoals.command("#one", "Objective A from the prepared request");
	let replacementId: string | undefined;
	const stop = f.session.harness.hooks.on("before_request", async () => {
		if (replacementId) return;
		await Promise.resolve();
		f.store.piGoals.command("#one", "clear");
		f.store.piGoals.command("#one", "Objective B from the newer human choice");
		replacementId = f.store.piGoals.read("#one")!.id;
	});
	f.faux.setResponses([call("update_goal", { status: "complete" }), fauxAssistantMessage("The old request must not complete the replacement")]);
	await f.runNext();
	stop();
	assert.equal(f.store.piGoals.read("#one")?.id, replacementId);
	assert.equal(f.store.piGoals.read("#one")?.status, "active");
	assert.ok(f.events.some(event => event.type === "tool_end" && event.toolName === "update_goal" && event.isError));
	assert.equal(f.store.listInbox("pending").length, 1);
	assert.equal(f.faux.state.callCount, 2);
});


test("goal writer skill is present directly without granting host filesystem tools", async t => {
 const f = await fixture(t);
 const writer = readFileSync(new URL("../src/pi-goal-upstream/skills/pi-goal-writer/SKILL.md", import.meta.url), "utf8");
 f.faux.setResponses([({context}) => {
  assert.ok(context.systemPrompt?.includes(writer));
  assert.ok(!context.tools?.some(tool => ["read", "write", "edit", "bash"].includes(tool.name)));
  return fauxAssistantMessage("writer instructions available");
 }]);
 await f.session.promptDurable("writer-context", "Help write a goal");
});
