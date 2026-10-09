import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DurableChannelSession,
	guardTool,
} from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
} from "../.runtime/pi/packages/ai/src/index.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../.runtime/pi/packages/coding-agent/src/core/session-manager.ts";
import {
	SqliteSessionRepo,
	createNodeSqliteFactory,
} from "../.runtime/pi/packages/session-backends/sqlite-node/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";

test("committed operation survives reopen without another provider request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-durable-"));
	let s: DurableChannelSession | undefined;
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = Object.create(models);
	runtime.getAvailable = async () => [faux.getModel()];
	const deps: any = {
		cwd: dir,
		agentDir: dir,
		sessionDir: join(dir, "sessions"),
		modelRuntime: runtime,
		delegate: { send: async () => {} },
		log: () => {},
		desktop: {
			tools: async () => [
				{ name: "run_js", inputSchema: { type: "object", properties: {} } },
			],
		},
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
	try {
        deps.desktop.tools = async () => {throw new Error("offline: discovery must not be called");};

		faux.setResponses([fauxAssistantMessage("durable answer")]);
		s = await DurableChannelSession.open("#test", deps);
		const file = s.sessionFile;
		const id = s.sessionId;
		assert.equal(
			(await s.promptDurable("stable-op", "hello")).text,
			"durable answer",
		);
		await s.close();
		s = undefined;
		s = await DurableChannelSession.open("#test", deps, { sessionFile: file });
		assert.equal(s.sessionId, id);
		assert.equal(
			(await s.promptDurable("stable-op", "hello")).text,
			"durable answer",
		);
		assert.equal(faux.state.callCount, 1);
		// Durable acceptance precedes execution: simulate restart in that exact gap.
		const accepted = await s.lane.accept(
			{ kind: "prompt", operationId: "pending-op", prompt: "second" },
			ctx,
		);
		assert.equal(accepted.ok, true);
		await s.close();
		s = undefined;
		faux.setResponses([fauxAssistantMessage("recovered answer")]);
		s = await DurableChannelSession.open("#test", deps, { sessionFile: file });
		assert.equal(
			(await s.promptDurable("pending-op", "second")).text,
			"recovered answer",
		);
		assert.equal(faux.state.callCount, 2);
		const aborted = await s.lane.accept(
			{ kind: "prompt", operationId: "aborted-op", prompt: "cancel" },
			ctx,
		);
		assert.equal(aborted.ok, true);
		await s.abort();
		assert.match(
			(await s.promptDurable("aborted-op", "cancel")).text,
			/Operation failed/,
		);
		faux.setResponses([fauxAssistantMessage("after cancellation")]);
		assert.equal(
			(await s.promptDurable("after-abort", "next")).text,
			"after cancellation",
		);
        let controls = 0;
        deps.delegate.desktopControl = async (room: string, action: string) => {assert.equal(room,"#test");assert.equal(action,"status");controls++;return {state:"starting"};};
        faux.setResponses([
            fauxAssistantMessage([{type:"toolCall",id:"status-offline",name:"desktop_control",arguments:{action:"status"}}],{stopReason:"toolUse"}),
            fauxAssistantMessage("Recovery status obtained")
        ]);
        assert.equal((await s.promptDurable("offline-status","check status")).text,"Recovery status obtained");
        assert.equal(controls,1);
        // Simulate a conversation created before desktop_control existed. Its
        // durable allowlist must migrate as well as the runtime registry.
        const oldTools = (await s.lane.getActiveTools(ctx)).filter(name => name !== "desktop_control");
        await s.lane.setActiveTools(oldTools, ctx);
        const priorEntries = await s.lane.findEntries({type:"message"}, ctx);
        const priorModel = s.modelLabel();
        await s.close();
        s = await DurableChannelSession.open("#test", deps, {sessionFile:file});
        assert.deepEqual(await s.lane.getActiveTools(ctx), [...oldTools,"desktop_control"]);
        assert.equal(s.modelLabel(), priorModel);
        assert.deepEqual(await s.lane.findEntries({type:"message"}, ctx),priorEntries);
        faux.setResponses([
            (context) => {
                assert.ok(context.tools?.some(tool => tool.name === "desktop_control"), "reopened model receives recovery tool schema");
                return fauxAssistantMessage([{type:"toolCall",id:"status-migrated",name:"desktop_control",arguments:{action:"status"}}],{stopReason:"toolUse"});
            },
            fauxAssistantMessage("Migrated recovery works")
        ]);
        assert.equal((await s.promptDurable("migrated-status","check status")).text,"Migrated recovery works");
        assert.equal(controls,2);

		// Close the process-local harness while the real SQLite operation is effect_pending.
		let dispatched!: () => void;
		const started = new Promise<void>((resolve) => {
			dispatched = resolve;
		});
		let externalActions = 0;
		deps.desktop.call = async () => {
			externalActions++;
			dispatched();
			return new Promise(() => {});
		};
		faux.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "run-js-call",
						name: "run_js",
						arguments: {code:"console.log(1)"},
					},
				],
				{ stopReason: "toolUse" },
			),
		]);
		const interrupted = s
			.promptDurable("interrupted-tool", "perform action")
			.catch((error) => error);
		await started;
		const watch = await s.lane.watch(ctx);
		assert.equal(watch.snapshot.operation?.id, "interrupted-tool");
		assert.equal(watch.snapshot.operation?.runningTools.length, 1);
		await s.suspend();
		await s.close();
		s = undefined;
		await interrupted;
		faux.setResponses([
			fauxAssistantMessage(
				"The external outcome is unknown; inspect before retrying.",
			),
		]);
		s = await DurableChannelSession.open("#test", deps, { sessionFile: file });
		assert.equal(
			(await s.lane.inspectExecution(ctx)).current?.id,
			"interrupted-tool",
		);
		const recovered = await s.promptDurable(
			"interrupted-tool",
			"perform action",
		);
		assert.match(recovered.text, /outcome is unknown/);
		assert.equal(externalActions, 1);
		const entries = await s.lane.findEntries({ type: "message" }, ctx);
		const toolResult = entries.find(
			(e) =>
				e.type === "message" &&
				e.message.role === "toolResult" &&
				e.message.toolCallId === "run-js-call",
		);
		assert.ok(
			toolResult &&
				toolResult.type === "message" &&
				toolResult.message.role === "toolResult",
		);
		assert.equal(toolResult.message.isError, true);
		assert.match(
			JSON.stringify(toolResult.message.content),
			/external outcome is unknown/,
		);
		// Reconstruct a crash halfway through importing a classic session.
		const classic = SessionManager.create(dir, join(dir, "sessions"));
		classic.appendMessage({
			role: "user",
			content: "old question",
			timestamp: 1,
		});
		classic.appendMessage(fauxAssistantMessage("old answer"));
		const classicFile = classic.getSessionFile()!;
		const repo = new SqliteSessionRepo({
			directory: join(dir, "sessions", "durable"),
			databaseFactory: createNodeSqliteFactory(),
		});
		const db = await repo.create({ id: classic.getSessionId() }, ctx);
		const branch = await db.createBranch("main", null, ctx);
		await branch.appendMessage(classic.buildSessionContext().messages[0], ctx);
		await db.close(ctx);
		await repo.close(ctx);
		const migrated = await DurableChannelSession.open("#old", deps, {
			sessionFile: classicFile,
		});
		assert.equal(
			(await migrated.lane.findEntries({ type: "message" }, ctx)).length,
			2,
		);
		await migrated.close();
	} finally {
		await s?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("dispatch memo prevents replay after process interruption", async () => {
	const memos = new Map();
	let calls = 0;
	const tool = guardTool({
		name: "run_js",
		label: "run_js",
		description: "test",
		parameters: {} as any,
		execute: async () => {
			calls++;
			throw new Error("crash after dispatch");
		},
	});
	const invocation: any = {
		getMemo: async (k: string) => memos.get(k),
		setMemo: async (k: string, v: unknown) => memos.set(k, v),
	};
	await assert.rejects(
		tool.execute("id", {}, () => {}, undefined, invocation, ctx),
	);
	const result = await tool.execute(
		"id",
		{},
		() => {},
		undefined,
		invocation,
		ctx,
	);
	assert.equal(calls, 1);
	assert.match((result.content[0] as any).text, /outcome is unknown/);
});
