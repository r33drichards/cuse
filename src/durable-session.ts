import { createDurableSkillTools, SKILL_GUIDANCE, SKILL_TOOL_NAMES } from "./skill-tools.ts";
import { durableDiagnostic } from "./durable-diagnostic.ts";
import { DESKTOP_TOOL_MANIFEST } from "./desktop-tool-manifest.ts";
/** Durable IRC adapter. The host must hold exclusive ownership of sessionDir. */
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import {
	AgentHarness,
	BACKGROUND_CONTEXT as ctx,
	type AgentLane,
	type AgentHarnessTool,
	type Session,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createNodeSqliteFactory,
	SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { Type, type TSchema } from "typebox";
import { SessionManager } from "../core/session-manager.ts";
import { convertToLlm } from "../core/messages.ts";
import type {
	ChannelSessionDeps,
	OpenChannelSession,
	RelayEvents,
} from "./channel-session.ts";
import { requireExplicitModel } from "./model-selection.ts";
import {
	AGENT_ASK_DESCRIPTION,
	createDurableAgentTools,
	modelContent,
} from "./tools.ts";
import { describeToolCall, describeToolResult, toIrcLines } from "./format.ts";
import { PublicError, publicError } from "./public-error.ts";
import { createPiGoalTools } from "./pi-goal-tools.ts";
import type { GoalTurnSnapshot, PiGoalDelegate } from "./pi-goal.ts";
import { budgetLimitPrompt, continuationPrompt } from "./pi-goal-prompts.ts";

const ambiguous =
	"The previous process stopped after dispatching this tool. Its outcome is unknown. Do not repeat the action; inspect the desktop or ask the user before retrying.";
const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join("")
			: "";

/** A durable dispatch marker deliberately prefers a missed action over duplicate side effects. */
export function guardTool(
	tool: AgentHarnessTool<undefined>,
): AgentHarnessTool<undefined> {
	return {
		...tool,
		replay: "never",
		async execute(id, params, update, context, invocation, callContext) {
			if (await invocation.getMemo("cuse.dispatched"))
				return {
					content: [{ type: "text", text: ambiguous }],
					details: { ambiguous: true },
				};
			await invocation.setMemo("cuse.dispatched", true);
			return tool.execute(id, params, update, context, invocation, callContext);
		},
	};
}

export class DurableChannelSession {
	readonly #relays = new Set<RelayEvents>();
	#depth = 0;
	readonly channel: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly harness: AgentHarness<undefined>;
	readonly lane: AgentLane;
	readonly store: Session;
	readonly repo: SqliteSessionRepo;
	private model: Model<Api>;
	private thinking: ThinkingLevel;
 private readonly log:(line:string)=>void;
	private readonly goal: PiGoalDelegate | undefined;
	private constructor(
		channel: string,
		sessionId: string,
		sessionFile: string,
		harness: AgentHarness<undefined>,
		lane: AgentLane,
		store: Session,
		repo: SqliteSessionRepo,
		model: Model<Api>,
		thinking: ThinkingLevel,
  log:(line:string)=>void,
		goal: PiGoalDelegate | undefined,
	) {
		this.channel = channel;
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.harness = harness;
		this.lane = lane;
		this.store = store;
		this.repo = repo;
		this.model = model;
		this.thinking = thinking;
  this.log=log;
		this.goal = goal;
		if (goal) {
			const requestGoals = new Map<string, GoalTurnSnapshot>();
			// before_request precedes turn_start. Capture before later async hooks
			// can replace the goal underneath this already-prepared request.
			harness.hooks.on("before_request", (event) => {
				if (event.step !== "assistant") return;
				const current = goal.read();
				requestGoals.set(event.runId, { goalId: current?.id ?? null, active: current?.status === "active" });
				return undefined;
			}, { id: "cuse.pi-goal.request" });
			harness.hooks.on("transform_context", (event) => {
				const current = goal.read();
				const goalContext = !current ? "No persistent goal is set. Do not continue pursuing a cleared goal."
					: current.status === "active" ? continuationPrompt(current)
					: current.status === "budget_limited" ? budgetLimitPrompt(current)
					: current.status === "paused" ? `The active goal has been paused by the user. Stop pursuing it for now and wait for further instructions.\n\nObjective: ${current.objective}`
					: `The goal has been marked complete.\n\nObjective: ${current.objective}`;
				return { systemPrompt: `${event.systemPrompt}\n\n${goalContext}` };
			}, { id: "cuse.pi-goal.context" });
			harness.events.on("turn_start", (event) => { goal.beginTurn(`${sessionId}:${event.turnId}`, event.runId, requestGoals.get(event.runId)); });
			harness.events.on("turn_end", (event) => { goal.endTurn(`${sessionId}:${event.turnId}`, event.message.usage); });
			harness.events.on("run_end", (event) => {
				requestGoals.delete(event.runId);
				if (event.status !== "completed") goal.fault(event.runId);
			});
			harness.events.on("handler_error", () => {
				goal.fault();
				this.log(`IRC: ${channel}: goal accounting interrupted; goal paused`);
			});
		}
		harness.events.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const lines = toIrcLines(
				event.message.stopReason === "error" ||
					event.message.stopReason === "aborted"
					? publicError(undefined)
					: textOf(event.message.content),
			);
			if (lines.length)
				for (const relay of this.#relays) relay.text(lines, event.entryId);
		});
		harness.events.on("tool_start", (event) => {
			for (const relay of this.#relays)
				relay.tool(describeToolCall(event.toolName, event.args));
		});
		harness.events.on("tool_end", (event) => {
			for (const relay of this.#relays)
				relay.tool(
					describeToolResult(
						event.toolName,
						event.isError
							? publicError(undefined)
							: textOf(event.result.content),
						event.isError,
					),
				);
		});
	}
	static async open(
		channel: string,
		deps: ChannelSessionDeps,
		options: OpenChannelSession = {},
	): Promise<DurableChannelSession> {
		const { resourceLoader, settingsManager } = await deps.createResources(
			deps.cwd,
		);
		const extensions = resourceLoader.getExtensions();
		if (extensions.extensions.length || extensions.errors.length)
			throw new PublicError("durableExtensions");
		if (options.sessionFile) {
			const header = readFileSync(options.sessionFile, "utf8").split("\n")[0];
			if (!header || JSON.parse(header).type !== "session")
				throw new Error("Invalid remembered classic session");
		}
        const remote = DESKTOP_TOOL_MANIFEST;
		const legacy = options.sessionFile
			? SessionManager.open(options.sessionFile, deps.sessionDir, deps.cwd)
			: SessionManager.create(deps.cwd, deps.sessionDir);
		if (options.sessionFile && !existsSync(options.sessionFile))
			throw new Error("Remembered classic session is missing");
		const sessionId = legacy.getSessionId();
		const sessionFile = legacy.getSessionFile();
		if (!sessionFile) throw new Error("Missing session identity");
		if (!options.sessionFile) {
			mkdirSync(deps.sessionDir, { recursive: true });
			writeFileSync(sessionFile, JSON.stringify(legacy.getHeader()) + "\n", {
				flag: "wx",
				mode: 0o600,
			});
		}
		const previous = legacy.buildSessionContext();
		const provider =
			previous.model?.provider ?? settingsManager.getDefaultProvider();
		const modelId =
			previous.model?.modelId ?? settingsManager.getDefaultModel();
		// On reopen the durable lane owns model selection. A bootstrap model is never used to drive it.
		const reopening = existsSync(sessionFile + ".durable.json");
		const model = reopening
			? ((provider && modelId
					? deps.modelRuntime.getModel(provider, modelId)
					: undefined) ?? (await deps.modelRuntime.getAvailable())[0])
			: await requireExplicitModel(deps.modelRuntime, provider, modelId);
		if (!model)
			throw new Error("Durable IRC requires an explicitly configured model");
		const thinking = (previous.thinkingLevel ??
			settingsManager.getDefaultThinkingLevel() ??
			"off") as ThinkingLevel;
		const repo = new SqliteSessionRepo({
			directory: join(deps.sessionDir, "durable"),
			databaseFactory: createNodeSqliteFactory(),
		});
		let store: Session | undefined;
		let harness: AgentHarness<undefined> | undefined;
		try {
			const metadata = (await repo.list(undefined, ctx)).find(
				(s) => s.id === sessionId,
			);
			const marker = sessionFile + ".durable.json";
			if (existsSync(marker) && !metadata)
				throw new Error(
					"Durable session database is missing; refusing to replay legacy history",
				);
			store = metadata
				? await repo.open(metadata, ctx)
				: await repo.create({ id: sessionId }, ctx);
			if (!existsSync(marker)) {
				// Each append is committed atomically. A restart resumes an exact imported prefix.
				// The host ownership lock excludes classic writers until migration completes.
				const branch =
					(await store.branch("main", ctx)) ??
					(await store.createBranch("main", null, ctx));
				const imported = await branch.findEntries(
					{ order: "oldestFirst" },
					ctx,
				);
				if (
					imported.length > previous.messages.length ||
					imported.some(
						(entry, index) =>
							entry.type !== "message" ||
							!isDeepStrictEqual(entry.message, previous.messages[index]),
					)
				) {
					throw new Error(
						"Durable migration history differs from the classic source; refusing to overwrite either history",
					);
				}
				for (const message of previous.messages.slice(imported.length))
					await branch.appendMessage(message, ctx);
				const temporary = marker + ".tmp";
				writeFileSync(
					temporary,
					JSON.stringify({ version: 1, sessionId, legacy: sessionFile }),
					{ mode: 0o600 },
				);
				renameSync(temporary, marker);
			} else if (!metadata)
				throw new Error(
					"Durable session database is missing; refusing to replay legacy history",
				);
			const tools: AgentHarnessTool<undefined>[] = remote
				.filter((t) =>
					[
						"run_js",
						"get_artifact",
						"list_artifacts",
						"get_artifact_upload_url",
					].includes(t.name),
				)
				.map((t) =>
					guardTool({
						name: t.name,
						label: t.name,
						description: t.description ?? t.name,
						parameters: t.inputSchema as TSchema,
						async execute(
							_id,
							params,
							_update,
							_context,
							_invocation,
							context,
						) {
							try {
								const result = await deps.desktop.call(
									t.name,
									params,
									context.abortSignal,
								);
								if (result.isError) throw new Error();
								return { content: modelContent(result), details: {} };
							} catch {
								throw new Error(publicError(undefined));
							}
						},
					}),
				);
			if (!tools.some((t) => t.name === "run_js"))
				throw new Error("Desktop does not expose run_js");
			tools.push(
				guardTool({
					name: "irc_send",
					label: "irc_send",
					description:
						"Send to another joined channel only when explicitly requested by the user.",
					parameters: Type.Object({
						channel: Type.String(),
						text: Type.String(),
					}),
					async execute(_id, params) {
						await deps.delegate.send({
							room: channel,
							channel: String((params as { channel: string }).channel),
							text: String((params as { text: string }).text),
						});
						return { content: [{ type: "text", text: "Sent" }], details: {} };
					},
				}),
			);
			tools.push(...createDurableAgentTools(deps.delegate, channel, sessionId), ...createDurableSkillTools(deps.desktop));
			const goal = deps.delegate.piGoal?.(channel);
			if (goal) tools.push(...createPiGoalTools(goal, sessionId));
			({ harness } = await AgentHarness.create<undefined>(
				{
					session: store,
					models: deps.modelRuntime,
					model,
					thinkingLevel: thinking,
					tools,
					toolExecution: "sequential",
					toProviderMessages: convertToLlm,
					systemPrompt: [
						resourceLoader.getSystemPrompt() ??
							"You are cuse, an IRC computer-use assistant. Use only this channel's isolated desktop tools. Never repeat an action whose outcome is unknown; inspect its result first.",
						"If a tool reports an unknown outcome after interruption, do not repeat its action. Inspect the desktop or ask the user before retrying. Remote tools belong to this channel isolated desktop. desktop_control runs on the host and remains available if the desktop fails. Use status to diagnose, then start/stop/sleep only as needed for recovery; stop preserves disk but loses unsaved process state. Never replay an uncertain remote action after recovery.",
						AGENT_ASK_DESCRIPTION,
                        SKILL_GUIDANCE,
                        // cuse has no host read tool: make the bundled writer skill usable
                        // directly, while its file operations remain on the channel desktop.
                        ...(goal ? [readFileSync(new URL("./pi-goal-upstream/skills/pi-goal-writer/SKILL.md", import.meta.url), "utf8")] : []),
						...resourceLoader.getAppendSystemPrompt(),
						...resourceLoader
							.getAgentsFiles()
							.agentsFiles.map((f) => f.content),
					].join("\n\n"),
					resources: {
						skills: resourceLoader
							.getSkills()
							.skills.map((s) => ({
								...s,
								content: readFileSync(s.filePath, "utf8"),
							})),
						promptTemplates: resourceLoader.getPrompts().prompts,
					},
				},
				ctx,
			));
            const lane = await harness.lane("main", ctx);
            const execution = await lane.inspectExecution(ctx);
            if (execution.current?.id.startsWith("goal/")) throw new PublicError("legacyGoalsMigration");
            // Registry changes must not silently rewrite an old goal configuration.
            const activeTools = await lane.getActiveTools(ctx);
            if (activeTools.some(name => name === "goal_status" || name === "goal_update")) throw new PublicError("legacyGoalsMigration");
            // Append the recovery capability without replacing model/thinking/history.
            const desiredTools = [...new Set([...activeTools, "desktop_control", ...SKILL_TOOL_NAMES])];
            if (!isDeepStrictEqual(activeTools, desiredTools)) await lane.setActiveTools(desiredTools, ctx);
			// Harness tool snapshots are durable. Register the three native goal
			// tools explicitly on reopen, and remove them when goal mode is disabled.
			const goalNames = ["create_goal", "get_goal", "update_goal"];
			const currentTools = await lane.getActiveTools(ctx);
			const nextTools = goal ? [...new Set([...currentTools, ...goalNames])] : currentTools.filter(name => !goalNames.includes(name));
			if (!isDeepStrictEqual(currentTools, nextTools)) await lane.setActiveTools(nextTools, ctx);
			const restored = await lane.getModel(ctx);
			if (!restored) throw new Error("Persisted durable model is unavailable");
			await requireExplicitModel(
				deps.modelRuntime,
				restored.provider,
				restored.id,
			);
			return new DurableChannelSession(
				channel,
				sessionId,
				sessionFile,
				harness,
				lane,
				store,
				repo,
				restored,
				await lane.getThinkingLevel(ctx),
    deps.log,
				goal,
			);
		} catch (error) {
			await harness?.close(ctx);
			await store?.close(ctx);
			await repo.close(ctx);
			throw error;
		}
	}
	watch(relay: RelayEvents): () => void {
		this.#relays.add(relay);
		return () => this.#relays.delete(relay);
	}
	get busy(): boolean {
		return this.#depth > 0;
	}

	/** Restart recovery can settle a revoked goal operation but cannot run its
	 * provider or tools again. A live pause does not interrupt an admitted turn.
	 */
	private async revokeStoppedGoal(operationId: string): Promise<void> {
		if (!operationId.startsWith("pi-goal/") || this.goal?.canRun(operationId)) return;
		await this.abortDurable(operationId);
	}
	async promptDurable(
		operationId: string,
		body: string,
	): Promise<{ text: string; steered: boolean }> {
        if (operationId.startsWith("goal/")) throw new PublicError("legacyGoalsMigration");
		this.#depth++;
		try {
			this.goal?.admit(operationId);
			let result = await this.lane.getResult(operationId, ctx);
			if (!result) {
				const state = await this.lane.inspectExecution(ctx);
                if (state.current?.id.startsWith("goal/")) throw new PublicError("legacyGoalsMigration");
				if (operationId.startsWith("pi-goal/") && !this.goal?.canRun(operationId) && state.current?.id !== operationId) return { text: "", steered: false };
				if (state.current && state.current.id !== operationId) {
					this.goal?.admit(state.current.id);
					await this.revokeStoppedGoal(state.current.id);
                    const recovered = await this.lane.drive(
						{
							operationId: state.current.id,
							waitForRetry: true,
							pollDeferred: true,
						},
						ctx,
					);
					if (!recovered.ok) throw recovered.error;
					if (recovered.value.kind !== "settled")
						throw new Error(
							"Previous durable operation is waiting and must be resumed",
						);
				}
				if (!state.current || state.current.id !== operationId) {
					const accepted = await this.lane.accept(
						{ kind: "prompt", operationId, prompt: body },
						ctx,
					);
					if (!accepted.ok) throw accepted.error;
				}
				await this.revokeStoppedGoal(operationId);
                const driven = await this.lane.drive(
					{ operationId, waitForRetry: true, pollDeferred: true },
					ctx,
				);
				if (!driven.ok) throw driven.error;
				if (driven.value.kind !== "settled")
					throw new Error("Durable operation is waiting and must be resumed");
				result = driven.value.outcome;
			}
			if (result.status === "failed" || result.status === "aborted") {
                return { text: publicError(undefined), steered: false };
            }
			const entry = result.tipId
				? await this.store.getEntry(result.tipId, ctx)
				: undefined;
			return {
				text:
					entry?.type === "message" && entry.message.role === "assistant"
						? entry.message.stopReason === "error" ||
							entry.message.stopReason === "aborted"
							? publicError(undefined)
							: textOf(entry.message.content)
						: "",
				steered: false,
			};
		} catch(error) {
            this.goal?.fault(operationId);
            this.log("IRC: durable diagnostic in "+this.channel+": "+durableDiagnostic(error));
            throw error;
		} finally {
			this.#depth--;
		}
	}
	async prompt(body: string, relay?: RelayEvents) {
		const stop = relay ? this.watch(relay) : () => {};
		try {
			return await this.promptDurable(randomUUID(), body);
		} finally {
			stop();
		}
	}
	async completedReply(
		operationId: string,
	): Promise<{ text: string; entryId?: string }> {
		const result = await this.lane.getResult(operationId, ctx);
		if (result?.status === "failed" || result?.status === "aborted")
			return { text: publicError(undefined) };
		const entry = result?.tipId
			? await this.store.getEntry(result.tipId, ctx)
			: undefined;
		return entry?.type === "message" && entry.message.role === "assistant"
			? { text: textOf(entry.message.content), entryId: entry.id }
			: { text: "" };
	}
	async recover(): Promise<void> {
		const state = await this.lane.inspectExecution(ctx);
		if (state.current) {
            if (state.current.id.startsWith("goal/")) throw new PublicError("legacyGoalsMigration");
			this.goal?.admit(state.current.id);
			await this.revokeStoppedGoal(state.current.id);
			const result = await this.lane.drive(
				{
					operationId: state.current.id,
					waitForRetry: true,
					pollDeferred: true,
				},
				ctx,
			);
			if (!result.ok) throw result.error;
		}
	}
 /** Atomically targets one operation; a settled/stale target never aborts its successor. */
 async abortDurable(operationId:string):Promise<void> {
  const result=await this.lane.requestAbort(operationId,ctx);
  if(!result.ok&&result.error._tag!=="OperationMismatch")throw result.error;
 }
	async abort(): Promise<void> {
		const result = await this.lane.abort(ctx);
		if (!result.ok) throw result.error;
	}
	async suspend(): Promise<void> {
		await this.harness.close(ctx);
	}
	async close(): Promise<void> {
		try {
			await this.harness.close(ctx);
		} finally {
			try {
				await this.store.close(ctx);
			} finally {
				await this.repo.close(ctx);
			}
		}
	}
	availableThinkingLevels(): ThinkingLevel[] {
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}
	thinkingLevel(): ThinkingLevel {
		return this.thinking;
	}
	modelLabel(): string {
		return `${this.model.provider}/${this.model.id}`;
	}
	async setModel(model: Model<Api>): Promise<void> {
		await this.lane.setModel(
			{ provider: model.provider, modelId: model.id },
			ctx,
		);
		this.model = model;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.lane.setThinkingLevel(level, ctx);
		this.thinking = await this.lane.getThinkingLevel(ctx);
	}
	async cycleThinkingLevel(): Promise<ThinkingLevel> {
		const levels = this.availableThinkingLevels();
		await this.setThinkingLevel(
			levels[(levels.indexOf(this.thinking) + 1) % levels.length],
		);
		return this.thinking;
	}
	async compact(instructions: string | null): Promise<void> {
        if(this.busy)throw new PublicError("sessionBusy");
		const result = await this.lane.compact(
			{ customInstructions: instructions ?? undefined },
			ctx,
		);
		if (!result.ok) throw result.error;
	}
	async reload(): Promise<void> {
		throw new PublicError("durableReload");
	}
}
