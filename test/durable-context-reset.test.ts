import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import type { ChannelSessionDeps } from "../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts";
import type { GoalState, PiGoalDelegate } from "../.runtime/pi/packages/coding-agent/src/cuse/pi-goal.ts";
import { PublicError } from "../.runtime/pi/packages/coding-agent/src/cuse/public-error.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "cuse-context-reset-"));
	const faux = fauxProvider({ models: [{ id: "initial" }, { id: "selected", reasoning: true }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = Object.create(models);
	runtime.getAvailable = async () => faux.models;
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
		delegate: { piGoal: () => goal },
		communication: {
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
		throw new Error("Network forbidden in context-reset tests");
	});
	let session: DurableChannelSession | undefined;
	t.after(async () => {
		await session?.close();
		rmSync(dir, { recursive: true, force: true });
		assert.equal(unexpectedFetch.mock.callCount(), 0);
	});
	session = await DurableChannelSession.open("#reset", deps);
	return {
		faux,
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

function refused(code: "contextClearBusy" | "contextClearGoal" | "contextClearing") {
	return (error: unknown) => error instanceof PublicError && error.publicCode === code;
}

test("context reset empties the durable root without summarizing, retains archive and settings, and survives reopen", async t => {
	const f = await fixture(t);
	const oldPrompt = "PRIVATE_OLD_PROMPT_5912";
	const oldReply = "PRIVATE_OLD_REPLY_7246";
	f.faux.setResponses([fauxAssistantMessage(oldReply)]);
	assert.equal((await f.session.promptDurable("before-reset", oldPrompt)).text, oldReply);
	await f.session.lane.appendCustomEntry("archived-note", { text: "ARCHIVED_CUSTOM_3287" }, ctx);
	await f.session.setModel(f.faux.getModel("selected")!);
	await f.session.setThinkingLevel("high");
	await f.session.harness.setName("Retained session name", ctx);
	const identity = { id: f.session.sessionId, file: f.session.sessionFile, channel: f.session.channel };
	const archive = await f.session.store.findEntries({ order: "asc" }, ctx);
	const oldResult = await f.session.lane.getResult("before-reset", ctx);
	const configuration = (await snapshot(f.session)).configuration;
	assert.equal(archive.filter(entry => entry.type === "message").length, 2);
	assert.notEqual(await f.session.lane.getTipId(ctx), null);

	await f.session.clearContext();
	assert.equal(f.faux.state.callCount, 1, "Reset must not request a summary or an assistant continuation");
	assert.equal(await f.session.lane.getTipId(ctx), null);
	assert.deepEqual(await f.session.lane.findEntries(undefined, ctx), []);
	assert.deepEqual(await f.session.store.findEntries({ order: "asc" }, ctx), archive, "Reset retains every original entry and adds no summary");
	assert.deepEqual((await snapshot(f.session)).configuration, configuration);
	assert.deepEqual(await f.session.lane.getResult("before-reset", ctx), oldResult);
	assert.equal((await f.session.completedReply("before-reset")).text, oldReply);

	const cleared = await snapshot(f.session);
	await f.session.clearContext();
	assert.deepEqual(await snapshot(f.session), cleared, "Repeated reset creates no new operation or entry");
	assert.equal(f.faux.state.callCount, 1);

	await f.reopen();
	assert.deepEqual({ id: f.session.sessionId, file: f.session.sessionFile, channel: f.session.channel }, identity);
	assert.equal(await f.session.lane.getTipId(ctx), null);
	assert.deepEqual(await f.session.lane.findEntries(undefined, ctx), []);
	assert.equal(f.session.modelLabel(), "faux/selected");
	assert.equal(f.session.thinkingLevel(), "high");
	assert.equal(await f.session.harness.getName(ctx), "Retained session name");
	assert.deepEqual((await snapshot(f.session)).configuration, configuration);
	assert.deepEqual(await f.session.store.findEntries({ order: "asc" }, ctx), archive);
	assert.deepEqual(await f.session.lane.getResult("before-reset", ctx), oldResult);
	assert.equal(f.faux.state.callCount, 1, "Reopen does not replay archived conversation");
	assert.equal((await f.session.promptDurable("before-reset", oldPrompt)).text, oldReply);
	assert.equal(await f.session.lane.getTipId(ctx), null, "Replaying a completed receipt must not restore the old branch");
	assert.equal(f.faux.state.callCount, 1);

	f.faux.setResponses([(context, options, _state, model) => {
		const request = JSON.stringify(context);
		assert.doesNotMatch(request, /PRIVATE_OLD_PROMPT_5912|PRIVATE_OLD_REPLY_7246|ARCHIVED_CUSTOM_3287/);
		assert.equal(context.messages.length, 1);
		assert.equal(context.messages[0].role, "user");
		assert.match(request, /FRESH_PROMPT_8361/);
		assert.equal(model.id, "selected");
		assert.equal(options?.reasoning, "high");
		return fauxAssistantMessage("Fresh answer");
	}]);
	assert.equal((await f.session.promptDurable("after-reset", "FRESH_PROMPT_8361")).text, "Fresh answer");
	assert.equal(f.faux.state.callCount, 2);
	const active = await f.session.lane.findEntries({ type: "message" }, ctx);
	assert.equal(active.length, 2);
	assert.doesNotMatch(JSON.stringify(active), /PRIVATE_OLD_PROMPT_5912|PRIVATE_OLD_REPLY_7246/);
	for (const entry of archive) assert.deepEqual(await f.session.store.getEntry(entry.id, ctx), entry);
});

test("context reset on an already empty root is a provider-free no-op", async t => {
	const f = await fixture(t);
	const before = await snapshot(f.session);
	await f.session.clearContext();
	await f.session.clearContext();
	assert.deepEqual(await snapshot(f.session), before);
	assert.equal(f.faux.state.callCount, 0);
});

test("context reset refuses a live adapter turn and leaves it running", async t => {
	const f = await fixture(t);
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let signal: AbortSignal | undefined;
	f.faux.setResponses([async (_context, options) => {
		signal = options?.signal;
		entered();
		await gate;
		return fauxAssistantMessage("Turn completed normally");
	}]);
	const running = f.session.promptDurable("live-turn", "Do not discard this turn");
	try {
		await began;
		assert.equal(f.session.busy, true);
		const before = await snapshot(f.session);
		await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
		assert.deepEqual(await snapshot(f.session), before);
		assert.equal(signal?.aborted, false);
		assert.equal(f.faux.state.callCount, 1);
	} finally {
		release();
		assert.equal((await running).text, "Turn completed normally");
	}
	assert.equal(f.session.busy, false);
	await f.session.clearContext();
	assert.equal(await f.session.lane.getTipId(ctx), null);
});

test("context reset refuses an accepted operation even when the adapter is idle", async t => {
	const f = await fixture(t);
	const accepted = await f.session.lane.accept({ kind: "prompt", operationId: "accepted-only", prompt: "Persisted pending prompt" }, ctx);
	assert.equal(accepted.ok, true);
	assert.equal(f.session.busy, false);
	const before = await snapshot(f.session);
	await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
	assert.deepEqual(await snapshot(f.session), before);
	assert.equal((await f.session.lane.inspectExecution(ctx)).current?.id, "accepted-only");
	assert.equal(f.faux.state.callCount, 0);
	await f.reopen();
	assert.equal(f.session.busy, false);
	await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
	assert.equal((await f.session.lane.inspectExecution(ctx)).current?.id, "accepted-only");
	assert.equal(f.faux.state.callCount, 0);
});

test("context reset refuses a deferred suspended operation without polling or cancelling it", async t => {
	const f = await fixture(t);
	f.faux.setResponses([fauxAssistantMessage("Deferred answer")]);
	await f.session.harness.setStreamOptions({ deferred: true }, ctx);
	const suspended = await f.session.lane.prompt("Await external answer", undefined, ctx);
	assert.equal(suspended.ok, true);
	if (!suspended.ok) throw suspended.error;
	assert.equal(suspended.value.status, "suspended");
	assert.equal(f.session.busy, false);
	const before = await snapshot(f.session);
	assert.ok(before.operation?.deferred);
	await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
	assert.deepEqual(await snapshot(f.session), before);
	assert.equal(f.faux.state.callCount, 1);
	assert.equal(f.faux.state.deferredFetchCount, 0);
	assert.deepEqual(f.faux.state.cancelledDeferred, []);
	const resumed = await f.session.lane.resume(ctx);
	assert.equal(resumed.ok, true);
	if (!resumed.ok) throw resumed.error;
	assert.equal(resumed.value.status, "completed");
	assert.equal(f.faux.state.deferredFetchCount, 1);
});

for (const kind of ["steer", "followUp", "nextRun"] as const) {
	test(`context reset refuses queued ${kind} input even at an empty root`, async t => {
		const f = await fixture(t);
		const queued = await f.session.lane[kind]("Keep this pending input", undefined, ctx);
		assert.equal(queued.ok, true);
		assert.equal(f.session.busy, false);
		const before = await snapshot(f.session);
		assert.equal(before.tipId, null);
		assert.equal(before.operation, null);
		assert.equal(before.queues.length, 1);
		await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
		assert.deepEqual(await snapshot(f.session), before, "Refusal must not drop or drain queued work");
		assert.equal(f.faux.state.callCount, 0);
		await f.reopen();
		await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
		assert.deepEqual((await snapshot(f.session)).queues, before.queues);
		assert.equal(f.faux.state.callCount, 0);
	});
}

for (const status of ["active", "paused", "budget_limited", "complete"] as const) {
	test(`context reset refuses an existing ${status} goal`, async t => {
		const f = await fixture(t);
		const goal: GoalState = {
			version: 1, id: `goal-${status}`, objective: "Retain the goal", status,
			tokenBudget: 1000, tokensUsed: 50, timeUsedSeconds: 10, createdAt: 1, updatedAt: 2,
		};
		f.setGoal(goal);
		const before = await snapshot(f.session);
		await assert.rejects(f.session.clearContext(), refused("contextClearGoal"));
		assert.deepEqual(await snapshot(f.session), before);
		assert.deepEqual(f.goal, goal);
		assert.equal(f.faux.state.callCount, 0);
		f.setGoal(null);
		await f.session.clearContext();
		assert.equal(f.session.busy, false);
	});
}

test("context reset excludes concurrent prompts and repeated resets until navigation settles", async t => {
	const f = await fixture(t);
	f.faux.setResponses([fauxAssistantMessage("Archived answer")]);
	await f.session.promptDurable("old-turn", "Archived prompt");
	const accept = f.session.lane.accept.bind(f.session.lane);
	let entered!: () => void;
	let release!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.mock.method(f.session.lane, "accept", async (request, context) => {
		if (request.kind === "navigation") {
			assert.equal(request.targetId, null);
			assert.equal(request.options?.summarize, false);
			entered();
			await gate;
		}
		return accept(request, context);
	});
	const clearing = f.session.clearContext();
	try {
		await began;
		assert.equal(f.session.busy, true);
		await assert.rejects(f.session.promptDurable("racing-prompt", "Do not accept during reset"), refused("contextClearing"));
		await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
		assert.equal(f.faux.state.callCount, 1);
	} finally {
		release();
		await clearing;
	}
	assert.equal(f.session.busy, false);
	assert.equal(await f.session.lane.getTipId(ctx), null);
	assert.equal(await f.session.lane.getResult("racing-prompt", ctx), undefined);
	assert.equal(f.faux.state.callCount, 1);
});

test("context reset preserves a competing lane operation admitted after the idle check", async t => {
	const f = await fixture(t);
	f.faux.setResponses([fauxAssistantMessage("Retain this answer")]);
	await f.session.promptDurable("original-turn", "Retain this prompt");
	const archive = await f.session.store.findEntries({ order: "asc" }, ctx);
	let admittedState = await snapshot(f.session);
	const accept = f.session.lane.accept.bind(f.session.lane);
	const interception = t.mock.method(f.session.lane, "accept", async (request, context) => {
		if (request.kind === "navigation") {
			const competing = await accept({ kind: "prompt", operationId: "competing-turn", prompt: "Newly accepted work" }, context);
			assert.equal(competing.ok, true);
			admittedState = await snapshot(f.session);
		}
		return accept(request, context);
	});
	await assert.rejects(f.session.clearContext(), refused("contextClearBusy"));
	interception.mock.restore();
	assert.equal(f.session.busy, false, "A rejected navigation releases the adapter reset guard");
	assert.equal((await f.session.lane.inspectExecution(ctx)).current?.id, "competing-turn");
	assert.deepEqual(await snapshot(f.session), admittedState);
	for (const entry of archive) assert.deepEqual(await f.session.store.getEntry(entry.id, ctx), entry);
	assert.equal(f.faux.state.callCount, 1);
	await f.session.abort();
	await f.session.clearContext();
	assert.equal(await f.session.lane.getTipId(ctx), null);
	assert.equal(f.faux.state.callCount, 1);
});
